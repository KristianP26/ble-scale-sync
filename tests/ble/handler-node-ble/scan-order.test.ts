import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ScaleAdapter } from '../../../src/interfaces/scale-adapter.js';
import { defaultProfile } from '../../helpers/scale-test-utils.js';

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

const fakeAdapter = {
  isPowered: async () => {
    calls.push('isPowered');
    return true;
  },
  waitDevice: async () => {
    calls.push('waitDevice');
    return fakeDevice;
  },
  helper: { callMethod: async () => {} },
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

/** When set, the next waitForRawReading waits for it. */
let holdNextReading: Promise<void> | null = null;

/** Every provider handed to setPairingTarget, newest last. */
const pairingTargets: (() => { pin?: number; mac?: string })[] = [];

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
  autoDiscover: record('autoDiscover', async () => ({
    device: fakeDevice,
    adapter: makeAdapter(),
    mac: 'AA:BB:CC:DD:EE:FF',
  })),
}));

vi.mock('../../../src/ble/handler-node-ble/device-object.js', () => ({
  logAdvertisementSnapshot: record('logAdvertisementSnapshot', async () => ({
    manufacturerData: { id: 0x0611, data: Buffer.alloc(0) },
    serviceData: [],
  })),
  isDeviceObjectGone: () => false,
}));

vi.mock('../../../src/ble/handler-node-ble/connect.js', () => ({
  connectWithRecovery: record('connectWithRecovery', async () => fakeDevice),
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
