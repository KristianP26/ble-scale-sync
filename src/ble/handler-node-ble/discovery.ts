import type { ScaleAdapter, BleDeviceInfo } from '../../interfaces/scale-adapter.js';
import { resolveAdapter } from '../../scales/resolve.js';
import {
  bleLog,
  formatMac,
  sleep,
  errMsg,
  resetAdapterBtmgmt,
  resetAdapterRfkill,
  restartBluetoothd,
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_POLL_MS,
  POST_DISCOVERY_QUIESCE_MS,
} from '../types.js';
import { helperOf, getDbusNext, type Adapter, type Device } from './dbus.js';
import { logAdvertisementSnapshot } from './device-object.js';
import { getAdapter, resetConnection, parseHciIndex } from './connection.js';

/** Stop discovery and wait for the post-discovery quiesce period. */
export async function stopDiscoveryAndQuiesce(btAdapter: Adapter): Promise<void> {
  try {
    bleLog.debug('Stopping discovery before connect...');
    await btAdapter.stopDiscovery();
    bleLog.debug('Discovery stopped');
  } catch {
    bleLog.debug('stopDiscovery failed (may already be stopped)');
  }
  await sleep(POST_DISCOVERY_QUIESCE_MS);
}

/**
 * Try to start BlueZ discovery with escalating recovery strategies.
 * Returns the (possibly refreshed) adapter on success, or false if all attempts failed.
 */
export async function startDiscoverySafe(
  btAdapter: Adapter,
  bleAdapter?: string,
): Promise<Adapter | false> {
  // 1. Normal start
  try {
    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started');
    return btAdapter;
  } catch (e) {
    bleLog.debug(`startDiscovery failed: ${errMsg(e)}`);
  }

  // Already running (same client's previous session still active)
  if (await btAdapter.isDiscovering()) {
    bleLog.debug('Discovery already active, continuing');
    return btAdapter;
  }

  // 2. Force-stop via D-Bus (bypass node-ble's isDiscovering guard) + retry
  bleLog.debug('Attempting D-Bus StopDiscovery to reset stale state...');
  try {
    await helperOf(btAdapter).callMethod('StopDiscovery');
    bleLog.debug('D-Bus StopDiscovery succeeded');
  } catch (e) {
    bleLog.debug(`D-Bus StopDiscovery failed: ${errMsg(e)}`);
  }
  await sleep(1000);

  try {
    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started after D-Bus reset');
    return btAdapter;
  } catch (e) {
    bleLog.debug(`startDiscovery after D-Bus reset failed: ${errMsg(e)}`);
  }

  // 3. Power-cycle the adapter + retry
  bleLog.debug('Attempting adapter power cycle...');
  try {
    const helper = helperOf(btAdapter);
    const { Variant } = await getDbusNext();
    await helper.set('Powered', new Variant('b', false));
    bleLog.debug('Adapter powered off');
    await sleep(1000);
    await helper.set('Powered', new Variant('b', true));
    bleLog.debug('Adapter powered on');
    await sleep(1000);

    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started after power cycle');
    return btAdapter;
  } catch (e) {
    bleLog.debug(`Power cycle / startDiscovery failed: ${errMsg(e)}`);
  }

  // 4. Kernel-level adapter reset via btmgmt + fresh D-Bus connection
  bleLog.debug('Attempting kernel-level adapter reset via btmgmt...');
  if (await resetAdapterBtmgmt(parseHciIndex(bleAdapter))) {
    resetConnection();
    try {
      const freshAdapter = await getAdapter(bleAdapter);
      await freshAdapter.startDiscovery();
      bleLog.debug('Discovery started after btmgmt reset');
      return freshAdapter;
    } catch (e) {
      bleLog.debug(`startDiscovery after btmgmt reset failed: ${errMsg(e)}`);
    }
  }

  // 5. RF-level reset via rfkill (more thorough than btmgmt)
  bleLog.debug('Attempting rfkill block/unblock...');
  if (await resetAdapterRfkill()) {
    resetConnection();
    try {
      const freshAdapter = await getAdapter(bleAdapter);
      await freshAdapter.startDiscovery();
      bleLog.debug('Discovery started after rfkill reset');
      return freshAdapter;
    } catch (e) {
      bleLog.debug(`startDiscovery after rfkill reset failed: ${errMsg(e)}`);
    }
  }

  // 6. Restart bluetoothd service (clears all D-Bus session state)
  bleLog.debug('Attempting bluetoothd service restart...');
  if (await restartBluetoothd()) {
    resetConnection();
    try {
      const freshAdapter = await getAdapter(bleAdapter);
      await freshAdapter.startDiscovery();
      bleLog.debug('Discovery started after bluetoothd restart');
      return freshAdapter;
    } catch (e) {
      bleLog.debug(`startDiscovery after bluetoothd restart failed: ${errMsg(e)}`);
    }
  }

  // All strategies failed
  bleLog.warn(
    'Could not start active discovery. ' +
      'Proceeding with passive scanning (device may take longer to appear).',
  );
  return false;
}

/** Remove a device from BlueZ D-Bus cache to force a fresh proxy on re-discovery. */
export async function removeDevice(btAdapter: Adapter, mac: string): Promise<void> {
  const formatted = formatMac(mac);

  // Never remove a bonded device: BlueZ RemoveDevice deletes the stored pairing
  // keys (LTK), which desyncs the host bond from the scale's retained bond and
  // makes the next run's re-pair time out (#168 Beurer BF720). Only unpaired
  // devices need the fresh-proxy reset (#80/#81); bonded scales keep their bond
  // so the next connect re-encrypts with the stored LTK instead of pairing.
  let paired: boolean;
  try {
    const device = await btAdapter.getDevice(formatted);
    // node-ble types isPaired() loosely; BusHelper.prop unwraps the Variant to a
    // real boolean at runtime, so cast through unknown like ensureBonded does.
    paired = ((await device.isPaired()) as unknown as boolean) === true;
  } catch (err) {
    // 'Device not found' => not in the BlueZ cache, so there is no bond to
    // preserve and removal is a harmless no-op; proceed. Any OTHER error is a
    // transient D-Bus failure on a device that may well be bonded, so fail safe
    // and skip removal rather than risk wiping a real bond.
    if (!errMsg(err).includes('Device not found')) {
      bleLog.debug(`Skipping RemoveDevice: bond state unknown (${errMsg(err)})`);
      return;
    }
    // Worth a line: an absent node here means BlueZ already dropped the peer's
    // object, which is the signature of #297.
    bleLog.debug('Device not in BlueZ cache; RemoveDevice is a no-op');
    paired = false;
  }
  if (paired) {
    bleLog.debug('Skipping RemoveDevice: device is bonded (preserving pairing keys)');
    return;
  }

  try {
    const devSerialized = `dev_${formatted.replace(/:/g, '_')}`;
    const adapterHelper = helperOf(btAdapter);
    await adapterHelper.callMethod('RemoveDevice', `${adapterHelper.object}/${devSerialized}`);
    bleLog.debug('Removed device from BlueZ cache');
  } catch {
    // Device wasn't in cache
  }
}

export async function autoDiscover(
  btAdapter: Adapter,
  adapters: ScaleAdapter[],
  abortSignal?: AbortSignal,
): Promise<{ device: Device; adapter: ScaleAdapter; mac: string }> {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  const checked = new Set<string>();
  let heartbeat = 0;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    const addresses: string[] = await btAdapter.devices();

    for (const addr of addresses) {
      if (checked.has(addr)) continue;
      checked.add(addr);

      try {
        const dev = await btAdapter.getDevice(addr);
        const name = await dev.getName().catch(() => '');
        if (!name) continue;

        bleLog.debug(`Discovered: ${name} [${addr}]`);

        // Match on the name plus whatever the advertisement exposes. BlueZ does
        // not publish advertised service UUIDs before a connection, so an
        // adapter that matches only on serviceUuids still needs `ble.scale_mac`,
        // but ManufacturerData and ServiceData ARE exposed and are what
        // identifies a broadcast-only scale whose name says nothing: the
        // Silvergear 108 advertises itself as "108" (#297).
        //
        // The loop above skips a device with no name at all, so a genuinely
        // nameless broadcast peer is still only reachable through `ble.scale_mac`.
        const advert = await logAdvertisementSnapshot(dev).catch(() => undefined);
        const info: BleDeviceInfo = {
          localName: name,
          serviceUuids: [],
          ...(advert?.manufacturerData ? { manufacturerData: advert.manufacturerData } : {}),
          ...(advert?.serviceData && advert.serviceData.length > 0
            ? { serviceData: advert.serviceData }
            : {}),
        };
        const matched = resolveAdapter(info, adapters);
        if (matched) {
          bleLog.info(`Auto-discovered: ${matched.name} (${name} [${addr}])`);
          return { device: dev, adapter: matched, mac: addr };
        }
      } catch {
        /* device may have gone away */
      }
    }

    heartbeat++;
    if (heartbeat % 5 === 0) {
      bleLog.info('Still scanning...');
    }
    await sleep(DISCOVERY_POLL_MS);
  }

  throw new Error(`No recognized scale found within ${DISCOVERY_TIMEOUT_MS / 1000}s`);
}
