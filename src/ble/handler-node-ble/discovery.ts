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
 * Ask BlueZ to report every advertisement, not just the first one per device.
 *
 * MUST run BEFORE `StartDiscovery`. BlueZ applies the filter to the scan it
 * starts, and its own documentation says so: "SetDiscoveryFilter can be called
 * before StartDiscovery. It is useful when client will create first discovery
 * session, to ensure that proper scan will be started right after call to
 * StartDiscovery." `DuplicateData` is what makes it emit PropertiesChanged for
 * ManufacturerData and ServiceData on every packet rather than only when the
 * value first appears.
 *
 * Setting it afterwards, which is what the broadcast path used to do, leaves
 * the running scan deduplicating. A broadcast scale then looks frozen: BlueZ
 * keeps handing back the first advertisement it cached, the 500 ms poll re-reads
 * that same value forever, and the app reports one settling weight that never
 * changes while the vendor app shows the scale counting up (#372).
 *
 * Failure is non-fatal. A filter BlueZ rejects should not stop a scan that
 * would otherwise work; the caller falls back to polling as before.
 */
async function requestDuplicateAdvertisements(btAdapter: Adapter): Promise<void> {
  try {
    const { Variant } = await getDbusNext();
    await helperOf(btAdapter).callMethod('SetDiscoveryFilter', {
      Transport: new Variant('s', 'le'),
      DuplicateData: new Variant('b', true),
    });
    bleLog.debug('Discovery filter: Transport=le, DuplicateData=true');
  } catch (err: unknown) {
    bleLog.debug(`SetDiscoveryFilter: ${errMsg(err)} (non-fatal, scan continues deduplicated)`);
  }
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
    await requestDuplicateAdvertisements(btAdapter);
    await btAdapter.startDiscovery();
    bleLog.debug('Discovery started');
    return btAdapter;
  } catch (e) {
    bleLog.debug(`startDiscovery failed: ${errMsg(e)}`);
  }

  // Already running (same client's previous session still active). Continuing
  // is right, but the session it is continuing was started by an earlier cycle
  // and BlueZ applied whatever filter was in force then. A restart-driven
  // continuous run therefore inherits a deduplicating scan for the rest of the
  // process lifetime, which is how #372 stayed frozen across cycles rather than
  // only on the first one. Cycle the session once so the filter above takes.
  //
  // Safe here specifically because no device has been found yet: StopDiscovery
  // makes BlueZ drop Device1 objects (#297), and the whole point of doing it at
  // this moment is that there is nothing yet to lose.
  if (await btAdapter.isDiscovering()) {
    bleLog.debug('Discovery already active; restarting it so the duplicate filter applies');
    try {
      await helperOf(btAdapter).callMethod('StopDiscovery');
      await sleep(POST_DISCOVERY_QUIESCE_MS);
      await requestDuplicateAdvertisements(btAdapter);
      await btAdapter.startDiscovery();
      bleLog.debug('Discovery restarted with the duplicate filter');
      return btAdapter;
    } catch (e) {
      // Could not cycle it. A deduplicating scan still finds devices and still
      // reads a connectable scale, so continuing beats failing the cycle.
      bleLog.debug(`Could not restart discovery (${errMsg(e)}); continuing with the existing scan`);
      return btAdapter;
    }
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

/**
 * Remove a device from BlueZ D-Bus cache to force a fresh proxy on re-discovery.
 *
 * `includeBonded` also deletes the stored pairing keys, which is destructive and
 * is only ever passed by the stale-bond recovery in connect.ts, behind
 * `ble.auto_clear_stale_bond` (#335).
 */
export async function removeDevice(
  btAdapter: Adapter,
  mac: string,
  opts: { includeBonded?: boolean } = {},
): Promise<void> {
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
  if (paired && !opts.includeBonded) {
    bleLog.debug('Skipping RemoveDevice: device is bonded (preserving pairing keys)');
    return;
  }
  if (paired) {
    bleLog.warn(`Removing the bond for ${formatted} along with the BlueZ device object.`);
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
          address: formatMac(addr),
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
