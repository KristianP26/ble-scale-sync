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

vi.mock('../../../src/ble/handler-node-ble/agent.js', () => ({
  setPairingTarget: record('setPairingTarget'),
  registerPairingAgent: record('registerPairingAgent', async () => {}),
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

vi.mock('../../../src/ble/handler-node-ble/discovery.js', () => ({
  startDiscoverySafe: record('startDiscoverySafe', async () => undefined),
  removeDevice: record('removeDevice', async () => {}),
  stopDiscoveryAndQuiesce: record('stopDiscoveryAndQuiesce', async () => {}),
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
  wrapDevice: record('wrapDevice', () => ({ onDisconnect: () => {} })),
  wrapChar: () => ({}),
}));

vi.mock('../../../src/ble/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/shared.js')>();
  return {
    ...actual,
    waitForRawReading: record('waitForRawReading', async () => ({
      reading: { weight: 80, impedance: 500 },
      adapter: makeAdapter(),
    })),
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

  async function run(): Promise<string[]> {
    const promise = scanAndReadRaw({
      targetMac: 'AA:BB:CC:DD:EE:FF',
      adapters: [makeAdapter()],
      profile: defaultProfile(),
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
    // Not redundant, and not to be deduplicated. The first acquire runs with
    // the PRE-connect adapter and the second with the resolved one, and their
    // requiresBonding can differ: that difference is the #290 bond-on-timeout
    // gate. The first char map disambiguates adapters that share a vendor
    // service, the second is the one the reading uses.
    const seen = await run();
    expect(seen.filter((c) => c === 'device.gatt')).toHaveLength(2);
    expect(seen.filter((c) => c === 'buildCharMap')).toHaveLength(2);
  });

  it('resets the D-Bus connection in the teardown', async () => {
    const seen = await run();
    expect(seen).toContain('resetConnection');
    expect(seen.indexOf('waitForRawReading')).toBeLessThan(seen.indexOf('resetConnection'));
  });

  it('disconnects on the success path and again in the finally', async () => {
    // Two calls, deliberately: the happy path disconnects as soon as the
    // reading lands, and the finally is a catch-all for every other exit.
    const seen = await run();
    expect(seen.filter((c) => c === 'device.disconnect')).toHaveLength(2);
  });
});
