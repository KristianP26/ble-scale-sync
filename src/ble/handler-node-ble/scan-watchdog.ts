/**
 * Scan activity watchdog: restarts a node-ble discovery that stops delivering
 * advertisements while BlueZ still reports Discovering, without ending the wait
 * that runs on it.
 *
 * startDiscoverySafe() only looks at discovery when a cycle starts. On the
 * maintainer's Pi (BlueZ 5.82, 2026-10-06) the same stuck state also formed in
 * the middle of an ordinary idle cycle, on a session that was ours and with no
 * GATT session or bus reset involved: BlueZ's device list fell from 32 to 15
 * and btmon saw no advertising report for 6 s, while Discovering stayed true.
 * Nothing in that cycle could notice it, and the scale stayed invisible until
 * the liveness probe at the end of the cycle classified it as wedge-suspect.
 *
 * The watchdog runs alongside the wait and never gates it: the wait goes on
 * unchanged, and the watchdog is stopped the moment the wait settles.
 */

import { bleLog, abortableSleep, errMsg, withTimeout, DISCOVERY_TIMEOUT_MS } from '../types.js';
import { helperOf, getDbusNext, type Adapter } from './dbus.js';
import { restartStalledDiscovery, type StalledScanRestart } from './discovery.js';

/** How often the watchdog looks at what BlueZ has heard. */
export const SCAN_ACTIVITY_SAMPLE_MS = 3_000;

/**
 * How long a scan may hear nothing at all before it counts as stalled.
 *
 * A filtered LE discovery runs in kernel windows of about 10.24 s, and
 * bluetoothd restarts each one right away (no_scan_restart_delay), so a
 * healthy scan is never deaf for more than a moment. When a restart fails,
 * bluetoothd retries on its own after IDLE_DISCOV_TIMEOUT * 2 = 10 s
 * (start_discovery_complete()), and 15 s leaves that retry room to land
 * before we step in. Anything advertising at the usual 0.1-2 s intervals moves
 * its RSSI many times within 15 s, because a filtered discovery reports every
 * RSSI change. And it is short against the 120 s the wait has: a heal at 15 s
 * still leaves most of the window for a scale that only advertises while
 * someone stands on it.
 */
export const SCAN_ACTIVITY_STALL_MS = 15_000;

/**
 * How recently the watchdog must have heard the room for a failed cycle to
 * count as idle without the liveness probe (classifyBleFailure()). Two report
 * windows plus one sample, rounded up: one window whose few reports move no
 * RSSI must not send the cycle back to a probe that lands in the silence
 * between bursts. The cost is that a scan going deaf in the last 30 s of a
 * wait keeps its latch, and the next wait's watchdog has to heal it.
 */
export const SCAN_HEARD_FRESH_MS = 30_000;

/**
 * The backoff ceiling: half a wait, so even a fully backed-off watchdog still
 * fires once per wait. A ceiling at the whole wait never fired again once it
 * was reached, and with the session latched as ours and filtered, the next
 * cycle continued the deaf scan instead of cycling it: the permanent failure
 * the watchdog exists to end.
 */
const SCAN_ACTIVITY_STALL_MAX_MS = DISCOVERY_TIMEOUT_MS / 2;

/**
 * Consecutive samples with activity that show the radio really hears the room,
 * and so that a later silence means something again. Three samples are 9 s of
 * uninterrupted traffic, which a room with one rare advertiser does not produce.
 */
const SUSTAINED_ACTIVITY_SAMPLES = 3;

/** A healthy bluetoothd answers GetManagedObjects in milliseconds. */
const SAMPLE_CALL_TIMEOUT_MS = 5_000;

/**
 * Per process on purpose. A room with no advertisers at all looks exactly like
 * a stalled scan, and only the outcome of a restart can tell the two apart: a
 * restart that brings no sustained activity doubles the threshold, so a quiet
 * room costs a few restarts in the first wait and one per wait after that,
 * until the radio hears a busy room again or a weigh-in succeeds.
 */
let stallMs = SCAN_ACTIVITY_STALL_MS;
let restarts = 0;

/** How many stalled scans this process has restarted. */
export function scanStallRestarts(): number {
  return restarts;
}

/**
 * A weigh-in went through, so the radio works: the silence the backoff learned
 * from is no evidence any more. Without this, a scale that is found within a
 * few seconds never gives the watchdog the sustained activity it re-arms on.
 */
export function resetScanActivityBackoff(): void {
  stallMs = SCAN_ACTIVITY_STALL_MS;
}

/** Test seam: the backoff and the count are per process. */
export function _resetScanActivityWatchdogForTests(): void {
  stallMs = SCAN_ACTIVITY_STALL_MS;
  restarts = 0;
}

/**
 * What the watchdog did during the waits of one cycle, for the failure
 * classification at its end (classifyBleFailure()).
 */
export interface ScanWatch {
  /** Restarts that left a scan of ours running, shared ones included. */
  restarts: number;
  /**
   * When a sample last showed the radio hearing something (Date.now()): an
   * RSSI that is new or has moved. Unset until one does in this cycle's wait.
   * Restarts and a Discovering that is off reset the stall clock, not this.
   */
  lastHeardAt?: number;
}

/** Address -> RSSI of every device BlueZ lists under one adapter; undefined when it holds no RSSI. */
export type DeviceSnapshot = Map<string, number | undefined>;
export type DeviceSnapshotReader = () => Promise<DeviceSnapshot>;

const DEVICE_IFACE = 'org.bluez.Device1';

type ManagedObjects = Record<string, Record<string, Record<string, { value?: unknown }>>>;

/**
 * Read every device of one adapter with a single ObjectManager.GetManagedObjects
 * call, sent raw on the adapter's own bus.
 *
 * The per-device route (getDevice() plus a property read) costs an
 * Introspect and a match rule per device per sample, every 3 s, in a room that
 * may hold dozens of advertisers (#396, #397). A raw call costs one round trip
 * and leaves nothing behind. BlueZ only lists RSSI for a device it has heard
 * since the last discovery_cleanup() (dev_property_exists_rssi()), so a
 * missing value is meaningful here, not a failed read.
 */
export function managedDeviceReader(btAdapter: Adapter): DeviceSnapshotReader {
  return async () => {
    const helper = helperOf(btAdapter);
    if (!helper.dbus) throw new Error('the adapter has no D-Bus connection');
    const { Message } = await getDbusNext();
    const reply = await withTimeout(
      helper.dbus.call(
        new Message({
          destination: 'org.bluez',
          path: '/',
          interface: 'org.freedesktop.DBus.ObjectManager',
          member: 'GetManagedObjects',
        }),
      ),
      SAMPLE_CALL_TIMEOUT_MS,
      `GetManagedObjects got no answer from BlueZ within ${SAMPLE_CALL_TIMEOUT_MS / 1000}s`,
    );
    const objects = (reply?.body[0] ?? {}) as ManagedObjects;
    const prefix = `${helper.object}/`;
    const snapshot: DeviceSnapshot = new Map();
    for (const [path, ifaces] of Object.entries(objects)) {
      const dev = path.startsWith(prefix) ? ifaces[DEVICE_IFACE] : undefined;
      const address = dev?.Address?.value;
      if (typeof address !== 'string') continue;
      const rssi = dev?.RSSI?.value;
      snapshot.set(address, typeof rssi === 'number' ? rssi : undefined);
    }
    return snapshot;
  };
}

/**
 * Run `wait` with the watchdog alongside it.
 *
 * When the wait settles, the watchdog is stopped. A restart it has in flight
 * is waited for, whether the wait found something or failed: its StopDiscovery
 * must not land on the device the caller is about to use, nor run into the
 * next cycle's startDiscoverySafe(). Never on an abort: the restart follows
 * the caller's signal itself, and a shutdown must not sit behind BlueZ.
 *
 * `scanWatch` collects what the watchdog did, for the caller's classification
 * of a failed cycle.
 */
export async function withScanActivityWatchdog<T>(
  btAdapter: Adapter,
  abortSignal: AbortSignal | undefined,
  wait: () => Promise<T>,
  scanWatch: ScanWatch = { restarts: 0 },
  readDevices: DeviceSnapshotReader = managedDeviceReader(btAdapter),
): Promise<T> {
  const stop = new AbortController();
  const inFlight: { restart?: Promise<StalledScanRestart> } = {};
  void watch(btAdapter, readDevices, stop.signal, abortSignal, inFlight, scanWatch).catch((err) =>
    bleLog.debug(`Scan activity watchdog ended: ${errMsg(err)}`),
  );
  try {
    return await wait();
  } finally {
    stop.abort();
    const restart = inFlight.restart;
    // Waited for even when the wait found its device: its StopDiscovery must
    // not land on that device. It can still cost one: a broadcast-only,
    // non-connectable scale found while the restart is under way may lose the
    // advertisement snapshot the caller is about to read, because the stop of a
    // sole client runs discovery_cleanup(), which removes temporary
    // non-connectable devices until the restarted scan hears them again.
    if (restart && !abortSignal?.aborted) await restart;
  }
}

async function watch(
  btAdapter: Adapter,
  readDevices: DeviceSnapshotReader,
  stop: AbortSignal,
  abortSignal: AbortSignal | undefined,
  inFlight: { restart?: Promise<StalledScanRestart> },
  scanWatch: ScanWatch,
): Promise<void> {
  const over = (): boolean => stop.aborted || abortSignal?.aborted === true;
  /** The previous sample; undefined until the first one, which is only a baseline. */
  let last: DeviceSnapshot | undefined;
  let quietSince = Date.now();
  let activeRun = 0;
  // A reader that keeps failing leaves the watchdog blind without a trace, so
  // the first failure of a wait is said once.
  let readFailureLogged = false;

  while (!over()) {
    await abortableSleep(SCAN_ACTIVITY_SAMPLE_MS, stop).catch(() => {});
    if (over()) return;
    const snapshot = await sample(readDevices, stop, (err) => {
      if (readFailureLogged) return;
      readFailureLogged = true;
      bleLog.debug(`Scan activity watchdog could not list devices: ${errMsg(err)}`);
    });
    if (over()) return;
    if (snapshot === undefined) continue;
    // Devices left over from earlier cycles say nothing about this scan, so
    // the first sample is never activity.
    const active = last !== undefined && heardSince(last, snapshot);
    last = snapshot;

    if (active) {
      quietSince = Date.now();
      scanWatch.lastHeardAt = quietSince;
      activeRun++;
      if (activeRun >= SUSTAINED_ACTIVITY_SAMPLES && stallMs !== SCAN_ACTIVITY_STALL_MS) {
        bleLog.debug('Scan activity is back to normal; stall threshold reset');
        stallMs = SCAN_ACTIVITY_STALL_MS;
      }
      continue;
    }
    activeRun = 0;

    const silentMs = Date.now() - quietSince;
    if (silentMs < stallMs) continue;
    const silentFor = `no advertisements for ${Math.round(silentMs / 1000)}s`;

    let discovering: boolean | undefined;
    try {
      discovering = await btAdapter.isDiscovering();
    } catch (err) {
      bleLog.debug(`Scan activity watchdog could not read Discovering: ${errMsg(err)}`);
    }
    if (over()) return;
    if (discovering !== true) {
      // Not the stall this is for. Discovery that is off is restarted by the
      // next cycle's startDiscoverySafe(), and that is not this wait's job.
      bleLog.debug(`Scan activity: ${silentFor}, Discovering=${discovering}`);
      quietSince = Date.now();
      continue;
    }

    // The caller's abort, not `stop`: a restart the found device interrupted
    // halfway would leave discovery stopped under a broadcast scale.
    // Never rejects: withScanActivityWatchdog() awaits it in a finally, where a
    // rejection would replace the wait's own result.
    const restart = restartStalledDiscovery(btAdapter, abortSignal).catch(
      (err): StalledScanRestart => {
        bleLog.debug(`Could not restart the stalled discovery: ${errMsg(err)}`);
        return 'failed';
      },
    );
    inFlight.restart = restart;
    const outcome = await restart;
    inFlight.restart = undefined;
    quietSince = Date.now();
    activeRun = 0;
    if (outcome === 'restarted' || outcome === 'shared') scanWatch.restarts++;
    // A shared restart backs off too. It is not inert: where another client's
    // filter differs from ours, update_discovery_filter() restarts the kernel
    // scan when we leave and again when we rejoin, and a quiet room would get
    // those two restarts every 15 s for as long as it stays quiet.
    stallMs = Math.min(stallMs * 2, SCAN_ACTIVITY_STALL_MAX_MS);

    if (outcome === 'shared') {
      // Not counted in scanStallRestarts() and not said at info: other clients
      // kept Discovering on, so this only left and rejoined their scan.
      bleLog.debug(
        `Scan activity: ${silentFor}, but other programs hold discovery sessions on this ` +
          'adapter; left and rejoined their scan',
      );
      continue;
    }
    restarts++;
    bleLog.info(
      `Scan stalled (${silentFor} while BlueZ reports Discovering); ` +
        `${outcome === 'restarted' ? 'restarted' : 'could not restart'} discovery ` +
        `(restart ${restarts} since start)`,
    );
    // BlueZ refused it in a way only the next cycle's startDiscoverySafe() can
    // act on (it resets the connection, which this wait cannot survive).
    if (outcome === 'stuck') return;
  }
}

/** One sample, or undefined when BlueZ could not be asked or the watchdog was stopped first. */
function sample(
  readDevices: DeviceSnapshotReader,
  stop: AbortSignal,
  onReadError: (err: unknown) => void,
): Promise<DeviceSnapshot | undefined> {
  if (stop.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const onStop = (): void => resolve(undefined);
    stop.addEventListener('abort', onStop, { once: true });
    readDevices().then(
      (snapshot) => {
        stop.removeEventListener('abort', onStop);
        resolve(snapshot);
      },
      (err) => {
        stop.removeEventListener('abort', onStop);
        if (!stop.aborted) onReadError(err);
        resolve(undefined);
      },
    );
  });
}

/**
 * True when BlueZ heard something between two samples: an RSSI it did not
 * hold before, or one that moved. A filtered discovery reports every change,
 * and discovery_cleanup() drops the value until the device is heard again.
 * That covers a newly listed device too, because device_found() creates it
 * together with its RSSI. A new device without one (a bond loaded from
 * storage, say) was not heard, and does not count.
 */
function heardSince(prev: DeviceSnapshot, now: DeviceSnapshot): boolean {
  for (const [addr, rssi] of now) {
    if (rssi !== undefined && rssi !== prev.get(addr)) return true;
  }
  return false;
}
