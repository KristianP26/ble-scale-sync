import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ScaleAdapter } from '../../../src/interfaces/scale-adapter.js';
import { defaultProfile } from '../../helpers/scale-test-utils.js';
import { makeController, fakeExecFile, type FakeController } from '../../helpers/fake-btmgmt.js';

/**
 * Characterisation tests for the node-ble `scanAndReadRaw` orchestration (#368).
 *
 * This function is 428 lines of BlueZ workarounds whose ORDER is the load-bearing
 * part: the advertisement has to be snapshotted before StopDiscovery because
 * BlueZ throws it away with the discovery session (#297, #280, #318), and
 * StopDiscovery has to happen before connect because BlueZ on a Pi Zero fails
 * with le-connection-abort-by-local otherwise.
 *
 * Nothing asserted that order until now. `ensureBonded` and `acquireGattServer`
 * are well covered, but the sequence around them was not, so a refactor could
 * reorder two stages and the whole suite would stay green. These tests exist to
 * be the thing that goes red.
 *
 * They are deliberately about SEQUENCE and CALL COUNT, not about return values.
 */

const calls: string[] = [];
const record =
  <T>(name: string, value?: T) =>
  (...args: unknown[]) => {
    calls.push(name);
    return typeof value === 'function' ? (value as (...a: unknown[]) => T)(...args) : value;
  };

vi.mock('dbus-next', () => ({ default: {}, Variant: class {} }));
vi.mock('node-ble', () => ({ default: { createBluetooth: () => ({ bluetooth: {} }) } }));

// btmgmt, for ble.adapter_privacy (#417). Each call lands in `calls` as
// `btmgmt <command...>` so its position in the sequence can be asserted.
let ctl: FakeController = makeController();
const btmgmtExec = fakeExecFile(() => ctl);
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], opts: unknown, cb: never) => {
    calls.push(`btmgmt ${args.slice(2).join(' ')}`);
    btmgmtExec(file, args, opts, cb);
  },
}));

const fakeAdapter = {
  isPowered: async () => {
    calls.push('isPowered');
    return true;
  },
  waitDevice: async () => {
    calls.push('waitDevice');
    return fakeDevice;
  },
  getAddress: async () => ctl.address,
  helper: { callMethod: async () => {}, object: '/org/bluez/hci0' },
};

const fakeGatt = {
  services: async () => {
    calls.push('gatt.services');
    return ['fff0'];
  },
};

const fakeDevice = {
  getName: async () => {
    calls.push('device.getName');
    return 'QN-Scale';
  },
  gatt: async () => {
    calls.push('device.gatt');
    return fakeGatt;
  },
  disconnect: async () => {
    calls.push('device.disconnect');
  },
  isPaired: async () => true,
};

/** False: auto-discovery finds no scale. */
let autoDiscoverFinds = true;
/** The adapter auto-discovery matches the scale to; a test replaces it (#471). */
let autoDiscoverAdapter: (() => ScaleAdapter) | undefined;

/** When set, the next waitForRawReading waits for it. */
let holdNextReading: Promise<void> | null = null;

/** Every provider handed to setPairingTarget, newest last. */
const pairingTargets: (() => { pin?: number; mac?: string })[] = [];

/** Every context handed to connectWithRecovery, newest last. */
const connectContexts: { adapterPrivacy?: boolean }[] = [];

/** Requests the agent handled per scale, keyed by the bare upper-case hex of its MAC (#471). */
const prompts = new Map<string, number>();
const promptKey = (mac: string): string => mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

vi.mock('../../../src/ble/handler-node-ble/agent.js', () => ({
  setPairingTarget: record('setPairingTarget', (p: () => { pin?: number; mac?: string }) => {
    pairingTargets.push(p);
  }),
  ensurePairingAgent: record('ensurePairingAgent', async () => {}),
  userPromptCount: (mac: string) => prompts.get(promptKey(mac)) ?? 0,
}));

vi.mock('../../../src/ble/handler-node-ble/connection.js', () => ({
  getAdapter: record('getAdapter', async () => fakeAdapter),
  getBus: () => ({}),
  resetConnection: record('resetConnection'),
  attachBusErrorHandler: () => {},
  getConnection: () => ({ bluetooth: {}, destroy: () => {} }),
  isStaleConnectionError: () => false,
  isDbusConnectionError: () => false,
  dbusError: () => new Error('dbus'),
  parseHciIndex: () => 0,
}));

// Recorded rather than real: on a Linux runner the real one would spawn btmgmt.
vi.mock('../../../src/ble/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/types.js')>();
  return { ...actual, resetAdapterBtmgmt: record('resetAdapterBtmgmt', async () => true) };
});

/** When set, the next removeDevice waits for it. */
let holdNextRemoveDevice: Promise<void> | null = null;
/** The adapter every removeDevice was sent through, in order. */
const removedThrough: unknown[] = [];

/** What startDiscoverySafe does in a test: an adapter it returns replaces the cycle's. */
let onDiscoveryStart: (() => unknown) | undefined;
/** Whether our filtered scan runs after startDiscoverySafe (D060). */
let scanFiltered = true;

vi.mock('../../../src/ble/handler-node-ble/discovery.js', () => ({
  startDiscoverySafe: record('startDiscoverySafe', async () => onDiscoveryStart?.()),
  runningScanIsFiltered: () => scanFiltered,
  removeDevice: record('removeDevice', async (adapter: unknown) => {
    removedThrough.push(adapter);
    // One-shot gate: lets a test hold a cycle inside its teardown (A-04).
    const gate = holdNextRemoveDevice;
    holdNextRemoveDevice = null;
    if (gate) await gate;
    return 'removed';
  }),
  stopDiscoveryAndQuiesce: record('stopDiscoveryAndQuiesce', async () => {}),
  notifyDiscoveryStopped: record('notifyDiscoveryStopped'),
  autoDiscover: record('autoDiscover', async () => {
    if (autoDiscoverFinds === false) throw new Error('No recognized scale found within 120s');
    return {
      device: fakeDevice,
      adapter: autoDiscoverAdapter?.() ?? makeAdapter(),
      mac: 'AA:BB:CC:DD:EE:FF',
    };
  }),
}));

/** The company id every advertisement snapshot carries; a test replaces it (D060). */
let snapshotCompanyId = 0x0611;
/** The service data every advertisement snapshot carries; a test replaces it (#471). */
let snapshotServiceData: Array<{ uuid: string; data: Buffer }> = [];

vi.mock('../../../src/ble/handler-node-ble/device-object.js', () => ({
  logAdvertisementSnapshot: record('logAdvertisementSnapshot', async () => ({
    manufacturerData: { id: snapshotCompanyId, data: Buffer.alloc(0) },
    serviceData: snapshotServiceData,
  })),
  isDeviceObjectGone: () => false,
}));

/** True: every connect fails, as on a scale that drops the link (D060). */
let connectFails = false;
/** When set, the next connect throws what it returns (#472). */
let connectThrows: (() => Error) | undefined;
/** Runs inside every connect, where BlueZ would ask the agent to confirm a pairing (#471). */
let onConnect: (() => void) | undefined;

vi.mock('../../../src/ble/handler-node-ble/connect.js', () => ({
  connectWithRecovery: record('connectWithRecovery', async (ctx: unknown) => {
    connectContexts.push(ctx as { adapterPrivacy?: boolean });
    onConnect?.();
    if (connectFails) throw new Error('le-connection-abort-by-local');
    const thrown = connectThrows;
    connectThrows = undefined;
    if (thrown) throw thrown();
    return fakeDevice;
  }),
}));

// The stale-link recovery has its own tests. Here only whether the teardown
// reaches it, and that a reading lifts its brake; the bounded Disconnect stays
// real, since that is what the cycle has to get past (#472).
vi.mock('../../../src/ble/handler-node-ble/stale-link.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/stale-link.js')>();
  return {
    ...actual,
    staleLinkRecoveryDue: () => true,
    recoverStaleLink: record('recoverStaleLink', async () => {}),
    noteReadingForStaleLink: record('noteReadingForStaleLink'),
  };
});

vi.mock('../../../src/ble/handler-node-ble/broadcast.js', () => ({
  broadcastScanNodeBle: record('broadcastScanNodeBle', async (adapter: unknown) => ({
    reading: { weight: 80, impedance: 0 },
    adapter,
  })),
}));

/** The char map every buildCharMap returns; a test replaces it (#408). */
let charMapForTest: Map<string, unknown> = new Map();

vi.mock('../../../src/ble/handler-node-ble/gatt.js', () => ({
  buildCharMap: record('buildCharMap', async () => charMapForTest),
  wrapDevice: record('wrapDevice', () => ({ onDisconnect: () => {}, fireDisconnect: () => {} })),
  wrapChar: () => ({}),
}));

vi.mock('../../../src/ble/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/shared.js')>();
  return {
    ...actual,
    waitForRawReading: record('waitForRawReading', async () => {
      // One-shot gate: lets a test hold a cycle inside its reading phase while
      // another cycle runs (A-04).
      const gate = holdNextReading;
      holdNextReading = null;
      if (gate) await gate;
      return { reading: { weight: 80, impedance: 500 }, adapter: makeAdapter() };
    }),
    findMissingCharacteristics: record('findMissingCharacteristics', () => []),
  };
});

// The watchdog has its own tests over the BlueZ model. Here it only reports
// the restarts a test says it made and when it last heard the room, to check
// that scan.ts hands both to the failure classification.
let watchdogRestarts = 0;
/** When set, the watchdog last heard the room this many ms before the wait ended. */
let watchdogHeardAgoMs: number | undefined;
vi.mock('../../../src/ble/handler-node-ble/scan-watchdog.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/scan-watchdog.js')>();
  return {
    SCAN_HEARD_FRESH_MS: actual.SCAN_HEARD_FRESH_MS,
    withScanActivityWatchdog: async (
      _adapter: unknown,
      _signal: unknown,
      wait: () => Promise<unknown>,
      scanWatch?: { restarts: number; lastHeardAt?: number },
    ) => {
      try {
        return await wait();
      } finally {
        if (scanWatch) {
          scanWatch.restarts += watchdogRestarts;
          if (watchdogHeardAgoMs !== undefined) {
            scanWatch.lastHeardAt = Date.now() - watchdogHeardAgoMs;
          }
        }
      }
    },
    resetScanActivityBackoff: () => onBackoffReset?.(),
  };
});

/** Runs where a successful read resets the backoff, right before the disconnect. */
let onBackoffReset: (() => void) | undefined;

/** A scale adapter that claims everything, so resolveAdapter stays real. */
function makeAdapter(overrides: Partial<ScaleAdapter> = {}): ScaleAdapter {
  return {
    name: 'Fake QN',
    match: { priority: 10, serviceUuids: ['fff0'] },
    matches: () => true,
    parseNotification: () => null,
    isComplete: () => true,
    computeMetrics: () => ({}) as never,
    ...overrides,
  } as unknown as ScaleAdapter;
}

const { scanAndReadRaw } = await import('../../../src/ble/handler-node-ble/scan.js');
const { bleFailureKind } = await import('../../../src/ble/failure-kind.js');
const { StaleLinkError, PairingDeferredError } = await import('../../../src/ble/types.js');
const { _resetPairingBackoffForTests, pairingBackoff } =
  await import('../../../src/ble/handler-node-ble/pairing-backoff.js');
const { _resetAdapterPrivacyStateForTests } =
  await import('../../../src/ble/handler-node-ble/privacy.js');
const { _resetDeviceCacheForTests } =
  await import('../../../src/ble/handler-node-ble/device-cache.js');
const { applyForcedAdapter } = await import('../../../src/scales/force.js');
const { BeurerBf720Adapter } = await import('../../../src/scales/beurer-bf720.js');

describe('scanAndReadRaw call order (#368)', () => {
  beforeEach(() => {
    calls.length = 0;
    // A successful cycle writes the per-MAC memory (D060), so it would
    // otherwise depend on which test ran before.
    _resetDeviceCacheForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function run(extra: { preemptiveAdapterReset?: boolean } = {}): Promise<string[]> {
    const promise = scanAndReadRaw({
      targetMac: 'AA:BB:CC:DD:EE:FF',
      adapters: [makeAdapter()],
      profile: defaultProfile(),
      ...extra,
    });
    await vi.runAllTimersAsync();
    await promise;
    return calls;
  }

  it('snapshots the advertisement before discovery is stopped', async () => {
    // BlueZ throws the advertisement away with the discovery session, and for
    // some peers the whole Device1 object (#297). A dozen adapters that key on
    // a company id could never match on Linux without it (#280, #318).
    const seen = await run();
    expect(seen.indexOf('logAdvertisementSnapshot')).toBeLessThan(
      seen.indexOf('stopDiscoveryAndQuiesce'),
    );
  });

  it('stops discovery before connecting', async () => {
    // BlueZ on low-power hosts fails with le-connection-abort-by-local while
    // discovery is still running.
    const seen = await run();
    expect(seen.indexOf('stopDiscoveryAndQuiesce')).toBeLessThan(
      seen.indexOf('connectWithRecovery'),
    );
  });

  it('publishes the pairing target before the first getAdapter', async () => {
    // getAdapter is where the BlueZ agent registers, so the target has to be
    // in place first or an unrelated peer could be handed the consent PIN.
    const seen = await run();
    expect(seen.indexOf('setPairingTarget')).toBeLessThan(seen.indexOf('getAdapter'));
    expect(seen[0]).toBe('setPairingTarget');
  });

  // The agent now declines every request while no scale MAC is known (it used
  // to accept everything, handing the PIN to any device in range). In
  // auto-discovery there is no scale_mac, so the target must pick up the
  // address the scan matched, or the agent would decline the scale itself.
  it('points the pairing target at the discovered scale in auto-discovery', async () => {
    pairingTargets.length = 0;
    const promise = scanAndReadRaw({ adapters: [makeAdapter()], profile: defaultProfile() });
    await vi.runAllTimersAsync();
    await promise;
    expect(calls).toContain('autoDiscover');
    expect(pairingTargets.at(-1)?.().mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('evicts the cached device before starting discovery on the first cycle for a scale', async () => {
    // Until a reading shows which adapter the scale needs, a kept object could
    // be a broadcast scale's, carrying the last weigh-in's frame (D060).
    const seen = await run();
    expect(seen.indexOf('removeDevice')).toBeLessThan(seen.indexOf('startDiscoverySafe'));
    expect(seen.indexOf('startDiscoverySafe')).toBeLessThan(seen.indexOf('waitDevice'));
  });

  it('runs the whole sequence in the order the BlueZ workarounds require', async () => {
    const seen = await run();
    const ordered = [
      'setPairingTarget',
      'getAdapter',
      'isPowered',
      'removeDevice',
      'startDiscoverySafe',
      'waitDevice',
      'device.getName',
      'logAdvertisementSnapshot',
      'stopDiscoveryAndQuiesce',
      'connectWithRecovery',
      'gatt.services',
      'buildCharMap',
      'findMissingCharacteristics',
      'wrapDevice',
      'waitForRawReading',
    ];
    let at = -1;
    for (const step of ordered) {
      const next = seen.indexOf(step, at + 1);
      expect(next, `${step} out of order in [${seen.join(', ')}]`).toBeGreaterThan(at);
      at = next;
    }
  });

  it('acquires the GATT server twice and builds the char map twice', async () => {
    // Not redundant, and not to be deduplicated (review finding A-09 proposed
    // reusing the first server). node-ble's GattServer.init() snapshots the
    // services and characteristics once, and services(), getPrimaryService()
    // and characteristics() only ever read that snapshot back. The resolver
    // rebuilds it only when it has to retry, so on the normal path the second
    // acquire is the only point after the resolver where the D-Bus object tree
    // is enumerated again. Reusing the first server would hand the reading the
    // exact char map the resolver saw, and a characteristic BlueZ exported late
    // (bluez/bluez#1489) could never reach it. The two acquires also run with
    // different adapters for the #290 bond-on-timeout gate: the PRE-connect
    // match first, the resolved one second.
    const seen = await run();
    expect(seen.filter((c) => c === 'device.gatt')).toHaveLength(2);
    expect(seen.filter((c) => c === 'buildCharMap')).toHaveLength(2);
  });

  it('resets the D-Bus connection in the teardown', async () => {
    const seen = await run();
    expect(seen).toContain('resetConnection');
    expect(seen.indexOf('waitForRawReading')).toBeLessThan(seen.indexOf('resetConnection'));
  });

  it('power-cycles the adapter after the D-Bus reset by default', async () => {
    // The #80 zombie-discovery workaround: the D-Bus client goes first, then
    // the controller is power-cycled underneath it.
    const seen = await run();
    expect(seen.filter((c) => c === 'resetAdapterBtmgmt')).toHaveLength(1);
    expect(seen.indexOf('resetConnection')).toBeLessThan(seen.indexOf('resetAdapterBtmgmt'));
  });

  it('passes ble.preemptive_adapter_reset through to the teardown (#417)', async () => {
    const seen = await run({ preemptiveAdapterReset: false });
    expect(seen).toContain('resetConnection');
    expect(seen).not.toContain('resetAdapterBtmgmt');
  });

  it('leaves BlueZ alone when it ends after a newer cycle started (A-04)', async () => {
    // The poll loop abandons a cycle at POLL_CYCLE_TIMEOUT_MS but cannot stop
    // it, and starts the next one. When the abandoned one finally ends, its
    // teardown must not disconnect the shared device path, reset the shared
    // D-Bus connection or power-cycle the radio under the cycle now running.
    let release!: () => void;
    holdNextReading = new Promise<void>((r) => (release = r));
    const opts = {
      targetMac: 'AA:BB:CC:DD:EE:FF',
      adapters: [makeAdapter()],
      profile: defaultProfile(),
    };

    const abandoned = scanAndReadRaw(opts);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toContain('waitForRawReading');

    // Bounded advances, not runAllTimersAsync: that would also fire the held
    // cycle's 120 s reading timeout and turn this into a different scenario.
    const replacement = scanAndReadRaw(opts);
    await vi.advanceTimersByTimeAsync(5_000);
    await replacement;

    calls.length = 0;
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    await abandoned;

    expect(calls).not.toContain('device.disconnect');
    expect(calls).not.toContain('resetConnection');
    expect(calls).not.toContain('resetAdapterBtmgmt');
    expect(calls).not.toContain('removeDevice');
  });

  it('stands down mid-teardown when a newer cycle starts while it is aborted (A-04)', async () => {
    // The poll loop now aborts the cycle it gives up on, so its teardown starts
    // right away, before the next cycle exists. If the next cycle starts while
    // the teardown waits on BlueZ, everything after that wait acts on that
    // cycle's state. The Disconnect no longer holds an aborted teardown up
    // (#472), so the wait held here is the RemoveDevice after the failed read.
    holdNextReading = new Promise<void>(() => {});
    let releaseRemove!: () => void;
    const removeGate = new Promise<void>((r) => (releaseRemove = r));
    const opts = {
      targetMac: 'AA:BB:CC:DD:EE:FF',
      adapters: [makeAdapter()],
      profile: defaultProfile(),
    };
    const ctrl = new AbortController();
    const abandoned = scanAndReadRaw({ ...opts, abortSignal: ctrl.signal });
    void abandoned.catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toContain('waitForRawReading');

    // Armed only now, so the removal before this cycle's scan went through.
    holdNextRemoveDevice = removeGate;
    ctrl.abort(new Error('poll cycle abandoned'));
    await vi.advanceTimersByTimeAsync(100);
    expect(holdNextRemoveDevice).toBe(null);

    const replacement = scanAndReadRaw(opts);
    await vi.advanceTimersByTimeAsync(5_000);
    await replacement;

    calls.length = 0;
    releaseRemove();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(abandoned).rejects.toThrow(/abandoned/);

    expect(calls).not.toContain('removeDevice');
    expect(calls).not.toContain('resetConnection');
    expect(calls).not.toContain('resetAdapterBtmgmt');
  });

  it('ends the session when shut down mid-reading instead of waiting out the idle timeout (A-07)', async () => {
    // A held reading never completes, so only the abort can end this cycle
    // within the 5 s force-exit grace; the idle timeout would take 120 s.
    holdNextReading = new Promise<void>(() => {});
    const ctrl = new AbortController();
    let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
    scanAndReadRaw({
      targetMac: 'AA:BB:CC:DD:EE:FF',
      adapters: [makeAdapter()],
      profile: defaultProfile(),
      abortSignal: ctrl.signal,
    }).then(
      () => (settled = 'resolved'),
      () => (settled = 'rejected'),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toContain('waitForRawReading');

    ctrl.abort(new Error('shutdown'));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe('rejected');
    // The shutdown branch of the teardown ran: D-Bus reset, no power-cycle.
    expect(calls).toContain('resetConnection');
    expect(calls).not.toContain('resetAdapterBtmgmt');
  });

  it('disconnects on the success path and again in the finally', async () => {
    // Two calls, deliberately: the happy path disconnects as soon as the
    // reading lands, and the finally is a catch-all for every other exit.
    const seen = await run();
    expect(seen.filter((c) => c === 'device.disconnect')).toHaveLength(2);
  });
});

/** Settles to the state of `p` without ever throwing out of the test. */
function track<T>(p: Promise<T>): {
  state: () => 'pending' | 'resolved' | 'rejected';
  value: () => T | undefined;
} {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  let value: T | undefined;
  p.then(
    (v) => {
      state = 'resolved';
      value = v;
    },
    () => (state = 'rejected'),
  );
  return { state: () => state, value: () => value };
}

describe('scanAndReadRaw and a Disconnect BlueZ never answers (#472)', () => {
  const realDisconnect = fakeDevice.disconnect;

  beforeEach(() => {
    calls.length = 0;
    _resetDeviceCacheForTests();
    vi.useFakeTimers();
    fakeDevice.disconnect = async () => {
      calls.push('device.disconnect');
      await new Promise<void>(() => {});
    };
  });
  afterEach(() => {
    fakeDevice.disconnect = realDisconnect;
    delete (fakeDevice as unknown as { helper?: unknown }).helper;
    connectThrows = undefined;
    vi.useRealTimers();
  });

  const opts = () => ({
    targetMac: 'AA:BB:CC:DD:EE:FF',
    adapters: [makeAdapter()],
    profile: defaultProfile(),
  });

  it('returns the reading when the Disconnect after it is never answered', async () => {
    const result = track(scanAndReadRaw(opts()));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(result.state()).toBe('resolved');
    expect(result.value()?.reading.weight).toBe(80);
    // The reading lifts the brake; the stale link it left goes to the recovery.
    expect(calls).toContain('noteReadingForStaleLink');
    expect(calls).toContain('recoverStaleLink');
  });

  it('hands a stale link to the teardown', async () => {
    fakeDevice.disconnect = async () => {
      calls.push('device.disconnect');
    };
    connectThrows = () => new StaleLinkError('AA:BB:CC:DD:EE:FF');
    const result = track(scanAndReadRaw(opts()));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(result.state()).toBe('rejected');
    // connectWithRecovery already waited out one Disconnect; a second would
    // wait just as long for nothing.
    expect(calls).not.toContain('device.disconnect');
    expect(calls).toContain('recoverStaleLink');
    // No reading, so the brake stays where it is.
    expect(calls).not.toContain('noteReadingForStaleLink');
  });

  it('does not lift the brake on a broadcast reading, which never touches the link', async () => {
    fakeDevice.disconnect = async () => {
      calls.push('device.disconnect');
    };
    const result = track(
      scanAndReadRaw({
        ...opts(),
        adapters: [makeAdapter({ preferPassive: true, parseServiceData: () => null })],
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(result.state()).toBe('resolved');
    expect(calls).toContain('broadcastScanNodeBle');
    expect(calls).not.toContain('noteReadingForStaleLink');
  });

  it('does not lift the brake when the connect works but no reading follows', async () => {
    // With a stuck link BlueZ answers Connect at once from its own state, so
    // only a reading says the link is healthy again.
    fakeDevice.disconnect = async () => {
      calls.push('device.disconnect');
    };
    const realGatt = fakeDevice.gatt;
    fakeDevice.gatt = async () => {
      calls.push('device.gatt');
      throw new Error('GATT server acquisition timed out');
    };
    try {
      const result = track(scanAndReadRaw(opts()));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(result.state()).toBe('rejected');
      expect(calls).toContain('connectWithRecovery');
      expect(calls).not.toContain('noteReadingForStaleLink');
    } finally {
      fakeDevice.gatt = realGatt;
    }
  });

  it('every cycle ends and releases its device proxy while BlueZ never answers Disconnect', async () => {
    (fakeDevice as unknown as { helper: unknown }).helper = {
      removeListeners: () => calls.push('releaseDeviceProxy'),
    };
    for (let cycle = 1; cycle <= 3; cycle++) {
      calls.length = 0;
      const result = track(scanAndReadRaw(opts()));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(result.state(), `cycle ${cycle}`).toBe('resolved');
      expect(calls, `cycle ${cycle}`).toContain('releaseDeviceProxy');
    }
  });
});

describe('scanAndReadRaw after a connect retry replaced the D-Bus connection (#472)', () => {
  beforeEach(() => {
    calls.length = 0;
    removedThrough.length = 0;
    _resetDeviceCacheForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    onConnect = undefined;
    connectThrows = undefined;
    vi.useRealTimers();
  });

  it('tears down through the adapter and device the retry loop moved to', async () => {
    // The proxies the cycle started with belong to a bus nobody answers on any
    // more: a Disconnect through them read as a stale link, and a RemoveDevice
    // parked the teardown until the poll deadline.
    const live: string[] = [];
    const liveAdapter = {
      ...fakeAdapter,
      helper: {
        callMethod: async (method: string) => void live.push(`adapter ${method}`),
        object: '/org/bluez/hci0',
      },
    };
    const liveDevice = {
      ...fakeDevice,
      disconnect: async () => void live.push('device.disconnect'),
      helper: { removeListeners: () => live.push('device released') },
    };
    onConnect = () => {
      const ctx = connectContexts.at(-1) as {
        onLive?: (l: { btAdapter: unknown; device: unknown }) => void;
      };
      ctx.onLive?.({ btAdapter: liveAdapter, device: liveDevice });
    };
    connectThrows = () =>
      new Error('Connection failed after 6 attempts: le-connection-abort-by-local');

    const result = track(
      scanAndReadRaw({
        targetMac: 'AA:BB:CC:DD:EE:FF',
        adapters: [makeAdapter()],
        profile: defaultProfile(),
        preemptiveAdapterReset: false,
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(result.state()).toBe('rejected');
    expect(live).toEqual(['device.disconnect', 'device released']);
    expect(calls).not.toContain('device.disconnect');
    // The purge before the scan went through the cycle's own adapter, the one
    // after the failed GATT session through the live one.
    expect(removedThrough).toEqual([fakeAdapter, liveAdapter]);
    expect(calls).not.toContain('recoverStaleLink');
  });
});

describe('scanAndReadRaw bonds a single-bond scale with the option, and only that one (#408)', () => {
  beforeEach(() => {
    calls.length = 0;
    // A successful cycle writes the per-MAC memory (D060), so it would
    // otherwise depend on which test ran before.
    _resetDeviceCacheForTests();
    vi.useFakeTimers();
    // The bonded scale is already paired on entry (the kernel answered its
    // Security Request at connect), so ensureBonded only reads Bonded for it.
    (fakeDevice as unknown as { helper: unknown }).helper = {
      prop: async (name: string) => {
        calls.push(`prop ${name}`);
        return true;
      },
    };
  });
  afterEach(() => {
    delete (fakeDevice as unknown as { helper?: unknown }).helper;
    vi.useRealTimers();
  });

  async function runWith(adapter: ScaleAdapter): Promise<string[]> {
    const promise = scanAndReadRaw({
      targetMac: 'AA:BB:CC:DD:EE:FF',
      adapters: [adapter],
      profile: defaultProfile(),
    });
    await vi.runAllTimersAsync();
    await promise;
    return calls;
  }

  it('checks the bond of a singleBond adapter after connecting', async () => {
    const seen = await runWith(makeAdapter({ requiresBonding: true, singleBond: true }));
    expect(seen).toContain('prop Bonded');
    expect(seen.indexOf('prop Bonded')).toBeLessThan(seen.indexOf('waitForRawReading'));
  });

  it('bonds every other requiresBonding adapter exactly as before', async () => {
    const seen = await runWith(makeAdapter({ requiresBonding: true }));
    expect(seen).not.toContain('prop Bonded');
  });
});

describe('scanAndReadRaw turns a deferred binding off before disconnecting (#408)', () => {
  const WM = '00002a9d00001000800000805f9b34fb';
  const OTHER = '0000fff100001000800000805f9b34fb';
  const stoppable = (label: string) => ({
    subscribe: async () => () => {},
    write: async () => {},
    read: async () => Buffer.alloc(0),
    stop: async () => {
      calls.push(`stop ${label}`);
    },
  });

  beforeEach(() => {
    calls.length = 0;
    // A successful cycle writes the per-MAC memory (D060), so it would
    // otherwise depend on which test ran before.
    _resetDeviceCacheForTests();
    charMapForTest = new Map<string, unknown>([
      [WM, stoppable('2a9d')],
      [OTHER, stoppable('fff1')],
    ]);
    vi.useFakeTimers();
  });
  afterEach(() => {
    charMapForTest = new Map();
    onBackoffReset = undefined;
    vi.useRealTimers();
  });

  async function runWith(adapter: ScaleAdapter, signal?: AbortSignal): Promise<string[]> {
    const promise = scanAndReadRaw({
      targetMac: 'AA:BB:CC:DD:EE:FF',
      adapters: [adapter],
      profile: defaultProfile(),
      ...(signal ? { abortSignal: signal } : {}),
    });
    void promise.catch(() => {});
    await vi.runAllTimersAsync();
    await promise.catch(() => {});
    return calls;
  }

  const deferredAdapter = (): ScaleAdapter =>
    makeAdapter({
      characteristics: [
        { uuid: OTHER, type: 'notify' },
        { uuid: WM, type: 'notify', deferred: true },
      ],
      onConnected: async () => {},
    });

  it('sends StopNotify on the deferred binding, and only that one, before the disconnect', async () => {
    const seen = await runWith(deferredAdapter());
    expect(seen.filter((c) => c.startsWith('stop '))).toEqual(['stop 2a9d']);
    expect(seen.indexOf('stop 2a9d')).toBeGreaterThan(seen.indexOf('waitForRawReading'));
    expect(seen.indexOf('stop 2a9d')).toBeLessThan(seen.indexOf('device.disconnect'));
  });

  // Guard: every other adapter disconnects exactly as before.
  it('never sends StopNotify for an adapter without a deferred binding', async () => {
    const seen = await runWith(
      makeAdapter({ characteristics: [{ uuid: WM, type: 'notify' }], onConnected: async () => {} }),
    );
    expect(seen.filter((c) => c.startsWith('stop '))).toEqual([]);
    expect(seen).toContain('device.disconnect');
  });

  it('skips it when the app is shutting down', async () => {
    const ctrl = new AbortController();
    onBackoffReset = () => ctrl.abort(new Error('shutdown'));
    const seen = await runWith(deferredAdapter(), ctrl.signal);
    expect(seen).toContain('waitForRawReading');
    expect(seen.filter((c) => c.startsWith('stop '))).toEqual([]);
  });

  it('cuts the wait after the stop short when the app shuts down during it', async () => {
    const ctrl = new AbortController();
    let stoppedAt = -1;
    let disconnectedAt = -1;
    charMapForTest.set(WM, {
      ...stoppable('2a9d'),
      stop: async () => {
        calls.push('stop 2a9d');
        stoppedAt = Date.now();
        ctrl.abort(new Error('shutdown'));
      },
    });
    const realDisconnect = fakeDevice.disconnect;
    fakeDevice.disconnect = async () => {
      calls.push('device.disconnect');
      if (disconnectedAt < 0) disconnectedAt = Date.now();
    };
    try {
      await runWith(deferredAdapter(), ctrl.signal);
    } finally {
      fakeDevice.disconnect = realDisconnect;
    }
    expect(stoppedAt).toBeGreaterThanOrEqual(0);
    expect(disconnectedAt - stoppedAt).toBeLessThan(500);
  });

  it('leaves the link alone when a newer cycle starts during the stop (A-04)', async () => {
    // The stop and the wait after it take up to 2.5 s, and the poll loop may
    // give up on the cycle and start the next one on the same device path in
    // that time. A Disconnect from the old cycle would drop the new one's link.
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((r) => (releaseStop = r));
    charMapForTest.set(WM, {
      ...stoppable('2a9d'),
      stop: async () => {
        calls.push('stop 2a9d');
        await stopGate;
      },
    });
    const opts = { targetMac: 'AA:BB:CC:DD:EE:FF', profile: defaultProfile() };
    const abandoned = scanAndReadRaw({ ...opts, adapters: [deferredAdapter()] });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toContain('stop 2a9d');

    // Bounded advances: the stop's own 2 s timeout must not fire before the
    // newer cycle has started.
    const replacement = scanAndReadRaw({ ...opts, adapters: [makeAdapter()] });
    await vi.advanceTimersByTimeAsync(1_000);
    await replacement;

    calls.length = 0;
    releaseStop();
    await vi.advanceTimersByTimeAsync(5_000);
    await abandoned;
    expect(calls).not.toContain('device.disconnect');
  });
});

describe('scanAndReadRaw with ble.adapter_privacy (#417)', () => {
  const ORIG_PLATFORM = process.platform;
  const setPlatform = (p: string): void => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };

  beforeEach(() => {
    calls.length = 0;
    // A successful cycle writes the per-MAC memory (D060), so it would
    // otherwise depend on which test ran before.
    _resetDeviceCacheForTests();
    ctl = makeController();
    fakeAdapter.helper.object = '/org/bluez/hci0';
    connectContexts.length = 0;
    _resetAdapterPrivacyStateForTests();
    // btmgmt only runs on Linux; the CI matrix and a Windows checkout both run this.
    setPlatform('linux');
    // setImmediate stays real: privacy.ts reads /etc/bluetooth/main.conf, real
    // I/O that a fully faked loop would never let finish.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
  });
  afterEach(() => {
    setPlatform(ORIG_PLATFORM);
    fakeAdapter.helper.object = '/org/bluez/hci0';
    vi.useRealTimers();
  });

  async function runWith(extra: {
    adapterPrivacy?: boolean;
    targetMac?: string;
  }): Promise<string[]> {
    const promise = scanAndReadRaw({
      targetMac: 'AA:BB:CC:DD:EE:FF',
      adapters: [makeAdapter()],
      profile: defaultProfile(),
      ...extra,
    });
    let done = false;
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) {
      await vi.advanceTimersByTimeAsync(250);
      await new Promise((r) => setImmediate(r));
    }
    await promise;
    return calls;
  }

  it('enables privacy before discovery and checks it again right before the connect', async () => {
    const seen = await runWith({ adapterPrivacy: true });
    const privacyOn = seen.findIndex((c) => c.startsWith('btmgmt privacy on '));
    expect(privacyOn, `no privacy on in [${seen.join(', ')}]`).toBeGreaterThan(-1);
    expect(privacyOn).toBeLessThan(seen.indexOf('removeDevice'));
    expect(privacyOn).toBeLessThan(seen.indexOf('startDiscoverySafe'));
    // The power-cycle went under the D-Bus connection: reset it and take the
    // adapter again before anything else touches BlueZ. Both bounded by
    // removeDevice, since the teardown resets the connection again later.
    const removeAt = seen.indexOf('removeDevice');
    const reset = seen.indexOf('resetConnection', privacyOn);
    expect(reset).toBeGreaterThan(privacyOn);
    expect(reset).toBeLessThan(removeAt);
    const reacquire = seen.indexOf('getAdapter', reset);
    expect(reacquire).toBeGreaterThan(reset);
    expect(reacquire).toBeLessThan(removeAt);
    // connectWithRecovery re-checks before its own retries, so it needs the flag.
    expect(connectContexts.at(-1)?.adapterPrivacy).toBe(true);
    // One more read of the settings between stopping discovery and connecting.
    const stop = seen.indexOf('stopDiscoveryAndQuiesce');
    const connect = seen.indexOf('connectWithRecovery');
    expect(seen.indexOf('btmgmt info', stop)).toBeGreaterThan(stop);
    expect(seen.indexOf('btmgmt info', stop)).toBeLessThan(connect);
  });

  it('skips the connect when privacy is not on by then', async () => {
    // power off fails, so privacy is rejected while powered and never takes.
    ctl.powerOffFails = true;
    const err = await runWith({ adapterPrivacy: true }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/LE privacy is not active/);
    expect(bleFailureKind(err)).toBe('blocked');
    expect(calls).toContain('stopDiscoveryAndQuiesce');
    expect(calls).not.toContain('connectWithRecovery');
    expect(calls).not.toContain('device.gatt');
  });

  it('skips the connect in auto-discovery too', async () => {
    ctl.powerOffFails = true;
    const err = await runWith({ adapterPrivacy: true, targetMac: undefined }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/LE privacy is not active/);
    expect(calls).toContain('autoDiscover');
    expect(calls).not.toContain('connectWithRecovery');
    expect(calls).not.toContain('device.gatt');
  });

  it('runs btmgmt on the adapter BlueZ resolved, not on hci0 by default', async () => {
    // node-ble's defaultAdapter() is the first adapter under /org/bluez, which
    // need not be hci0 when ble.adapter is unset.
    fakeAdapter.helper.object = '/org/bluez/hci1';
    await runWith({ adapterPrivacy: true });
    expect(ctl.calls.length).toBeGreaterThan(0);
    for (const args of ctl.calls) expect(args.slice(0, 2)).toEqual(['--index', '1']);
  });

  it('does not run btmgmt at all without the option', async () => {
    const seen = await runWith({});
    expect(ctl.calls).toEqual([]);
    expect(seen).toContain('connectWithRecovery');
  });
});

describe('scanAndReadRaw hands what the watchdog saw to the failure classification', () => {
  const waitDevice = fakeAdapter.waitDevice;

  beforeEach(() => {
    calls.length = 0;
    // A successful cycle writes the per-MAC memory (D060), so it would
    // otherwise depend on which test ran before.
    _resetDeviceCacheForTests();
    watchdogRestarts = 0;
    vi.useFakeTimers();
    // The scale never shows up, and the fake adapter lists no devices, so the
    // liveness probe hears nothing.
    fakeAdapter.waitDevice = async () => {
      calls.push('waitDevice');
      throw new Error('Device not found within 120s');
    };
  });
  afterEach(() => {
    fakeAdapter.waitDevice = waitDevice;
    autoDiscoverFinds = true;
    watchdogHeardAgoMs = undefined;
    vi.useRealTimers();
  });

  /** A cycle that finds nothing: the MAC wait, or auto-discovery when `auto`. */
  async function failedCycle(auto = false): Promise<unknown> {
    autoDiscoverFinds = !auto;
    const promise = scanAndReadRaw({
      targetMac: auto ? undefined : 'AA:BB:CC:DD:EE:FF',
      adapters: [makeAdapter()],
      profile: defaultProfile(),
    }).catch((e: unknown) => e);
    let done = false;
    void promise.then(() => (done = true));
    while (!done) await vi.advanceTimersByTimeAsync(250);
    return promise;
  }

  it('drops the latch after a deaf cycle the watchdog did not restart', async () => {
    const err = await failedCycle();
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(calls).toContain('notifyDiscoveryStopped');
  });

  it('keeps the latch when the watchdog restarted the scan in this wait', async () => {
    watchdogRestarts = 1;
    const err = await failedCycle();
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(calls).not.toContain('notifyDiscoveryStopped');
  });

  it('drops the latch after a deaf auto-discovery the watchdog did not restart', async () => {
    const err = await failedCycle(true);
    expect(calls).toContain('autoDiscover');
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(calls).toContain('notifyDiscoveryStopped');
  });

  it('keeps the latch when the watchdog restarted the scan during auto-discovery', async () => {
    watchdogRestarts = 1;
    const err = await failedCycle(true);
    expect(calls).toContain('autoDiscover');
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(calls).not.toContain('notifyDiscoveryStopped');
  });

  it('calls a no-show idle when the watchdog heard the room shortly before the wait ended', async () => {
    // The probe hears nothing here (the fake adapter lists no devices), as on
    // the Pi between two report bursts; what the watchdog heard decides.
    watchdogHeardAgoMs = 4_000;
    const err = await failedCycle();
    expect(bleFailureKind(err)).toBe('idle');
    expect(calls).not.toContain('notifyDiscoveryStopped');
  });

  it('same for auto-discovery', async () => {
    watchdogHeardAgoMs = 4_000;
    const err = await failedCycle(true);
    expect(calls).toContain('autoDiscover');
    expect(bleFailureKind(err)).toBe('idle');
  });

  it('still probes when the watchdog last heard the room too long ago', async () => {
    watchdogHeardAgoMs = 40_000;
    const err = await failedCycle();
    expect(bleFailureKind(err)).toBe('wedge-suspect');
    expect(calls).toContain('notifyDiscoveryStopped');
  });
});

describe('scanAndReadRaw keeps a GATT-only scale in BlueZ between cycles (#425, D060)', () => {
  const MAC = 'AA:BB:CC:DD:EE:FF';
  const waitDevice = fakeAdapter.waitDevice;

  /**
   * The object BlueZ kept from the earlier cycle, as the latch sees it.
   * Not paired by default: a paired object takes the usual path and skips the
   * gate, so a test of the gate would pass without it.
   */
  let heldPaired = false;
  let heldMissing = false;
  let heldHelper: EventEmitter & { removeListeners: ReturnType<typeof vi.fn> };
  const heldDevice = {
    get helper() {
      return heldHelper;
    },
    isPaired: async () => heldPaired,
  };
  const withGetDevice = fakeAdapter as typeof fakeAdapter & {
    getDevice?: (mac: string) => Promise<unknown>;
  };

  /** A report from the scale while discovery starts, as BlueZ emits it. */
  const reportOnDiscoveryStart = (): void => {
    onDiscoveryStart = () => {
      heldHelper.emit('PropertiesChanged', { RSSI: { value: -60 } });
      return undefined;
    };
  };

  beforeEach(() => {
    calls.length = 0;
    _resetDeviceCacheForTests();
    vi.useFakeTimers();
    heldPaired = false;
    heldMissing = false;
    heldHelper = Object.assign(new EventEmitter(), { removeListeners: vi.fn() });
    withGetDevice.getDevice = async () => {
      calls.push('getDevice');
      if (heldMissing) throw new Error('Device not found');
      return heldDevice;
    };
  });
  afterEach(() => {
    delete withGetDevice.getDevice;
    fakeAdapter.waitDevice = waitDevice;
    onDiscoveryStart = undefined;
    scanFiltered = true;
    snapshotCompanyId = 0x0611;
    connectFails = false;
    watchdogHeardAgoMs = undefined;
    vi.useRealTimers();
  });

  /**
   * One cycle. Bounded, not runAllTimersAsync: a gate that waits instead of
   * passing must show up as a cycle still running after 5 s.
   */
  async function cycle(
    adapters: ScaleAdapter[],
    /** null: auto-discovery, no ble.scale_mac. */
    targetMac: string | null = MAC,
  ): Promise<{ done: boolean; result: unknown }> {
    let done = false;
    const promise = scanAndReadRaw({
      targetMac: targetMac ?? undefined,
      adapters,
      profile: defaultProfile(),
    }).then(
      (r) => r as unknown,
      (e: unknown) => e,
    );
    void promise.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(5_000);
    return { done, result: done ? await promise : undefined };
  }

  /** A first cycle that reads the scale, then a clean record for the second. */
  async function afterReading(adapters: ScaleAdapter[]): Promise<void> {
    const first = await cycle(adapters);
    expect(first.done).toBe(true);
    expect(first.result).not.toBeInstanceOf(Error);
    calls.length = 0;
  }

  const before = (a: string, b: string): boolean =>
    calls.indexOf(a) > -1 && calls.indexOf(a) < calls.indexOf(b);

  it('keeps the object after a GATT-only reading and hears the report from the scan start', async () => {
    const adapters = [makeAdapter()];
    await afterReading(adapters);
    reportOnDiscoveryStart();
    const second = await cycle(adapters);
    expect(second.done).toBe(true);
    expect((second.result as { reading?: unknown }).reading).toBeDefined();
    expect(before('getDevice', 'startDiscoverySafe')).toBe(true);
    expect(calls).not.toContain('removeDevice');
    expect(calls).toContain('connectWithRecovery');
    // The latch is released on this path too.
    expect(heldHelper.listenerCount('PropertiesChanged')).toBe(0);
    expect(heldHelper.removeListeners).toHaveBeenCalled();
  });

  it('still removes it after a broadcast reading', async () => {
    const adapters = [makeAdapter({ preferPassive: true, parseBroadcast: () => null })];
    await afterReading(adapters);
    await cycle(adapters);
    expect(before('removeDevice', 'startDiscoverySafe')).toBe(true);
    expect(calls).not.toContain('getDevice');
  });

  it('still removes it for an adapter that parses broadcasts but read over GATT', async () => {
    const adapters = [makeAdapter({ parseBroadcast: () => null })];
    await afterReading(adapters);
    await cycle(adapters);
    expect(before('removeDevice', 'startDiscoverySafe')).toBe(true);
    expect(calls).not.toContain('getDevice');
  });

  it('keeps it for a forced GATT-only adapter from the first cycle', async () => {
    reportOnDiscoveryStart();
    const first = await cycle(applyForcedAdapter([makeAdapter()], 'Fake QN'));
    expect(first.done).toBe(true);
    expect(before('getDevice', 'startDiscoverySafe')).toBe(true);
    expect(calls).not.toContain('removeDevice');
    expect(calls).toContain('connectWithRecovery');
  });

  it('still removes it for a forced adapter with a parser', async () => {
    await cycle(applyForcedAdapter([makeAdapter({ parseBroadcast: () => null })], 'Fake QN'));
    expect(before('removeDevice', 'startDiscoverySafe')).toBe(true);
    expect(calls).not.toContain('getDevice');
  });

  it('ends a kept object that never advertises as an idle no-show, without a connect', async () => {
    const adapters = [makeAdapter()];
    await afterReading(adapters);
    watchdogHeardAgoMs = 4_000;
    let settled: unknown;
    let done = false;
    void scanAndReadRaw({ targetMac: MAC, adapters, profile: defaultProfile() }).then(
      () => (done = true),
      (e: unknown) => {
        settled = e;
        done = true;
      },
    );
    await vi.advanceTimersByTimeAsync(119_000);
    expect(done).toBe(false);
    while (!done) await vi.advanceTimersByTimeAsync(250);
    expect((settled as Error).message).toBe(`Device ${MAC} not found within 120s`);
    expect(bleFailureKind(settled)).toBe('idle');
    expect(calls).not.toContain('connectWithRecovery');
    expect(calls).not.toContain('resetAdapterBtmgmt');
    expect(calls).not.toContain('removeDevice');
    // The latch is released on this path as well.
    expect(heldHelper.listenerCount('PropertiesChanged')).toBe(0);
    expect(heldHelper.removeListeners).toHaveBeenCalled();
  });

  it('removes it after the scan started when our filtered scan is not running', async () => {
    const adapters = [makeAdapter()];
    await afterReading(adapters);
    scanFiltered = false;
    const second = await cycle(adapters);
    expect(second.done).toBe(true);
    expect(before('startDiscoverySafe', 'removeDevice')).toBe(true);
    expect(before('removeDevice', 'waitDevice')).toBe(true);
    expect(heldHelper.listenerCount('PropertiesChanged')).toBe(0);
    expect(calls).toContain('connectWithRecovery');
  });

  it('removes it after the scan started when the D-Bus connection was replaced', async () => {
    const adapters = [makeAdapter()];
    await afterReading(adapters);
    const replaced = { ...fakeAdapter };
    onDiscoveryStart = () => replaced;
    const second = await cycle(adapters);
    expect(second.done).toBe(true);
    expect(before('startDiscoverySafe', 'removeDevice')).toBe(true);
    expect(before('removeDevice', 'waitDevice')).toBe(true);
    expect(heldHelper.listenerCount('PropertiesChanged')).toBe(0);
    expect(calls).toContain('connectWithRecovery');
  });

  /** G reads over GATT; P reads advertisements and claims only company 0x1234. */
  function gattAndPassive(): ScaleAdapter[] {
    type Seen = { manufacturerData?: { id: number } };
    const gatt = makeAdapter({
      name: 'G',
      matches: (d: Seen) => d.manufacturerData?.id !== 0x1234,
    } as unknown as Partial<ScaleAdapter>);
    const passive = makeAdapter({
      name: 'P',
      match: { priority: 20, serviceUuids: ['fff0'] },
      preferPassive: true,
      parseBroadcast: () => null,
      matches: (d: Seen) => d.manufacturerData?.id === 0x1234,
    } as unknown as Partial<ScaleAdapter>);
    return [gatt, passive];
  }

  it('never hands a kept object to the broadcast poll', async () => {
    const adapters = gattAndPassive();
    await afterReading(adapters);

    reportOnDiscoveryStart();
    snapshotCompanyId = 0x1234;
    await cycle(adapters);
    expect(calls.filter((c) => c === 'waitDevice')).toHaveLength(2);
    expect(calls.indexOf('removeDevice')).toBeGreaterThan(calls.indexOf('waitDevice'));
    expect(calls.indexOf('removeDevice')).toBeLessThan(calls.lastIndexOf('waitDevice'));
    expect(calls.lastIndexOf('waitDevice')).toBeLessThan(calls.indexOf('broadcastScanNodeBle'));

    // Forgotten, and P's reading is the memory now: removed before discovery.
    calls.length = 0;
    await cycle(adapters);
    expect(before('removeDevice', 'startDiscoverySafe')).toBe(true);
  });

  it('removes it again after a broadcast reading replaced a GATT-only one', async () => {
    // BlueZ no longer lists the scale, so P reads a fresh object and the
    // safety net above never runs: only the broadcast reading's own memory
    // write brings the removal back.
    const adapters = gattAndPassive();
    await afterReading(adapters);

    heldMissing = true;
    snapshotCompanyId = 0x1234;
    await cycle(adapters);
    expect(calls).toContain('broadcastScanNodeBle');
    expect(calls.filter((c) => c === 'waitDevice')).toHaveLength(1);

    calls.length = 0;
    await cycle(adapters);
    expect(before('removeDevice', 'startDiscoverySafe')).toBe(true);
    expect(calls).not.toContain('getDevice');
  });

  it('still removes it in the teardown after a failed GATT session', async () => {
    const adapters = [makeAdapter()];
    await afterReading(adapters);
    reportOnDiscoveryStart();
    connectFails = true;
    await cycle(adapters);
    expect(calls).toContain('connectWithRecovery');
    expect(calls.indexOf('connectWithRecovery')).toBeLessThan(calls.lastIndexOf('removeDevice'));
  });

  it('changes nothing in auto-discovery', async () => {
    const adapters = [makeAdapter()];
    await cycle(adapters, null);
    await cycle(adapters, null);
    expect(calls).toContain('autoDiscover');
    expect(calls).not.toContain('removeDevice');
    expect(calls).not.toContain('getDevice');
  });

  it('removes the object of a different MAC', async () => {
    const adapters = [makeAdapter()];
    await afterReading(adapters);
    await cycle(adapters, '11:22:33:44:55:66');
    expect(before('removeDevice', 'startDiscoverySafe')).toBe(true);
    expect(calls).not.toContain('getDevice');
  });

  it('waits as before when BlueZ no longer lists the scale', async () => {
    const adapters = [makeAdapter()];
    await afterReading(adapters);
    heldMissing = true;
    const second = await cycle(adapters);
    expect(second.done).toBe(true);
    expect(calls).toContain('getDevice');
    expect(calls).not.toContain('removeDevice');
    expect(calls).toContain('connectWithRecovery');
  });

  it('takes the usual path for a paired kept object', async () => {
    const adapters = [makeAdapter()];
    await afterReading(adapters);
    heldPaired = true;
    const second = await cycle(adapters);
    expect(second.done).toBe(true);
    expect(calls).toContain('getDevice');
    expect(calls).not.toContain('removeDevice');
    expect(calls).toContain('connectWithRecovery');
  });
});

describe('scanAndReadRaw after a pairing nobody confirmed (#471, D063)', () => {
  const MAC = 'AA:BB:CC:DD:EE:FF';
  const realGatt = fakeDevice.gatt;
  const realIsPaired = fakeDevice.isPaired;
  const realWaitDevice = fakeAdapter.waitDevice;
  /** What Device1.Paired answers. */
  let paired: boolean;
  /** GATT discovery times out, as on an unpaired BF915 (#290). */
  let gattTimesOut: boolean;
  let helper: EventEmitter & { removeListeners: ReturnType<typeof vi.fn> };

  const bonding = (): ScaleAdapter => makeAdapter({ requiresBonding: true });
  /** The adapter list a cycle in this block gets. */
  let cycleAdapter: () => ScaleAdapter = bonding;
  /** The scale asks for the pairing to be confirmed while we connect. */
  const promptOnConnect = (): void => {
    onConnect = () => prompts.set(promptKey(MAC), (prompts.get(promptKey(MAC)) ?? 0) + 1);
  };
  /** What a failed cycle writes, for tests that are not about writing it. */
  const seed = (failures = 1): void => {
    for (let i = 0; i < failures; i++) pairingBackoff().recordFailure(MAC, 'Fake QN', undefined);
  };

  beforeEach(() => {
    calls.length = 0;
    _resetDeviceCacheForTests();
    vi.useFakeTimers();
    _resetPairingBackoffForTests(() => Date.now());
    prompts.clear();
    onConnect = undefined;
    cycleAdapter = bonding;
    paired = false;
    gattTimesOut = true;
    // The scan heard the room, so a cycle that never connects is idle.
    watchdogHeardAgoMs = 4_000;
    helper = Object.assign(new EventEmitter(), {
      removeListeners: vi.fn(),
      prop: async () => undefined,
      set: async () => {},
      callMethod: async () => {},
    });
    (fakeDevice as unknown as { helper: unknown }).helper = helper;
    fakeDevice.isPaired = async () => paired;
    fakeDevice.gatt = async () => {
      calls.push('device.gatt');
      if (gattTimesOut) throw new Error('GATT server acquisition timed out');
      return fakeGatt;
    };
  });
  afterEach(() => {
    fakeDevice.gatt = realGatt;
    fakeDevice.isPaired = realIsPaired;
    fakeAdapter.waitDevice = realWaitDevice;
    delete (fakeDevice as unknown as { helper?: unknown }).helper;
    onConnect = undefined;
    autoDiscoverFinds = true;
    autoDiscoverAdapter = undefined;
    watchdogHeardAgoMs = undefined;
    snapshotServiceData = [];
    prompts.clear();
    vi.useRealTimers();
  });

  /** Start a cycle; `settled()` and `result()` follow it without ever throwing. */
  function start(
    extra: {
      targetMac?: string | null;
      abortSignal?: AbortSignal;
      pairingRetryMaxMin?: number;
    } = {},
  ) {
    let done = false;
    let result: unknown;
    const targetMac = extra.targetMac === null ? undefined : (extra.targetMac ?? MAC);
    void scanAndReadRaw({
      targetMac,
      adapters: [cycleAdapter()],
      profile: defaultProfile(),
      ...(extra.abortSignal ? { abortSignal: extra.abortSignal } : {}),
      ...(extra.pairingRetryMaxMin !== undefined
        ? { pairingRetryMaxMin: extra.pairingRetryMaxMin }
        : {}),
    }).then(
      (r) => {
        result = r;
        done = true;
      },
      (e: unknown) => {
        result = e;
        done = true;
      },
    );
    return { settled: () => done, result: () => result };
  }

  /** One whole cycle, held ones included (they listen for the discovery budget). */
  async function cycle(extra: Parameters<typeof start>[0] = {}): Promise<unknown> {
    const c = start(extra);
    for (let i = 0; i < 1_000 && !c.settled(); i++) await vi.advanceTimersByTimeAsync(250);
    expect(c.settled()).toBe(true);
    return c.result();
  }

  /** A cycle that connected, saw a pairing prompt, and got no reading. */
  async function unconfirmedCycle(extra: Parameters<typeof start>[0] = {}): Promise<void> {
    promptOnConnect();
    const result = await cycle(extra);
    expect(result).toBeInstanceOf(Error);
    onConnect = undefined;
    calls.length = 0;
  }

  it('does not connect again to the unpaired scale after an unconfirmed prompt', async () => {
    await unconfirmedCycle();
    const second = await cycle();
    expect(calls).not.toContain('connectWithRecovery');
    expect(second).toBeInstanceOf(PairingDeferredError);
    expect(bleFailureKind(second)).toBe('idle');
  });

  it('connects again once the first wait has passed', async () => {
    await unconfirmedCycle();
    await vi.advanceTimersByTimeAsync(60_000);
    gattTimesOut = false;
    const second = start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).not.toContain('connectWithRecovery');
    // Past the 2 minutes; the scale is heard again, so the connect goes.
    await vi.advanceTimersByTimeAsync(35_000);
    helper.emit('PropertiesChanged', { RSSI: { value: -70 } });
    for (let i = 0; i < 100 && !second.settled(); i++) await vi.advanceTimersByTimeAsync(250);
    expect(calls).toContain('connectWithRecovery');
    expect((second.result() as { reading?: unknown }).reading).toBeDefined();
  });

  it('a holding cycle makes no Disconnect call', async () => {
    await unconfirmedCycle();
    // The first cycle's teardown released it already; only the holding one counts.
    helper.removeListeners.mockClear();
    await cycle();
    expect(calls).not.toContain('device.disconnect');
    expect(calls).not.toContain('connectWithRecovery');
    // The proxy it never connected is handed back all the same (#396).
    expect(helper.removeListeners).toHaveBeenCalled();
  });

  it('holds back in auto-discovery too', async () => {
    autoDiscoverAdapter = bonding;
    await unconfirmedCycle({ targetMac: null });
    const second = await cycle({ targetMac: null });
    expect(calls).toContain('autoDiscover');
    expect(calls).not.toContain('connectWithRecovery');
    expect(second).toBeInstanceOf(PairingDeferredError);
  });

  it('ends a holding cycle on a deaf radio as wedge-suspect, not idle', async () => {
    seed();
    watchdogHeardAgoMs = undefined;
    const held = await cycle();
    expect(held).toBeInstanceOf(PairingDeferredError);
    expect(bleFailureKind(held)).toBe('wedge-suspect');
  });

  it('never waits past the discovery budget left in the cycle', async () => {
    seed(5);
    // The scale shows up 50 s into the cycle's 120 s discovery budget.
    fakeAdapter.waitDevice = async () => {
      calls.push('waitDevice');
      await new Promise((r) => setTimeout(r, 50_000));
      return fakeDevice;
    };
    const held = start();
    await vi.advanceTimersByTimeAsync(115_000);
    expect(held.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(held.settled()).toBe(true);
    expect(held.result()).toBeInstanceOf(PairingDeferredError);
  });

  it('connects at once to a scale that comes back after a cycle without it', async () => {
    await unconfirmedCycle();
    fakeAdapter.waitDevice = async () => {
      calls.push('waitDevice');
      throw new Error(`Device ${MAC} not found within 120s`);
    };
    await cycle();
    fakeAdapter.waitDevice = realWaitDevice;
    calls.length = 0;
    const back = start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toContain('connectWithRecovery');
    for (let i = 0; i < 1_000 && !back.settled(); i++) await vi.advanceTimersByTimeAsync(250);
  });

  it('connects at once in auto-discovery after a cycle that found no scale', async () => {
    autoDiscoverAdapter = bonding;
    await unconfirmedCycle({ targetMac: null });
    autoDiscoverFinds = false;
    await cycle({ targetMac: null });
    autoDiscoverFinds = true;
    calls.length = 0;
    const back = start({ targetMac: null });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toContain('connectWithRecovery');
    for (let i = 0; i < 1_000 && !back.settled(); i++) await vi.advanceTimersByTimeAsync(250);
  });

  it('never holds back a paired scale', async () => {
    seed();
    paired = true;
    gattTimesOut = false;
    const result = await cycle();
    expect(calls).toContain('connectWithRecovery');
    expect((result as { reading?: unknown }).reading).toBeDefined();
    expect(pairingBackoff().has(MAC)).toBe(false);
  });

  it('records nothing when no prompt came', async () => {
    const first = await cycle();
    expect(first).toBeInstanceOf(Error);
    calls.length = 0;
    const second = start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toContain('connectWithRecovery');
    for (let i = 0; i < 1_000 && !second.settled(); i++) await vi.advanceTimersByTimeAsync(250);
  });

  it('records nothing for a scale that does not need bonding', async () => {
    promptOnConnect();
    const adapters = [makeAdapter()];
    const run = async () => {
      const p = scanAndReadRaw({ targetMac: MAC, adapters, profile: defaultProfile() });
      void p.catch(() => {});
      await vi.advanceTimersByTimeAsync(200_000);
      return p.catch((e: unknown) => e);
    };
    expect(await run()).toBeInstanceOf(Error);
    expect(pairingBackoff().has(MAC)).toBe(false);
  });

  it('records nothing when the pairing completed late in the same cycle', async () => {
    promptOnConnect();
    // The second GATT attempt comes after the pairing timed out on our side;
    // somebody pressed SET in time for BlueZ.
    let gatts = 0;
    fakeDevice.gatt = async () => {
      calls.push('device.gatt');
      if (++gatts === 2) paired = true;
      throw new Error('GATT server acquisition timed out');
    };
    expect(await cycle()).toBeInstanceOf(Error);
    expect(pairingBackoff().has(MAC)).toBe(false);
    onConnect = undefined;
    calls.length = 0;
    const second = start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toContain('connectWithRecovery');
    for (let i = 0; i < 1_000 && !second.settled(); i++) await vi.advanceTimersByTimeAsync(250);
  });

  it('a reading clears the wait', async () => {
    await unconfirmedCycle();
    expect(pairingBackoff().has(MAC)).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    gattTimesOut = false;
    const result = await cycle();
    expect((result as { reading?: unknown }).reading).toBeDefined();
    expect(pairingBackoff().has(MAC)).toBe(false);
  });

  // The two 0x181D payloads #418 logged on a BF915, verbatim: `01` while a
  // weigh-in waits on the scale, an empty payload while none does.
  const SVC_181D = '0000181d-0000-1000-8000-00805f9b34fb';
  const NOTHING_WAITING = Buffer.alloc(0);
  const READING_WAITING = Buffer.from([0x01]);
  /** A bonding adapter with the BF720 hook, so the hint comes from the real code. */
  const bf720 = new BeurerBf720Adapter();
  const bondingWithHint = (): ScaleAdapter =>
    makeAdapter({
      requiresBonding: true,
      advertisesPendingReading: (d) => bf720.advertisesPendingReading(d),
    });

  it('pairs at once when 0x181D goes from empty to 01', async () => {
    cycleAdapter = bondingWithHint;
    snapshotServiceData = [{ uuid: SVC_181D, data: NOTHING_WAITING }];
    await unconfirmedCycle();
    const second = start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).not.toContain('connectWithRecovery');
    helper.emit('PropertiesChanged', {
      ServiceData: {
        signature: 'a{sv}',
        value: { [SVC_181D]: { signature: 'ay', value: READING_WAITING } },
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toContain('connectWithRecovery');
    for (let i = 0; i < 1_000 && !second.settled(); i++) await vi.advanceTimersByTimeAsync(250);
  });

  it('opens on the hint the attempt cycle saw', async () => {
    autoDiscoverAdapter = bondingWithHint;
    snapshotServiceData = [{ uuid: SVC_181D, data: NOTHING_WAITING }];
    await unconfirmedCycle({ targetMac: null });
    // Somebody weighed in between the two cycles.
    snapshotServiceData = [{ uuid: SVC_181D, data: READING_WAITING }];
    const second = start({ targetMac: null });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toContain('connectWithRecovery');
    for (let i = 0; i < 1_000 && !second.settled(); i++) await vi.advanceTimersByTimeAsync(250);
  });

  it('does not open on a 01 that was already up when the pairing failed', async () => {
    autoDiscoverAdapter = bondingWithHint;
    snapshotServiceData = [{ uuid: SVC_181D, data: READING_WAITING }];
    await unconfirmedCycle({ targetMac: null });
    const second = await cycle({ targetMac: null });
    expect(calls).not.toContain('connectWithRecovery');
    expect(second).toBeInstanceOf(PairingDeferredError);
  });

  it('a cycle that only listened does not count as another unconfirmed pairing', async () => {
    await unconfirmedCycle();
    expect(pairingBackoff().failures(MAC)).toBe(1);
    expect(await cycle()).toBeInstanceOf(PairingDeferredError);
    expect(pairingBackoff().failures(MAC)).toBe(1);
  });

  it('holds the next cycle while the weigh-in that opened a failed attempt still waits', async () => {
    cycleAdapter = bondingWithHint;
    snapshotServiceData = [{ uuid: SVC_181D, data: NOTHING_WAITING }];
    await unconfirmedCycle();
    promptOnConnect();
    const second = start();
    await vi.advanceTimersByTimeAsync(30_000);
    helper.emit('PropertiesChanged', {
      ServiceData: {
        signature: 'a{sv}',
        value: { [SVC_181D]: { signature: 'ay', value: READING_WAITING } },
      },
    });
    for (let i = 0; i < 1_000 && !second.settled(); i++) await vi.advanceTimersByTimeAsync(250);
    expect(calls).toContain('connectWithRecovery');
    expect(second.result()).toBeInstanceOf(Error);
    onConnect = undefined;
    calls.length = 0;
    // Nobody fetched it, so the flag is still up in the next snapshot.
    snapshotServiceData = [{ uuid: SVC_181D, data: READING_WAITING }];
    const third = await cycle();
    expect(calls).not.toContain('connectWithRecovery');
    expect(third).toBeInstanceOf(PairingDeferredError);
  });

  it('with ble.pairing_retry_max_min 0 the next cycle connects as before', async () => {
    await unconfirmedCycle({ pairingRetryMaxMin: 0 });
    // Nothing written, so no "not connecting to it again" line either, and
    // raising the cap later starts from a clean slate.
    expect(pairingBackoff().has(MAC)).toBe(false);
    const second = start({ pairingRetryMaxMin: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toContain('connectWithRecovery');
    for (let i = 0; i < 1_000 && !second.settled(); i++) await vi.advanceTimersByTimeAsync(250);
  });

  it('applies a lower ble.pairing_retry_max_min to the running wait', async () => {
    seed(8);
    const second = start({ pairingRetryMaxMin: 1 });
    await vi.advanceTimersByTimeAsync(61_000);
    helper.emit('PropertiesChanged', { RSSI: { value: -70 } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toContain('connectWithRecovery');
    for (let i = 0; i < 1_000 && !second.settled(); i++) await vi.advanceTimersByTimeAsync(250);
  });

  it('an abort during the wait does not connect', async () => {
    seed();
    const ctrl = new AbortController();
    const held = start({ abortSignal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(held.settled()).toBe(false);
    ctrl.abort(new Error('shutdown'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(held.settled()).toBe(true);
    expect((held.result() as Error).message).toBe('shutdown');
    expect(calls).not.toContain('connectWithRecovery');
    expect(helper.listenerCount('PropertiesChanged')).toBe(0);
  });
});
