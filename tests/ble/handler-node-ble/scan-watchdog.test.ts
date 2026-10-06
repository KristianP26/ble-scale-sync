import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeBluez, bluezError } from '../../helpers/fake-bluez.js';

/**
 * The scan activity watchdog, run through the real waitForTargetDevice and the
 * real discovery code against the BlueZ model (tests/helpers/fake-bluez.ts).
 *
 * What it is for: a scan that goes deaf in the middle of a wait while BlueZ
 * still reports Discovering, which nothing in the cycle would otherwise
 * notice, so a scale stepped on during it is never seen. Suspected on the
 * maintainer's Pi (2026-10-06), not proven: the silences seen there turned out
 * to be normal for a controller that reports in bursts.
 */

let bluez = new FakeBluez();
let generation = 0;
let us = ':1.ours-0';
const calls: string[] = [];

vi.mock('node-ble', () => ({ default: {} }));

vi.mock('../../../src/ble/handler-node-ble/dbus.js', () => ({
  helperOf: (obj: { helper: unknown }) => obj.helper,
  releaseDeviceProxy: vi.fn(),
  isBonded: vi.fn(),
  getDbusNext: async () => ({
    Variant: class {
      constructor(
        readonly sig: string,
        readonly value: unknown,
      ) {}
    },
    // dbus-next's Message keeps the fields it is given; the fake bus reads them.
    Message: class {
      constructor(fields: Record<string, unknown>) {
        Object.assign(this, fields);
      }
    },
  }),
}));

vi.mock('../../../src/ble/handler-node-ble/connection.js', () => ({
  getAdapter: async () => bluez.adapterFor(us),
  resetConnection: () => {
    calls.push('resetConnection');
    bluez.disconnect(us);
    generation++;
    us = `:1.ours-${generation}`;
  },
  isStaleConnectionError: () => false,
  isDbusConnectionError: () => false,
  dbusError: () => new Error('dbus'),
  parseHciIndex: () => 0,
  currentConnectionGeneration: () => generation,
}));

vi.mock('../../../src/ble/handler-node-ble/device-object.js', () => ({
  logAdvertisementSnapshot: vi.fn(),
}));

vi.mock('../../../src/ble/handler-node-ble/privacy.js', () => ({
  reensureAdapterPrivacy: async () => {},
}));

// The tiers below bluetoothd's D-Bus state, refused as on the Pi. Mocked
// rather than left to the platform check, which lets them run on a Linux CI.
vi.mock('../../../src/ble/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/types.js')>();
  return {
    ...actual,
    resetAdapterBtmgmt: async () => false,
    resetAdapterRfkill: async () => false,
    restartBluetoothd: async () => false,
  };
});

const { waitForTargetDevice, classifyBleFailure } =
  await import('../../../src/ble/handler-node-ble/scan-stages.js');
const { startDiscoverySafe, _resetDiscoveryRecoveryStateForTests } =
  await import('../../../src/ble/handler-node-ble/discovery.js');
const {
  scanStallRestarts,
  withScanActivityWatchdog,
  resetScanActivityBackoff,
  _resetScanActivityWatchdogForTests,
} = await import('../../../src/ble/handler-node-ble/scan-watchdog.js');
const { bleFailureKind } = await import('../../../src/ble/failure-kind.js');
const { bleLog } = await import('../../../src/ble/types.js');

type Adapter = Parameters<typeof startDiscoverySafe>[0];

const SCALE = 'AA:BB:CC:DD:EE:01';
const HA = ':1.ha';
const NEIGHBOURS = ['11:22:33:44:55:01', '11:22:33:44:55:02', '11:22:33:44:55:03'];

const logged: string[] = [];
/** When each "Scan stalled" line was logged, on the fake clock. */
const stalledAt: number[] = [];
let ours: Adapter;

const stopsSent = (): number => bluez.log.filter((l) => l.endsWith(' StopDiscovery')).length;

/** A cycle start as scan.ts does it: our own filtered session, healthy. */
async function startScan(): Promise<void> {
  const p = startDiscoverySafe(ours);
  await vi.advanceTimersByTimeAsync(0);
  const result = await p;
  if (result) ours = result;
  expect(bluez.delivering(us)).toBe(true);
}

interface Outcome {
  device?: unknown;
  error?: unknown;
  settled: boolean;
  /** Replies BlueZ still owed us when the promise settled. */
  answersPending?: number;
}

/** Keep a promise's outcome without letting a rejection go unhandled. */
function track(p: Promise<unknown>): Outcome {
  const outcome: Outcome = { settled: false };
  p.then(
    (d) =>
      Object.assign(outcome, { device: d, settled: true, answersPending: bluez.answersPending }),
    (e) =>
      Object.assign(outcome, { error: e, settled: true, answersPending: bluez.answersPending }),
  );
  return outcome;
}

/** Start the wait and keep its outcome. */
function wait(signal?: AbortSignal): Outcome {
  return track(waitForTargetDevice(ours, SCALE, signal));
}

/** A wait the test settles itself, to run the watchdog alongside. */
function heldWait() {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Run the fake clock in small steps until `cond` holds. */
async function until(cond: () => boolean, maxMs = 200_000): Promise<void> {
  for (let t = 0; !cond() && t < maxMs; t += 100) await vi.advanceTimersByTimeAsync(100);
  expect(cond()).toBe(true);
}

/** The cycle start of the next cycle, as scan.ts makes it. */
async function nextCycleStart(): Promise<void> {
  const p = startDiscoverySafe(ours);
  await vi.advanceTimersByTimeAsync(5_000);
  const result = await p;
  if (result) ours = result;
}

beforeEach(() => {
  bluez = new FakeBluez();
  generation = 0;
  us = ':1.ours-0';
  ours = bluez.adapterFor(us) as unknown as Adapter;
  calls.length = 0;
  logged.length = 0;
  stalledAt.length = 0;
  _resetDiscoveryRecoveryStateForTests();
  _resetScanActivityWatchdogForTests();
  vi.useFakeTimers();
  for (const level of ['debug', 'info', 'warn'] as const) {
    vi.spyOn(bleLog, level).mockImplementation((msg: string) => {
      logged.push(`${level}: ${msg}`);
      if (/^Scan stalled/.test(msg)) stalledAt.push(Date.now());
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scan activity watchdog', () => {
  it('restarts a scan that goes deaf mid-wait, and the wait then finds the scale', async () => {
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(10_000);

    // Our own session, Discovering still true, the kernel no longer scanning.
    const stalledFrom = Date.now();
    bluez.stallScan({ enable: 0 });
    expect(bluez.discovering).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    bluez.room.add(SCALE); // someone steps on the scale while the scan is deaf
    bluez.log.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(outcome.error).toBeUndefined();
    expect(outcome.device).toBeDefined();
    expect(bluez.methodsOf(us)).toEqual(['StopDiscovery', 'SetDiscoveryFilter', 'StartDiscovery']);
    expect(bluez.delivering(us)).toBe(true);
    const info = logged.filter((l) => l.startsWith('info: '));
    expect(info).toHaveLength(1);
    expect(info[0]).toMatch(
      /^info: Scan stalled \(no advertisements for \d+s while BlueZ reports Discovering\); restarted discovery \(restart 1 since start\)$/,
    );
    expect(scanStallRestarts()).toBe(1);
    // Within the threshold and a sample or two of the stall, not at the end
    // of the 120 s wait.
    expect(stalledAt[0] - stalledFrom).toBeGreaterThanOrEqual(12_000);
    expect(stalledAt[0] - stalledFrom).toBeLessThanOrEqual(21_000);

    // The restarted scan is ours and filtered, so the next cycle keeps it
    // rather than cycling it again (#397).
    bluez.log.length = 0;
    await nextCycleStart();
    expect(bluez.methodsOf(us)).toEqual([]);
  });

  it('does not count a restarted scan as filtered when BlueZ refused the filter', async () => {
    // The latch would keep a deduplicating scan for the life of the process
    // (#372); without the filter the next cycle has to cycle it again.
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(5_000);
    bluez.stallScan({ enable: 0 });
    bluez.failAlways.set(
      'SetDiscoveryFilter',
      bluezError('org.bluez.Error.InvalidArguments', 'Invalid arguments'),
    );
    bluez.room.add(SCALE);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome.device).toBeDefined();
    expect(scanStallRestarts()).toBe(1);

    bluez.failAlways.delete('SetDiscoveryFilter');
    bluez.log.length = 0;
    await nextCycleStart();
    expect(bluez.methodsOf(us)).toContain('StopDiscovery');
  });

  it('heals a scan that went deaf before the wait started', async () => {
    // The phantom can form between idle cycles, so the wait may never see a
    // working scan at all.
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    await vi.advanceTimersByTimeAsync(1_000);
    // BlueZ has heard the room by now and keeps listing it after the stall.
    expect(await bluez.adapterFor(us).devices()).toHaveLength(NEIGHBOURS.length);
    bluez.stallScan({ enable: 0 });
    bluez.room.add(SCALE);

    const waitFrom = Date.now();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(25_000);

    expect(outcome.device).toBeDefined();
    expect(scanStallRestarts()).toBe(1);
    // The devices BlueZ already listed at the start are not taken for
    // activity, so the threshold counts from the start of the wait.
    expect(stalledAt[0] - waitFrom).toBeLessThanOrEqual(16_000);
  });

  it('takes over a deaf scan that is no longer ours', async () => {
    // The phantom proper: Discovering true, no client's session, the kernel
    // idle. Our own StopDiscovery is refused with "No discovery started", so
    // the restart has to join first.
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(5_000);
    bluez.enterPhantom({ enable: 0 });
    bluez.room.add(SCALE);
    bluez.log.length = 0;

    await vi.advanceTimersByTimeAsync(30_000);

    expect(bluez.methodsOf(us)).toEqual([
      'StopDiscovery',
      'SetDiscoveryFilter',
      'StartDiscovery',
      'StopDiscovery',
      'SetDiscoveryFilter',
      'StartDiscovery',
    ]);
    expect(outcome.device).toBeDefined();
  });

  it('leaves a discovery that is off to the next cycle', async () => {
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const scanWatch: { restarts: number; lastHeardAt?: number } = { restarts: 0 };
    const outcome = track(waitForTargetDevice(ours, SCALE, undefined, scanWatch));
    await vi.advanceTimersByTimeAsync(5_000);
    await bluez.call(us, 'StopDiscovery', []);
    await vi.advanceTimersByTimeAsync(0);
    expect(bluez.discovering).toBe(false);
    bluez.log.length = 0;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(outcome.settled).toBe(false);
    expect(bluez.log).toEqual([]);
    expect(scanStallRestarts()).toBe(0);
    // Silence with discovery off is not hearing the room.
    expect(scanWatch.lastHeardAt).toBeUndefined();
  });

  it('never restarts a scan that keeps hearing the room', async () => {
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(125_000);

    expect(outcome.error).toBeDefined(); // no scale in the room
    expect(bluez.managedObjectsReads).toBeGreaterThan(10);
    expect(stopsSent()).toBe(0);
    expect(scanStallRestarts()).toBe(0);
  });

  it('takes a newly heard device for activity, in a room whose RSSIs never move', async () => {
    // BlueZ reports an RSSI only when it changes, so devices at a fixed spot
    // look silent. A device BlueZ did not list before can only come from an
    // advertisement.
    for (const n of NEIGHBOURS) bluez.advertise(n, { constantRssi: true });
    await startScan();
    const outcome = wait();
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      bluez.advertise(`22:33:44:55:66:${String(10 + i)}`, { constantRssi: true });
    }

    expect(outcome.settled).toBe(true);
    expect(stopsSent()).toBe(0);
    expect(scanStallRestarts()).toBe(0);
  });

  it('pays one restart for a room with a single rare advertiser, not one per advertisement', async () => {
    // One advertisement every 20 s leaves 20 s gaps: the first one looks like
    // a stall, but a single advertisement afterwards is no sustained traffic,
    // so the doubled threshold stays.
    bluez.advertise(NEIGHBOURS[0], { intervalMs: 20_000 });
    await startScan();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(125_000);

    expect(outcome.settled).toBe(true);
    expect(scanStallRestarts()).toBe(1);
  });

  it('a busy room again takes the backoff back to the first threshold', async () => {
    // A silent room first: the threshold backs off.
    await startScan();
    const quiet = wait();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(quiet.settled).toBe(true);
    const quietRestarts = scanStallRestarts();
    expect(quietRestarts).toBeGreaterThan(0);

    // Then the room fills, and later the scan goes deaf.
    for (const n of NEIGHBOURS) bluez.room.add(n);
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(20_000);
    const stalledFrom = Date.now();
    bluez.stallScan({ enable: 0 });
    bluez.room.add(SCALE);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(scanStallRestarts()).toBe(quietRestarts + 1);
    expect(stalledAt[stalledAt.length - 1] - stalledFrom).toBeLessThanOrEqual(21_000);
    expect(outcome.device).toBeDefined();
  });

  it('backs off in a room with nothing to hear, but still fires once per wait', async () => {
    await startScan();

    const first = wait();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(first.settled).toBe(true);
    expect(first.error).toBeDefined();

    // Each restart that brought nothing back doubled the threshold, counted
    // from the end of that restart, up to the ceiling of half a wait.
    expect(stalledAt).toHaveLength(3);
    const gaps = stalledAt.slice(1).map((t, i) => t - stalledAt[i]);
    expect(gaps[0]).toBeGreaterThanOrEqual(30_000);
    expect(gaps[0]).toBeLessThan(36_000);
    expect(gaps[1]).toBeGreaterThanOrEqual(60_000);

    // The next wait in the same silent room restarts once, at the ceiling.
    const secondFrom = Date.now();
    const second = wait();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(second.settled).toBe(true);
    expect(stalledAt).toHaveLength(4);
    expect(stalledAt[3] - secondFrom).toBeGreaterThanOrEqual(60_000);
    expect(stalledAt[3] - secondFrom).toBeLessThanOrEqual(66_000);
  });

  it('heals a deaf latched scan within the wait even at the end of the backoff', async () => {
    // A silent room backs the threshold all the way off. Then the scan goes
    // deaf between cycles on our own latched session, which the next cycle
    // continues on purpose (#397). A ceiling that never fires again left that
    // scan deaf for good.
    await startScan();
    const quiet = wait();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(quiet.settled).toBe(true);
    const quietRestarts = scanStallRestarts();

    for (const n of NEIGHBOURS) bluez.room.add(n);
    bluez.stallScan({ enable: 0 });
    bluez.room.add(SCALE);
    bluez.log.length = 0;
    await nextCycleStart();
    expect(bluez.methodsOf(us)).toEqual([]);

    const waitFrom = Date.now();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(110_000);

    expect(outcome.device).toBeDefined();
    expect(scanStallRestarts()).toBe(quietRestarts + 1);
    expect(stalledAt[stalledAt.length - 1] - waitFrom).toBeGreaterThanOrEqual(60_000);
  });

  it('starts over at the first threshold after a weigh-in', async () => {
    await startScan();
    const quiet = wait();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(quiet.settled).toBe(true);

    resetScanActivityBackoff(); // what scan.ts does after a reading
    for (const n of NEIGHBOURS) bluez.room.add(n);
    bluez.stallScan({ enable: 0 });
    bluez.room.add(SCALE);
    const waitFrom = Date.now();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(25_000);

    expect(outcome.device).toBeDefined();
    expect(stalledAt[stalledAt.length - 1] - waitFrom).toBeLessThanOrEqual(16_000);
  });

  it('stops watching as soon as the scale is found', async () => {
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(10_000);
    const readsWhileWaiting = bluez.managedObjectsReads;

    bluez.room.add(SCALE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome.device).toBeDefined();
    const readsAtFound = bluez.managedObjectsReads;

    // A scan that goes deaf after the scale was found is not the watchdog's
    // business any more: the cycle is connecting to it.
    bluez.stallScan({ enable: 0 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(readsWhileWaiting).toBeGreaterThan(0);
    expect(bluez.managedObjectsReads).toBe(readsAtFound);
    expect(stopsSent()).toBe(0);
  });

  it('hands over a scale found during a restart only once the restart is done', async () => {
    // Its StopDiscovery must not land on the device the caller is about to use.
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(5_000);
    bluez.stallScan({ enable: 0 });
    // BlueZ starts the scan at once but answers our StartDiscovery late, and
    // the scale is stepped on while the restart is under way.
    bluez.delayNext.set('StartDiscovery', 3_000);
    bluez.onCall = (_sender, method) => {
      if (method === 'StopDiscovery') bluez.room.add(SCALE);
    };

    await until(() => outcome.settled, 60_000);

    expect(outcome.device).toBeDefined();
    expect(outcome.answersPending).toBe(0);
    expect(bluez.methodsOf(us)).toContain('StartDiscovery');
  });

  it('a wait that fails while a restart is in flight returns once the restart is done', async () => {
    // Otherwise the restart runs on into the next cycle's startDiscoverySafe().
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const held = heldWait();
    const outcome = track(withScanActivityWatchdog(ours, undefined, () => held.promise));
    await vi.advanceTimersByTimeAsync(5_000);
    bluez.stallScan({ enable: 0 });
    bluez.delayNext.set('StartDiscovery', 5_000);
    await until(() => bluez.answersPending === 1, 30_000);

    held.reject(new Error('Device not found within 120s'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(outcome.settled).toBe(true);
    expect(outcome.error).toBeDefined();
    expect(outcome.answersPending).toBe(0);
  });

  it('an abort during a restart returns at once, and the restart starts nothing', async () => {
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const ctrl = new AbortController();
    const held = heldWait();
    ctrl.signal.addEventListener('abort', () => held.reject(ctrl.signal.reason));
    const outcome = track(withScanActivityWatchdog(ours, ctrl.signal, () => held.promise));
    await vi.advanceTimersByTimeAsync(5_000);
    bluez.stallScan({ enable: 0 });
    // The restart's StopDiscovery is answered late, so the restart is still
    // in flight when the abort lands.
    bluez.delayNext.set('StopDiscovery', 5_000);
    bluez.onCall = (_sender, method) => {
      if (method === 'StopDiscovery') ctrl.abort(new Error('shutdown'));
    };
    bluez.log.length = 0;
    await until(() => ctrl.signal.aborted, 30_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.settled).toBe(true);
    expect(outcome.answersPending).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(bluez.methodsOf(us)).toEqual(['StopDiscovery']);
  });

  it('an abort during a takeover starts nothing after the stop', async () => {
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const ctrl = new AbortController();
    const held = heldWait();
    ctrl.signal.addEventListener('abort', () => held.reject(ctrl.signal.reason));
    const outcome = track(withScanActivityWatchdog(ours, ctrl.signal, () => held.promise));
    await vi.advanceTimersByTimeAsync(5_000);
    bluez.enterPhantom({ enable: 0 });
    let stops = 0;
    bluez.onCall = (_sender, method) => {
      // The second one is the stop of the session the takeover just joined.
      if (method === 'StopDiscovery' && ++stops === 2) ctrl.abort(new Error('shutdown'));
    };
    bluez.log.length = 0;
    await until(() => ctrl.signal.aborted, 30_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(outcome.settled).toBe(true);
    expect(bluez.methodsOf(us)).toEqual([
      'StopDiscovery',
      'SetDiscoveryFilter',
      'StartDiscovery',
      'StopDiscovery',
    ]);
  });

  it('stops watching when the cycle is aborted', async () => {
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const ctrl = new AbortController();
    const outcome = wait(ctrl.signal);
    await vi.advanceTimersByTimeAsync(10_000);
    const readsWhileWaiting = bluez.managedObjectsReads;

    ctrl.abort(new Error('shutdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.error).toBeDefined();
    const readsAtAbort = bluez.managedObjectsReads;
    bluez.stallScan({ enable: 0 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(readsWhileWaiting).toBeGreaterThan(0);
    expect(bluez.managedObjectsReads).toBe(readsAtAbort);
    expect(stopsSent()).toBe(0);
  });

  it('on a shared adapter with the same filter, does not count a restart that never reached the controller', async () => {
    // Home Assistant holds a session too, with our transport filter. Our stop
    // then only ends our own session, Discovering stays true, and the merged
    // filter does not change, so the controller sees nothing.
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await bluez.call(HA, 'SetDiscoveryFilter', [
      { Transport: { value: 'le' }, DuplicateData: { value: true } },
    ]);
    await bluez.call(HA, 'StartDiscovery', []);
    await startScan();
    const scanWatch = { restarts: 0 };
    const outcome = track(waitForTargetDevice(ours, SCALE, undefined, scanWatch));
    await vi.advanceTimersByTimeAsync(5_000);
    bluez.stallScan({ enable: 0 });
    const kernelStarts = bluez.kernelStarts;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(outcome.settled).toBe(false);
    expect(scanStallRestarts()).toBe(0);
    // Still a scan of ours that the watchdog restarted, for the failure
    // classification: the next cycle need not cycle it again.
    expect(scanWatch.restarts).toBeGreaterThan(0);
    expect(stalledAt).toEqual([]);
    const shared = logged.filter((l) => /other programs hold discovery sessions/.test(l));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every((l) => l.startsWith('debug: '))).toBe(true);
    expect(bluez.kernelStarts).toBe(kernelStarts);
    // Back in the scan straight away each time.
    expect(bluez.isDiscoveringClient(us)).toBe(true);
    expect(bluez.isDiscoveringClient(HA)).toBe(true);
  });

  it('on a shared adapter with another filter, backs off the restarts that cycle the kernel scan', async () => {
    // A client with no filter of its own merges with ours into another
    // kernel filter, so our leaving and rejoining restarts the kernel scan
    // each time (update_discovery_filter()). In a quiet room that would
    // otherwise happen every 15 s for good.
    await bluez.call(HA, 'StartDiscovery', []);
    await vi.advanceTimersByTimeAsync(0);
    expect(bluez.kernelScanning).toBe(true);
    await startScan();
    const sharedAt: number[] = [];
    vi.mocked(bleLog.debug).mockImplementation((msg: string) => {
      logged.push(`debug: ${msg}`);
      if (/other programs hold discovery sessions/.test(msg)) sharedAt.push(Date.now());
    });
    const kernelStarts = bluez.kernelStarts;

    const outcome = wait();
    await vi.advanceTimersByTimeAsync(125_000);

    expect(outcome.settled).toBe(true);
    expect(scanStallRestarts()).toBe(0);
    expect(stalledAt).toEqual([]);
    // Not inert: each one restarted the kernel scan twice, on leaving and on rejoining.
    expect(bluez.kernelStarts - kernelStarts).toBe(2 * sharedAt.length);
    // Doubled like a counted restart: 15, then 30, then 60 s.
    expect(sharedAt).toHaveLength(3);
    const gaps = sharedAt.slice(1).map((t, i) => t - sharedAt[i]);
    expect(gaps[0]).toBeGreaterThanOrEqual(30_000);
    expect(gaps[1]).toBeGreaterThanOrEqual(60_000);
    expect(bluez.isDiscoveringClient(us)).toBe(true);
    expect(bluez.isDiscoveringClient(HA)).toBe(true);
  });

  it('leaves a stuck stop to the next cycle, without resetting the bus under the wait', async () => {
    // bluetoothd left believing the kernel scans: our Stop is sent to a kernel
    // that is not scanning, rejected, and answered InProgress.
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    const outcome = wait();
    await vi.advanceTimersByTimeAsync(5_000);
    bluez.stallScan({ enable: 1 });
    await vi.advanceTimersByTimeAsync(118_000);

    expect(outcome.settled).toBe(true);
    expect(scanStallRestarts()).toBe(1);
    expect(calls).not.toContain('resetConnection');
    expect(
      logged.filter((l) => l.startsWith('warn: ') && /systemctl restart bluetooth/.test(l)),
    ).toHaveLength(1);

    // The next cycle does what the wait could not.
    const next = startDiscoverySafe(ours);
    await vi.advanceTimersByTimeAsync(30_000);
    await next;
    expect(calls).toContain('resetConnection');
  });
});

describe('failure classification and the latched scan', () => {
  it('a cycle that ends deaf has the next cycle restart its latched scan once', async () => {
    // The wait ended before the watchdog fired. Continuing the latched session
    // is right for a healthy scan (#397) and wrong for this one.
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    await bluez.adapterFor(us).devices();
    bluez.stallScan({ enable: 0 });

    const err = new Error('Device not found within 120s');
    const classified = classifyBleFailure(err, { gattAttempted: false, probeAdapter: ours });
    await vi.advanceTimersByTimeAsync(5_000);
    await classified;
    expect(bleFailureKind(err)).toBe('wedge-suspect');

    bluez.log.length = 0;
    await nextCycleStart();
    expect(bluez.methodsOf(us)[0]).toBe('StopDiscovery');
    expect(bluez.delivering(us)).toBe(true);

    bluez.log.length = 0;
    await nextCycleStart();
    expect(bluez.methodsOf(us)).toEqual([]);
  });

  it('a cycle whose watchdog already restarted the scan does not have the next cycle restart it again', async () => {
    // A quiet room probes as deaf, but the watchdog restarted this scan within
    // the wait. Dropping the claim as well would add a stop, a quiesce and a
    // start at every cycle start on top of the watchdog's own restart.
    await startScan();
    const scanWatch: { restarts: number; lastHeardAt?: number } = { restarts: 0 };
    const outcome = track(waitForTargetDevice(ours, SCALE, undefined, scanWatch));
    await vi.advanceTimersByTimeAsync(125_000);
    expect(outcome.error).toBeDefined();
    expect(scanWatch.restarts).toBeGreaterThan(0);

    const err = new Error('Device not found within 120s');
    const classified = classifyBleFailure(err, {
      gattAttempted: false,
      probeAdapter: ours,
      scanRestarted: scanWatch.restarts > 0,
      // A restart is not hearing the room: the last one lands well within the
      // fresh window and must not stand in for the probe.
      scanHeardAt: scanWatch.lastHeardAt,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await classified;
    expect(bleFailureKind(err)).toBe('wedge-suspect');

    bluez.log.length = 0;
    await nextCycleStart();
    expect(bluez.methodsOf(us)).toEqual([]);
    expect(bluez.delivering(us)).toBe(true);
  });

  it('a no-show that ends between two report bursts of a healthy scan is idle, and keeps the scan', async () => {
    // The Pi (2026-10-06, btmon plus RSSI reads over D-Bus): every kernel
    // discovery window of about 10.5 s delivers its advertising reports in a
    // burst at its start, then 5-7 s in which no RSSI moves. A scan started at
    // the cycle start puts the 120 s timeout about 4.5 s into a window, so the
    // 3 s liveness probe saw nothing in every such cycle, dropped the latch,
    // and the next cycle restarted the scan into the same phase again.
    for (const n of NEIGHBOURS) bluez.advertise(n, { intervalMs: 10_500 });
    await startScan();
    const scanWatch: { restarts: number; lastHeardAt?: number } = { restarts: 0 };
    const outcome = track(waitForTargetDevice(ours, SCALE, undefined, scanWatch));
    await until(() => outcome.settled);
    expect(outcome.error).toBeDefined(); // no scale in the room
    expect(scanWatch.restarts).toBe(0);

    const err = new Error('Device not found within 120s');
    const classified = classifyBleFailure(err, {
      gattAttempted: false,
      probeAdapter: ours,
      scanRestarted: scanWatch.restarts > 0,
      scanHeardAt: scanWatch.lastHeardAt,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await classified;
    expect(bleFailureKind(err)).toBe('idle');

    bluez.log.length = 0;
    await nextCycleStart();
    expect(bluez.methodsOf(us)).toEqual([]);
  });

  it('a scan deaf for the whole wait is never taken for heard, even with devices still listed', async () => {
    // What makes the watchdog's word safe to use in place of the probe: the
    // RSSIs BlueZ still lists from before the scan went deaf are not activity.
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();
    await bluez.adapterFor(us).devices();
    bluez.stallScan({ enable: 0 });

    // Ends before the stall threshold, so no restart hears the room either.
    const scanWatch: { restarts: number; lastHeardAt?: number } = { restarts: 0 };
    const held = heldWait();
    const outcome = track(withScanActivityWatchdog(ours, undefined, () => held.promise, scanWatch));
    await vi.advanceTimersByTimeAsync(12_000);
    held.reject(new Error('Device not found within 120s'));
    await until(() => outcome.settled);
    expect(bluez.managedObjectsReads).toBeGreaterThanOrEqual(3);
    expect(scanWatch.restarts).toBe(0);
    expect(scanWatch.lastHeardAt).toBeUndefined();

    const err = new Error('Device not found within 120s');
    const classified = classifyBleFailure(err, {
      gattAttempted: false,
      probeAdapter: ours,
      scanRestarted: false,
      scanHeardAt: scanWatch.lastHeardAt,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await classified;
    expect(bleFailureKind(err)).toBe('wedge-suspect');

    bluez.log.length = 0;
    await nextCycleStart();
    expect(bluez.methodsOf(us)[0]).toBe('StopDiscovery');
  });

  it('a room whose RSSIs never move is not taken for heard', async () => {
    for (const n of NEIGHBOURS) bluez.advertise(n, { constantRssi: true });
    await startScan();
    await bluez.adapterFor(us).devices();

    const scanWatch: { restarts: number; lastHeardAt?: number } = { restarts: 0 };
    const held = heldWait();
    const outcome = track(withScanActivityWatchdog(ours, undefined, () => held.promise, scanWatch));
    await vi.advanceTimersByTimeAsync(12_000);
    held.reject(new Error('Device not found within 120s'));
    await until(() => outcome.settled);
    expect(bluez.managedObjectsReads).toBeGreaterThanOrEqual(3);
    expect(scanWatch.lastHeardAt).toBeUndefined();
  });

  it('a cycle that ends idle in a busy room leaves the latched scan alone (#397)', async () => {
    for (const n of NEIGHBOURS) bluez.room.add(n);
    await startScan();

    const err = new Error('Device not found within 120s');
    const classified = classifyBleFailure(err, { gattAttempted: false, probeAdapter: ours });
    await vi.advanceTimersByTimeAsync(5_000);
    await classified;
    expect(bleFailureKind(err)).toBe('idle');

    bluez.log.length = 0;
    await nextCycleStart();
    expect(bluez.methodsOf(us)).toEqual([]);
  });
});
