/**
 * The stages of `scanAndReadRaw`, lifted out of the 428-line procedure they
 * used to be inlined in (#368).
 *
 * Every workaround comment moved with the code it explains, and the ORDER the
 * caller invokes these in is load bearing: the advertisement snapshot has to
 * happen before StopDiscovery, and StopDiscovery before connect. That order is
 * pinned by `tests/ble/handler-node-ble/scan-order.test.ts`, which is what
 * makes this split checkable at all.
 *
 * None of these writes a variable belonging to the caller. Where a stage used
 * to assign an outer local it returns the value instead, which is the whole
 * reason they are separable.
 */

import type { BleDeviceInfo, ScaleAdapter } from '../../interfaces/scale-adapter.js';
import type { BleChar } from '../shared.js';
import { resolveAdapter, resolveAfterDiscovery } from '../../scales/resolve.js';
import {
  bleLog,
  errMsg,
  formatMac,
  normalizeUuid,
  sleep,
  withTimeout,
  DISCOVERY_TIMEOUT_MS,
  GATT_DISCOVERY_TIMEOUT_MS,
  CHAR_DISCOVERY_MAX_RETRIES,
  CHAR_DISCOVERY_RETRY_DELAY_MS,
  resetAdapterBtmgmt,
} from '../types.js';
import NodeBle from 'node-ble';
import { isDebugEnabled } from '../../logger.js';
import { helperOf, releaseDeviceProxy, type Adapter, type Device } from './dbus.js';
import {
  getAdapter,
  resetConnection,
  isStaleConnectionError,
  isDbusConnectionError,
  dbusError,
  parseHciIndex,
} from './connection.js';
import { removeDevice, notifyDiscoveryStopped } from './discovery.js';
import { logAdvertisementSnapshot, type AdvertisementSnapshot } from './device-object.js';
import { buildCharMap } from './gatt.js';
import {
  waitForRawReading,
  withAbandonmentCleanup,
  type BleDevice,
  type RawReading,
} from '../shared.js';
import type { WeightUnit } from '../../config/schema.js';
import type { ScaleAuth, ScaleReading, UserProfile } from '../../interfaces/scale-adapter.js';
import {
  RAW_READING_TIMEOUT_MS,
  READING_SESSION_CAP_FACTOR,
  untilAborted,
  withIdleTimeout,
} from '../types.js';
import { tagBleFailure, bleFailureKind } from '../failure-kind.js';
import { probeLiveness, makeLivenessAdapter } from './liveness.js';
import { withScanActivityWatchdog, SCAN_HEARD_FRESH_MS, type ScanWatch } from './scan-watchdog.js';
import { safeName } from '../advertisement.js';

/**
 * Acquire the BlueZ adapter, resetting a stale D-Bus connection once.
 *
 * Deliberately does NOT include the isPowered check that follows it at the call
 * site. `probeAdapter` is assigned between the two, and the #213 failure
 * classification reads it: folding the check in here would leave `probeAdapter`
 * unset when an unpowered adapter throws, turning an idle cycle into a
 * wedge-suspect that counts toward the watchdog.
 */
export async function acquireBluezAdapter(bleAdapter: string | undefined): Promise<Adapter> {
  try {
    return await getAdapter(bleAdapter);
  } catch (err) {
    if (isDbusConnectionError(err)) throw dbusError();
    // Stale connection (e.g. bluetoothd restarted): reset and retry once
    if (isStaleConnectionError(err)) {
      bleLog.debug('D-Bus connection stale, resetting...');
      resetConnection();
      return await getAdapter(bleAdapter);
    } else if (bleAdapter) {
      throw new Error(
        `Bluetooth adapter '${bleAdapter}' not found. ` +
          'Check that the adapter exists (hciconfig or btmgmt info).',
      );
    } else {
      throw err;
    }
  }
}

/** How often the MAC-targeted wait reports what BlueZ can currently see. */
const SCAN_VISIBILITY_LOG_MS = 30_000;

/**
 * While waiting for one configured MAC, periodically log what BlueZ can see.
 *
 * `waitDevice` is silent by design: it polls for one address and says nothing
 * about the rest of the room. So a `not found within 120s` log cannot tell
 * "the scale never advertised" apart from "the scan is dead" or "we are waiting
 * on the wrong address", and a reporter's log showing nothing but repeated
 * `Scanning for device...` was unanswerable for exactly that reason (#397).
 * Debug only. The check is per tick rather than once at the start, so toggling
 * `runtime.debug` through a live config reload takes effect on the wait already
 * in flight, and so the enumeration itself never runs for anyone who has debug
 * off. The timer is unref'd: a shutdown arriving mid-wait should not be held up
 * by a diagnostic.
 */
function startScanVisibilityLog(btAdapter: Adapter, mac: string): () => void {
  const timer = setInterval(() => {
    if (!isDebugEnabled()) return;
    void (async () => {
      try {
        const addrs: string[] = await btAdapter.devices();
        const seen = addrs.some((a) => formatMac(a) === mac);
        bleLog.debug(
          `Still waiting for ${mac}; BlueZ currently lists ${addrs.length} device(s)` +
            `${seen ? ' (including the target)' : ''}: ${addrs.join(', ') || 'none'}`,
        );
      } catch (err) {
        bleLog.debug(`Could not enumerate BlueZ devices while waiting: ${errMsg(err)}`);
      }
    })();
  }, SCAN_VISIBILITY_LOG_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Wait for the target device to show up in discovery.
 *
 * The abort listener is added and removed on every path rather than left
 * attached: continuous mode reuses one signal for every cycle, so a listener
 * per cycle produces MaxListenersExceededWarning and then leaks for the life of
 * the process.
 *
 * The scan activity watchdog runs alongside the wait and restarts a discovery
 * that went deaf mid-wait (scan-watchdog.ts); the wait itself is unchanged.
 * What it did is collected in `scanWatch`.
 */
export async function waitForTargetDevice(
  btAdapter: Adapter,
  mac: string,
  abortSignal?: AbortSignal,
  scanWatch?: ScanWatch,
): Promise<Device> {
  if (abortSignal?.aborted) {
    throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  const stopVisibilityLog = startScanVisibilityLog(btAdapter, mac);
  try {
    return await withScanActivityWatchdog(
      btAdapter,
      abortSignal,
      () => awaitTargetDevice(btAdapter, mac, abortSignal),
      scanWatch,
    );
  } finally {
    stopVisibilityLog();
  }
}

async function awaitTargetDevice(
  btAdapter: Adapter,
  mac: string,
  abortSignal?: AbortSignal,
): Promise<Device> {
  const waitPromise = withTimeout(
    btAdapter.waitDevice(mac),
    DISCOVERY_TIMEOUT_MS,
    `Device ${mac} not found within ${DISCOVERY_TIMEOUT_MS / 1000}s`,
  );

  if (abortSignal) {
    // Wrap in a promise that cleans up the abort listener in all paths
    // to prevent MaxListenersExceededWarning in continuous mode
    const sig = abortSignal;
    return await new Promise<Device>((resolve, reject) => {
      const onAbort = () => {
        reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      sig.addEventListener('abort', onAbort, { once: true });
      waitPromise.then(
        (d) => {
          sig.removeEventListener('abort', onAbort);
          resolve(d);
        },
        (err) => {
          sig.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  } else {
    return await waitPromise;
  }
}

/**
 * Everything that has to be read off the Device1 object BEFORE discovery stops.
 *
 * Returns three things rather than just the adapter, and that is the point:
 * `advert` is spread into the POST-connect match as well, and dropping it there
 * is exactly the #280 / #318 regression where a dozen adapters that key on a
 * company id could never match on Linux.
 */
export async function resolvePreConnectAdapter(
  device: Device,
  mac: string,
  deviceMac: string,
  adapters: ScaleAdapter[],
): Promise<{
  name: string;
  advert: AdvertisementSnapshot;
  preMatchedAdapter: ScaleAdapter | undefined;
}> {
  const name = await device.getName().catch(() => '');
  bleLog.debug(`Found device: ${safeName(name)} [${mac}]`);
  // Only chance to capture the advertisement: BlueZ drops it (and for some
  // peers the whole Device object) once discovery stops (#297).
  const advert = await logAdvertisementSnapshot(device);

  // Pre-connection adapter match. Needed for preferPassive adapters so we can
  // skip the GATT connect entirely and go straight to broadcast scanning.
  //
  // The snapshot above already reads ManufacturerData and ServiceData off the
  // Device1 object, so both are fed in here rather than thrown away. Matching
  // on the name alone could not reach a passive adapter whose device
  // advertises a generic name: the Silvergear 108 calls itself "108", which is
  // far too weak to claim on, while its manufacturer data identifies it
  // exactly (#297).
  //
  // Limitation that remains: serviceUuids is still empty pre-connect, because
  // BlueZ does not expose advertised service UUIDs through D-Bus before
  // connection, so an adapter matching only on serviceUuids still falls
  // through to the GATT path.
  //
  // Scope: the result takes the passive branch below, and it is ALSO passed
  // to acquireGattServer, which branches on `requiresBonding` to decide
  // whether to bond before connecting and to retry on a discovery timeout
  // (#290). Exactly one adapter in the registry sets that flag, so the whole
  // reach of the widening on the connect path is that a MAC-pinned nameless
  // Beurer advertising company id 0x0611 plus a SIG WSS/BCS service now
  // reaches the bond-on-timeout retry, where the pre-match used to be
  // undefined and the retry could never engage. That is the retry working as
  // designed. Otherwise a device matching a connect-based adapter here falls
  // through as before and is re-resolved after discovery.
  const preInfo: BleDeviceInfo = {
    localName: name,
    address: deviceMac ? formatMac(deviceMac) : undefined,
    serviceUuids: [],
    ...(advert.manufacturerData ? { manufacturerData: advert.manufacturerData } : {}),
    ...(advert.serviceData && advert.serviceData.length > 0
      ? { serviceData: advert.serviceData }
      : {}),
  };
  const preMatchedAdapter = resolveAdapter(preInfo, adapters);
  return { name, advert, preMatchedAdapter };
}

/**
 * node-ble's GattServer as it is at runtime. `init()` is public in the shipped
 * JavaScript (Device.gatt() calls it on a fresh server) but missing from the
 * bundled typings.
 */
type RefreshableGattServer = NodeBle.GattServer & { init?: () => Promise<void> };

/**
 * Enumerate the GATT tree into a char map, bounded by the discovery timeout.
 *
 * With `refresh`, the server's snapshot is rebuilt first. node-ble's
 * GattServer.init() snapshots the services and characteristics once, and
 * services(), getPrimaryService() and characteristics() only ever read that
 * snapshot back, so without it a retry re-reads the exact map that was found
 * incomplete and a characteristic BlueZ exported late (bluez/bluez#1489) can
 * never appear. init() is what Device.gatt() runs on a new server: it clears
 * the snapshot, waits for ServicesResolved, and walks the device's D-Bus
 * children with a fresh proxy object. It is safe here because every retry runs
 * before anything is subscribed, so no caller holds a characteristic from the
 * old snapshot that it still needs. Inside the same timeout, because the
 * ServicesResolved wait has no bound of its own if the link drops.
 */
async function enumerateCharMap(
  gatt: NodeBle.GattServer,
  refresh: boolean,
): Promise<Map<string, BleChar>> {
  return withTimeout(
    (async () => {
      const init = (gatt as RefreshableGattServer).init;
      if (refresh && typeof init === 'function') await init.call(gatt);
      return buildCharMap(gatt);
    })(),
    GATT_DISCOVERY_TIMEOUT_MS,
    'GATT service discovery timed out',
  );
}

/**
 * Resolve the adapter again once characteristics are known.
 *
 * Returns the adapter rather than assigning the caller's local, and throws when
 * nothing claims the device. The char map it builds here is deliberately
 * discarded: the reading uses a fresh one built after the second
 * acquireGattServer, whose adapter may differ.
 *
 * The pick goes through resolveAfterDiscovery, so the GATT services found here
 * cannot overturn what the device's name already identified (a Digoo taken by
 * Inlife, a Hoffen by MGB). BlueZ gives no advertised service UUIDs before
 * connect on this path, hence `advertisedServicesKnown: false`.
 *
 * A retry rebuilds the GATT snapshot first (enumerateCharMap); without that it
 * would re-read the same snapshot and could never see a late export
 * (bluez/bluez#1489).
 */
export async function resolveAfterConnect(
  gatt: NodeBle.GattServer,
  adapters: ScaleAdapter[],
  name: string,
  deviceMac: string,
  advert: AdvertisementSnapshot,
): Promise<ScaleAdapter> {
  let serviceUuids = await gatt.services();
  bleLog.debug(`Services: [${serviceUuids.join(', ')}]`);

  // The same record resolvePreConnectAdapter matched on. Manufacturer and
  // service data were captured before StopDiscovery, because BlueZ drops the
  // advertisement with the discovery session. Without them a dozen adapters
  // that key on a company id (the Lefu OEM fingerprint, the Xiaomi and Beurer
  // company ids) could never match on Linux, and the device fell through to
  // whichever adapter claimed the bare vendor service (#280, #318).
  const advertised: BleDeviceInfo = {
    localName: name,
    address: deviceMac ? formatMac(deviceMac) : undefined,
    serviceUuids: [],
    ...advert,
  };

  let resolved: ScaleAdapter | undefined;
  let matchCharMap = await enumerateCharMap(gatt, false);
  for (let attempt = 1; attempt <= CHAR_DISCOVERY_MAX_RETRIES; attempt++) {
    resolved = resolveAfterDiscovery(
      advertised,
      {
        serviceUuids: serviceUuids.map(normalizeUuid),
        characteristicUuids: [...matchCharMap.keys()],
        advertisedServicesKnown: false,
      },
      adapters,
    );
    if (resolved || attempt === CHAR_DISCOVERY_MAX_RETRIES) break;
    await sleep(CHAR_DISCOVERY_RETRY_DELAY_MS);
    matchCharMap = await enumerateCharMap(gatt, true);
    serviceUuids = await gatt.services();
  }
  if (!resolved) {
    throw new Error(
      `Device found (${safeName(name)}) but no adapter recognized it. ` +
        `Services: [${serviceUuids.join(', ')}]. ` +
        `Adapters: ${adapters.map((a) => a.name).join(', ')}`,
    );
  }
  return resolved;
}

/**
 * Build the characteristic map, retrying while the adapter's chars are missing.
 * Each retry rebuilds node-ble's GATT snapshot first (see enumerateCharMap).
 */
export async function buildCharMapWithRetry(
  gatt: NodeBle.GattServer,
  findMissing: (map: Map<string, BleChar>) => string[],
): Promise<Map<string, BleChar>> {
  let charMap = await enumerateCharMap(gatt, false);
  // Retry budget: MAX iterations total. Iterations 1..MAX-1 actually rebuild
  // the char map; the MAX-th iteration only logs the give-up warn and breaks,
  // so the user-facing retry counter is `attempt/(MAX-1)`.
  for (let attempt = 1; attempt <= CHAR_DISCOVERY_MAX_RETRIES; attempt++) {
    const missing = findMissing(charMap);
    if (missing.length === 0) break;
    if (attempt === CHAR_DISCOVERY_MAX_RETRIES) {
      bleLog.warn(
        `GATT enumeration incomplete after ${attempt} attempt(s). ` +
          `Missing: [${missing.join(', ')}]. Discovered: [${[...charMap.keys()].join(', ')}]`,
      );
      break;
    }
    bleLog.debug(
      `GATT enumeration missing [${missing.join(', ')}], retry ${attempt}/${CHAR_DISCOVERY_MAX_RETRIES - 1} in ${CHAR_DISCOVERY_RETRY_DELAY_MS}ms...`,
    );
    await new Promise<void>((r) => setTimeout(r, CHAR_DISCOVERY_RETRY_DELAY_MS));
    charMap = await enumerateCharMap(gatt, true);
  }
  return charMap;
}

/** Whether the one-time info line for a disabled power-cycle was printed (#417). */
let preemptiveSkipAnnounced = false;

/** Test hook: forget that the info line was printed. */
export function _resetPreemptiveSkipNotice(): void {
  preemptiveSkipAnnounced = false;
}

/** Post-session cleanup. Everything here is best effort; nothing may throw out. */
export async function teardownSession(opts: {
  device: Device | null;
  btAdapter: Adapter | undefined;
  deviceMac: string;
  bleAdapter: string | undefined;
  gattAttempted: boolean;
  gattSucceeded: boolean;
  abortSignal?: AbortSignal;
  /**
   * `ble.preemptive_adapter_reset` (#417). Undefined means true: this function
   * owns the default, callers pass the option through unchanged.
   */
  preemptiveAdapterReset?: boolean;
  /**
   * True once a newer scan cycle has started (A-04). Everything below except
   * releasing our own proxy acts on state that cycle now uses: the device path,
   * the discovery session, the D-Bus connection and the controller.
   */
  isSuperseded?: () => boolean;
}): Promise<void> {
  const { device, btAdapter, deviceMac, bleAdapter, gattAttempted, gattSucceeded, abortSignal } =
    opts;
  const preemptiveAdapterReset = opts.preemptiveAdapterReset !== false;
  const superseded = (): boolean => opts.isSuperseded?.() === true;
  const standDown = (): void => {
    bleLog.debug(
      'An abandoned scan cycle ended after a newer one started; leaving BlueZ and the D-Bus connection to it',
    );
  };
  if (superseded()) {
    if (device) releaseDeviceProxy(device);
    standDown();
    return;
  }
  // Best-effort disconnect if we got partway through a connection
  if (device) {
    try {
      await device.disconnect();
    } catch {
      /* already disconnected or never connected */
    }
    // Hand the Device proxy back. On a GATT cycle the resetConnection() below
    // would drop it anyway, but an idle or broadcast cycle never resets, so
    // without this the same device path collects one more listener and one more
    // D-Bus match rule per cycle for the life of the process (#396, #397). The
    // session is over here, so nothing else can be holding it.
    releaseDeviceProxy(device);
  }

  // The disconnect above is a D-Bus call with no deadline. The poll loop aborts
  // a cycle it gives up on, so this teardown can start before the next cycle
  // exists and still be parked here when it does (A-04).
  if (superseded()) {
    standDown();
    return;
  }

  if (gattAttempted) {
    // Cleanup after a FAILED read (scale disconnected before completion,
    // GATT discovery timed out, etc.). BlueZ keeps the device proxy plus
    // any orphaned notification subscriptions cached, and the controller
    // level Discovering flag can desync from our client state
    // (bluez/bluez#807). Before the shared btmgmt power-cycle runs, mirror
    // what bleak-retry-connector does on Linux: force StopDiscovery via
    // D-Bus and RemoveDevice the scale, so the next scan cycle starts from
    // a clean BlueZ state instead of inheriting the zombie subscription.
    if (!gattSucceeded) {
      try {
        await helperOf(btAdapter!).callMethod('StopDiscovery');
        bleLog.debug('Force StopDiscovery after failed GATT');
      } catch (e) {
        bleLog.debug(`Force StopDiscovery failed: ${errMsg(e)}`);
      }
      // The resetConnection() below would invalidate the claim anyway, but the
      // invariant should hold by construction, not by what happens to follow.
      if (btAdapter) notifyDiscoveryStopped(btAdapter);
      if (deviceMac) {
        await removeDevice(btAdapter!, deviceMac);
      }
    }

    // After a GATT connection (successful or failed), reset the D-Bus
    // connection AND power-cycle the HCI controller. BlueZ on Broadcom
    // adapters (RPi) enters a "zombie discovery" state after a few
    // connect/disconnect cycles: Discovering=true, fresh startDiscovery()
    // succeeds, but the controller is no longer running LE scan. D-Bus
    // reset alone is insufficient because bluetoothd's controller-state
    // tracking survives across client reconnects. btmgmt power off/on
    // clears the zombie at the kernel level. See bluez/bluez#807,
    // bluez/bluer#47.
    //
    // None of that is worth doing while the app is shutting down: there is no
    // next scan cycle to protect, and the power-cycle alone spends about
    // 2.5 s in sleeps plus two btmgmt child processes, inside a 5 s
    // force-exit grace window (#335). The D-Bus reset is kept either way,
    // because it destroys the socket that pins the event loop open, which is
    // the opposite of a delay.
    //
    // `ble.preemptive_adapter_reset: false` skips the power-cycle and nothing
    // else. It is the only host-side event between a bonded session that
    // works and a next connect whose stored key is rejected (#417), so it has
    // to be possible to rule it in or out. The D-Bus reset stays, and the
    // reactive recovery tiers in startDiscoverySafe still cover a wedge.
    //
    // An abort is either a shutdown or the poll loop giving up on this cycle
    // (A-04), and neither should power-cycle the radio: a shutdown has no next
    // cycle, and an abandoned cycle's power-cycle would land on the next one,
    // which starts after a 5 s backoff. A controller that really is wedged is
    // still recovered by the tiers in startDiscoverySafe.
    if (superseded()) {
      standDown();
      return;
    }
    if (abortSignal?.aborted) {
      resetConnection();
      bleLog.debug('Cycle aborted: D-Bus connection reset, skipping the btmgmt power-cycle');
    } else {
      await sleep(500);
      // The awaits above are D-Bus calls with no deadline, so the loop can
      // give up on this cycle and start the next one while they run.
      if (superseded()) {
        standDown();
        return;
      }
      resetConnection();
      bleLog.debug('D-Bus connection reset after GATT operation');
      if (!preemptiveAdapterReset) {
        // Once at info, so a reporter testing #417 can see the option took
        // effect without DEBUG; every cycle after that at debug.
        if (!preemptiveSkipAnnounced) {
          preemptiveSkipAnnounced = true;
          bleLog.info(
            'ble.preemptive_adapter_reset is false: the Bluetooth adapter is no longer ' +
              'power-cycled after each GATT session.',
          );
        }
        bleLog.debug(
          'Skipping the preemptive btmgmt power-cycle after GATT (ble.preemptive_adapter_reset: false)',
        );
      } else if (await resetAdapterBtmgmt(parseHciIndex(bleAdapter))) {
        bleLog.debug('Preemptive btmgmt reset after GATT');
      } else {
        bleLog.debug('Preemptive btmgmt reset after GATT did not take; adapter not power-cycled');
      }
    }
  }
  // For idle cycles (no GATT connection), discovery is kept running.
  // Stopping and restarting discovery on every idle cycle triggers a BlueZ
  // bug where the Discovering property desyncs from the controller state.
}

/**
 * Wait for a complete reading, under both an idle timeout and an absolute cap.
 *
 * Two timeouts, not one: the inner deadline restarts on every frame the scale
 * sends, so a scale that keeps talking never trips it, and the outer one bounds
 * the whole session anyway. A composition hold still in progress moves the cap
 * out to the end of the hold, so the held weight resolves instead of being cut
 * (#434).
 */
export async function readWithTimeouts(
  charMap: Map<string, BleChar>,
  bleDevice: BleDevice,
  matchedAdapter: ScaleAdapter,
  deviceMac: string,
  opts: {
    profile: UserProfile;
    weightUnit?: WeightUnit;
    onLiveData?: (reading: ScaleReading) => void;
    scaleAuth?: ScaleAuth;
    readingTimeoutMs?: number;
    abortSignal?: AbortSignal;
    /** Advertised name, handed to the adapter as ConnectionContext.deviceName. */
    deviceName?: string;
  },
): Promise<RawReading> {
  const idleMs = opts.readingTimeoutMs ?? RAW_READING_TIMEOUT_MS;
  // A shutdown ends the session the same way a timeout does, through
  // withAbandonmentCleanup, instead of waiting out an idle window of up to
  // 120 s that the 5 s force-exit grace never lets finish (A-07).
  return await withAbandonmentCleanup(bleDevice, () =>
    untilAborted(
      withIdleTimeout(
        (onActivity) =>
          waitForRawReading(
            charMap,
            bleDevice,
            matchedAdapter,
            opts.profile,
            deviceMac.replace(/[:-]/g, '').toUpperCase(),
            opts.weightUnit,
            opts.onLiveData,
            opts.scaleAuth,
            onActivity,
            opts.deviceName,
          ),
        idleMs,
        'Timed out waiting for a complete scale reading',
        { ms: idleMs * READING_SESSION_CAP_FACTOR, message: 'GATT session cap exceeded' },
      ),
      opts.abortSignal,
    ),
  );
}

/**
 * Tag a failure for the #154 watchdog (#213).
 *
 * An idle no-show where the radio still sees other advertisers must not count
 * toward the consecutive-failure watchdog; a GATT failure, or a radio that sees
 * nothing at all, must. `probeAdapter` being unset means we never got far
 * enough to ask, which is itself a wedge symptom.
 *
 * `scanRestarted`: the scan activity watchdog restarted the scan during this
 * cycle's wait (ScanWatch.restarts).
 *
 * `scanHeardAt`: when that watchdog last heard the room (ScanWatch.lastHeardAt).
 * Recent enough, it answers for the probe: a controller that reports in bursts
 * (the maintainer's Pi, 2026-10-06) is silent for 5-8 s between them, and the
 * probe's 3 s fell into it at the end of most freshly started scans.
 */
export async function classifyBleFailure(
  err: unknown,
  ctx: {
    gattAttempted: boolean;
    probeAdapter: Adapter | undefined;
    abortSignal?: AbortSignal;
    scanRestarted?: boolean;
    scanHeardAt?: number;
  },
): Promise<void> {
  if (ctx.abortSignal?.aborted || bleFailureKind(err) !== undefined) return;
  if (ctx.gattAttempted || !ctx.probeAdapter) {
    tagBleFailure(err, 'wedge-suspect');
    return;
  }
  // A negative age means the wall clock was stepped back (no RTC on a Pi), so
  // it says nothing about when the room was heard.
  const heardAgoMs = ctx.scanHeardAt === undefined ? undefined : Date.now() - ctx.scanHeardAt;
  let alive: boolean;
  if (heardAgoMs !== undefined && heardAgoMs >= 0 && heardAgoMs <= SCAN_HEARD_FRESH_MS) {
    bleLog.debug(
      `Scan heard the room ${Math.round(heardAgoMs / 1000)}s ago; no liveness probe needed`,
    );
    alive = true;
  } else {
    alive = await probeLiveness(makeLivenessAdapter(ctx.probeAdapter));
    // The cycles a probe still decides are the ones the fresh window misses;
    // how often they come out deaf is what would justify a wider window.
    bleLog.debug(
      `Liveness probe: radio ${alive ? 'alive' : 'heard nothing'} (scan last heard the room ` +
        `${heardAgoMs === undefined ? 'never' : `${Math.round(heardAgoMs / 1000)}s ago`})`,
    );
  }
  // A radio that hears nothing may be running a deaf scan of ours that is
  // latched as filtered, and the next cycle would then continue it instead of
  // cycling it, for good. Dropping the claim makes that cycle restart it once.
  // A room the radio hears, whether the watchdog heard it or the probe did,
  // keeps the claim, so the Device1 objects #397 lost to every restart stay
  // where they are. So does a scan the watchdog already restarted in this
  // wait: in a quiet room every cycle would otherwise add a stop, a quiesce and
  // a start of its own at the next cycle start, and a scan that goes deaf
  // again is the next wait's watchdog's job.
  if (!alive && !ctx.scanRestarted) notifyDiscoveryStopped(ctx.probeAdapter);
  tagBleFailure(err, alive ? 'idle' : 'wedge-suspect');
}
