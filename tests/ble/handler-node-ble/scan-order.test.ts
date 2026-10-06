import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

/** When set, the next waitForRawReading waits for it. */
let holdNextReading: Promise<void> | null = null;

/** Every provider handed to setPairingTarget, newest last. */
const pairingTargets: (() => { pin?: number; mac?: string })[] = [];

/** Every context handed to connectWithRecovery, newest last. */
const connectContexts: { adapterPrivacy?: boolean }[] = [];

vi.mock('../../../src/ble/handler-node-ble/agent.js', () => ({
  setPairingTarget: record('setPairingTarget', (p: () => { pin?: number; mac?: string }) => {
    pairingTargets.push(p);
  }),
  ensurePairingAgent: record('ensurePairingAgent', async () => {}),
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

vi.mock('../../../src/ble/handler-node-ble/discovery.js', () => ({
  startDiscoverySafe: record('startDiscoverySafe', async () => undefined),
  removeDevice: record('removeDevice', async () => {}),
  stopDiscoveryAndQuiesce: record('stopDiscoveryAndQuiesce', async () => {}),
  notifyDiscoveryStopped: record('notifyDiscoveryStopped'),
  autoDiscover: record('autoDiscover', async () => {
    if (autoDiscoverFinds === false) throw new Error('No recognized scale found within 120s');
    return { device: fakeDevice, adapter: makeAdapter(), mac: 'AA:BB:CC:DD:EE:FF' };
  }),
}));

vi.mock('../../../src/ble/handler-node-ble/device-object.js', () => ({
  logAdvertisementSnapshot: record('logAdvertisementSnapshot', async () => ({
    manufacturerData: { id: 0x0611, data: Buffer.alloc(0) },
    serviceData: [],
  })),
  isDeviceObjectGone: () => false,
}));

vi.mock('../../../src/ble/handler-node-ble/connect.js', () => ({
  connectWithRecovery: record('connectWithRecovery', async (ctx: unknown) => {
    connectContexts.push(ctx as { adapterPrivacy?: boolean });
    return fakeDevice;
  }),
}));

vi.mock('../../../src/ble/handler-node-ble/gatt.js', () => ({
  buildCharMap: record('buildCharMap', async () => new Map()),
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
    resetScanActivityBackoff: () => {},
  };
});

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
const { _resetAdapterPrivacyStateForTests } =
  await import('../../../src/ble/handler-node-ble/privacy.js');

describe('scanAndReadRaw call order (#368)', () => {
  beforeEach(() => {
    calls.length = 0;
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

  it('evicts the cached device before starting discovery', async () => {
    // In continuous mode BlueZ hands back the previous cycle's Device1 unless
    // it is removed, so the proxy is stale from the first frame.
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
    // right away, before the next cycle exists. The first await there (the
    // disconnect) is a D-Bus call with no deadline; if the next cycle starts
    // while it is parked, everything after it acts on that cycle's state.
    holdNextReading = new Promise<void>(() => {});
    let releaseDisconnect!: () => void;
    const disconnectGate = new Promise<void>((r) => (releaseDisconnect = r));
    const realDisconnect = fakeDevice.disconnect;
    let gateUsed = false;
    fakeDevice.disconnect = async () => {
      calls.push('device.disconnect');
      if (!gateUsed) {
        gateUsed = true;
        await disconnectGate;
      }
    };
    const opts = {
      targetMac: 'AA:BB:CC:DD:EE:FF',
      adapters: [makeAdapter()],
      profile: defaultProfile(),
    };
    try {
      const ctrl = new AbortController();
      const abandoned = scanAndReadRaw({ ...opts, abortSignal: ctrl.signal });
      void abandoned.catch(() => {});
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toContain('waitForRawReading');

      ctrl.abort(new Error('poll cycle abandoned'));
      await vi.advanceTimersByTimeAsync(100);
      expect(gateUsed).toBe(true);

      const replacement = scanAndReadRaw(opts);
      await vi.advanceTimersByTimeAsync(5_000);
      await replacement;

      calls.length = 0;
      releaseDisconnect();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(abandoned).rejects.toThrow(/abandoned/);

      expect(calls).not.toContain('removeDevice');
      expect(calls).not.toContain('resetConnection');
      expect(calls).not.toContain('resetAdapterBtmgmt');
    } finally {
      fakeDevice.disconnect = realDisconnect;
    }
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

describe('scanAndReadRaw with ble.adapter_privacy (#417)', () => {
  const ORIG_PLATFORM = process.platform;
  const setPlatform = (p: string): void => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };

  beforeEach(() => {
    calls.length = 0;
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
