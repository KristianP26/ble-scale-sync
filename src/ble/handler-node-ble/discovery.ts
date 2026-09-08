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
import { helperOf, getDbusNext, releaseDeviceProxy, type Adapter, type Device } from './dbus.js';
import { logAdvertisementSnapshot } from './device-object.js';
import {
  getAdapter,
  resetConnection,
  parseHciIndex,
  currentConnectionGeneration,
} from './connection.js';
import { safeName } from '../advertisement.js';

/**
 * Which adapters have a scan running that WE started with the duplicate filter
 * in place, and on which D-Bus connection.
 *
 * Keyed by the adapter rather than held as one module-level flag, because more
 * than one adapter object can be live at a time: `scanDevices()` builds a
 * throwaway bus with its own adapter alongside the persistent one, and a single
 * flag would let one stamp the other's state. The stored value is the
 * connection generation, because a reset replaces the BlueZ client and whatever
 * the old one asked for no longer applies (#372, #397).
 */
const filteredScans = new WeakMap<Adapter, number>();

/** True when this adapter's running scan is ours and already carries the filter. */
function runningScanIsFiltered(btAdapter: Adapter): boolean {
  const generation = filteredScans.get(btAdapter);
  return generation !== undefined && generation === currentConnectionGeneration();
}

/**
 * Forget the filtered-scan claim for an adapter whose discovery has been
 * stopped somewhere other than `stopDiscoveryAndQuiesce`.
 *
 * The invariant this protects is "a claim exists only while our filtered scan
 * is actually running". A stale claim is the one state that would silently keep
 * a deduplicating scan alive, because the restart branch would decline to cycle
 * it (#372, #397).
 */
export function notifyDiscoveryStopped(btAdapter: Adapter): void {
  filteredScans.delete(btAdapter);
}

/** Stop discovery and wait for the post-discovery quiesce period. */
export async function stopDiscoveryAndQuiesce(btAdapter: Adapter): Promise<void> {
  try {
    bleLog.debug('Stopping discovery before connect...');
    await btAdapter.stopDiscovery();
    bleLog.debug('Discovery stopped');
  } catch {
    bleLog.debug('stopDiscovery failed (may already be stopped)');
  }
  notifyDiscoveryStopped(btAdapter);
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
async function requestDuplicateAdvertisements(btAdapter: Adapter): Promise<boolean> {
  try {
    const { Variant } = await getDbusNext();
    await helperOf(btAdapter).callMethod('SetDiscoveryFilter', {
      Transport: new Variant('s', 'le'),
      DuplicateData: new Variant('b', true),
    });
    bleLog.debug('Discovery filter: Transport=le, DuplicateData=true');
    return true;
  } catch (err: unknown) {
    bleLog.debug(`SetDiscoveryFilter: ${errMsg(err)} (non-fatal, scan continues deduplicated)`);
    return false;
  }
}

/**
 * Set our filter and start the scan, WITHOUT going through node-ble.
 *
 * node-ble's own `Adapter.startDiscovery()` is
 *
 *     await this.helper.callMethod('SetDiscoveryFilter', { Transport: 'le' })
 *     await this.helper.callMethod('StartDiscovery')
 *
 * and BlueZ's SetDiscoveryFilter REPLACES the caller's whole filter dict rather
 * than merging into it, so every key we had just set reverts to its default and
 * `DuplicateData` goes back to false. Calling it and then calling node-ble's
 * startDiscovery, which is what shipped for #372, therefore does nothing at all:
 * the filter that reaches BlueZ is always node-ble's Transport-only one. The
 * scan keeps deduplicating, the 500 ms broadcast poll keeps re-reading one
 * cached advertisement, and the symptom #372 was meant to fix survives the fix.
 *
 * So the two calls are made here in the order that actually works.
 *
 * Returns whether the filter itself was accepted, which is what decides if the
 * running scan may be treated as already filtered.
 */
async function applyFilterAndStart(btAdapter: Adapter): Promise<boolean> {
  const filtered = await requestDuplicateAdvertisements(btAdapter);
  await helperOf(btAdapter).callMethod('StartDiscovery');
  return filtered;
}

/**
 * `applyFilterAndStart` behind node-ble's own already-running guard, kept so a
 * scan that is already up is detected locally rather than by asking BlueZ and
 * reading its refusal.
 *
 * The recovery paths below deliberately use the UNGUARDED form: each has just
 * stopped discovery or reset the adapter, and re-reading `Discovering` there
 * would only reintroduce a race on a property BlueZ updates asynchronously.
 * The behaviour that changes with it is narrow and deliberate: BlueZ refuses a
 * second StartDiscovery per sender, not per adapter, so where a DIFFERENT
 * client holds a session the recovery step now succeeds instead of escalating
 * to the power cycle. That is the correct outcome (a scan really is running and
 * it is now ours as well); the zombie case those steps exist for is caught
 * earlier, by the isDiscovering branch above.
 */
async function startFilteredDiscovery(btAdapter: Adapter): Promise<boolean> {
  if (await btAdapter.isDiscovering()) {
    throw new Error('Discovery already in progress');
  }
  return applyFilterAndStart(btAdapter);
}

/**
 * Try to start BlueZ discovery with escalating recovery strategies.
 * Returns the (possibly refreshed) adapter on success, or false if all attempts failed.
 */
export async function startDiscoverySafe(
  btAdapter: Adapter,
  bleAdapter?: string,
): Promise<Adapter | false> {
  // Read once: every latch write below records the connection this scan
  // belongs to, and a reset mid-function would otherwise stamp the wrong one.
  const generation = currentConnectionGeneration();

  // 1. Normal start
  try {
    const filtered = await startFilteredDiscovery(btAdapter);
    bleLog.debug('Discovery started');
    if (filtered) filteredScans.set(btAdapter, generation);
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
    // Only ONCE per connection. The running scan being ours and already
    // filtered is the normal state of every cycle after the first, and cycling
    // it again each time would be actively harmful: StopDiscovery makes BlueZ
    // drop its Device1 objects (#297), throwing away everything it learned
    // while we were between cycles, and the quiesce that follows is a window
    // with the radio not scanning at all. A reporter with a scale that
    // advertises in short bursts saw exactly that, nine cycles in a row (#397).
    if (runningScanIsFiltered(btAdapter)) {
      bleLog.debug('Discovery already active and already filtered; continuing with it');
      return btAdapter;
    }
    bleLog.debug('Discovery already active; restarting it so the duplicate filter applies');
    try {
      await helperOf(btAdapter).callMethod('StopDiscovery');
      await sleep(POST_DISCOVERY_QUIESCE_MS);
      const refiltered = await applyFilterAndStart(btAdapter);
      bleLog.debug('Discovery restarted with the duplicate filter');
      if (refiltered) filteredScans.set(btAdapter, generation);
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
    if (await applyFilterAndStart(btAdapter)) filteredScans.set(btAdapter, generation);
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

    if (await applyFilterAndStart(btAdapter)) filteredScans.set(btAdapter, generation);
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
      // A reset replaced the connection, so read the generation again.
      if (await applyFilterAndStart(freshAdapter)) {
        filteredScans.set(freshAdapter, currentConnectionGeneration());
      }
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
      // A reset replaced the connection, so read the generation again.
      if (await applyFilterAndStart(freshAdapter)) {
        filteredScans.set(freshAdapter, currentConnectionGeneration());
      }
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
      // A reset replaced the connection, so read the generation again.
      if (await applyFilterAndStart(freshAdapter)) {
        filteredScans.set(freshAdapter, currentConnectionGeneration());
      }
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
  let probe: Device | undefined;
  try {
    probe = await btAdapter.getDevice(formatted);
    // node-ble types isPaired() loosely; BusHelper.prop unwraps the Variant to a
    // real boolean at runtime, so cast through unknown like ensureBonded does.
    paired = ((await probe.isPaired()) as unknown as boolean) === true;
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
  } finally {
    // The proxy exists only to read isPaired(); the removal below goes through
    // the adapter. Holding it would leak a match rule per cycle (#396, #397).
    if (probe) releaseDeviceProxy(probe);
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

      // Every device BlueZ knows gets a throwaway proxy here, and each one costs
      // a D-Bus match rule plus a listener on the bus-wide signal emitter until
      // it is released. Only the matched device survives the loop, so every
      // other proxy is handed back before the next iteration (#396, #397).
      let dev: Device | undefined;
      let matchedDevice = false;
      try {
        dev = await btAdapter.getDevice(addr);
        const name = await dev.getName().catch(() => '');
        if (!name) continue;

        bleLog.debug(`Discovered: ${safeName(name)} [${addr}]`);

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
          bleLog.info(`Auto-discovered: ${matched.name} (${safeName(name)} [${addr}])`);
          matchedDevice = true;
          return { device: dev, adapter: matched, mac: addr };
        }
      } catch {
        /* device may have gone away */
      } finally {
        if (dev && !matchedDevice) releaseDeviceProxy(dev);
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
