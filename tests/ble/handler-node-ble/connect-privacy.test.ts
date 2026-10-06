import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Adapter, Device } from '../../../src/ble/handler-node-ble/dbus.js';

/**
 * `ble.adapter_privacy` inside connectWithRecovery (#417). scan.ts checks
 * privacy right before handing over, but every retry and the RSSI
 * re-discovery go through startDiscoverySafe, whose last tier restarts
 * bluetoothd. If putting privacy back after that was throttled or failed, the
 * next connect would pair without the host IdKey, which is the bond the scale
 * throws away.
 */

const calls: string[] = [];
let privacyActive = true;
let fresh: boolean[] = [];
/** How many of the next startDiscoverySafe calls throw. */
let discoveryThrows = 0;

vi.mock('../../../src/ble/handler-node-ble/discovery.js', () => ({
  removeDevice: async () => {
    calls.push('removeDevice');
  },
  startDiscoverySafe: async () => {
    calls.push('startDiscoverySafe');
    if (discoveryThrows > 0) {
      discoveryThrows--;
      // The bluetoothd restart tier may already have run when it gives up.
      throw new Error('Discovery failed after restarting bluetoothd');
    }
    return undefined;
  },
  stopDiscoveryAndQuiesce: async () => {
    calls.push('stopDiscoveryAndQuiesce');
  },
  notifyDiscoveryStopped: () => {},
}));

vi.mock('../../../src/ble/handler-node-ble/freshness.js', () => ({
  startPeerFreshnessTracker: () => ({
    stop: () => {},
    isFresh: async () => fresh.shift() ?? true,
  }),
}));

vi.mock('../../../src/ble/handler-node-ble/device-object.js', () => ({
  isDeviceObjectGone: () => false,
}));

vi.mock('../../../src/ble/handler-node-ble/privacy.js', async () => {
  const { tagBleFailure } = await import('../../../src/ble/failure-kind.js');
  return {
    requireAdapterPrivacy: async () => {
      calls.push('requireAdapterPrivacy');
      if (!privacyActive) {
        throw tagBleFailure(new Error('LE privacy is not active on hci0'), 'blocked');
      }
    },
  };
});

const { connectWithRecovery } = await import('../../../src/ble/handler-node-ble/connect.js');
const { bleFailureKind } = await import('../../../src/ble/failure-kind.js');

/** A device whose connects fail `failures` times, then succeed. */
function makeDevice(failures: number): Device {
  let left = failures;
  return {
    connect: vi.fn(async () => {
      calls.push('device.connect');
      if (left-- > 0) throw new Error('Connection timed out');
    }),
    disconnect: vi.fn(async () => undefined),
    isPaired: vi.fn(async () => true),
  } as unknown as Device;
}

function makeAdapter(device: Device): Adapter {
  return {
    waitDevice: vi.fn(async () => device),
    getDevice: vi.fn(async () => device),
    stopDiscovery: vi.fn(async () => undefined),
  } as unknown as Adapter;
}

async function run(device: Device, adapterPrivacy: boolean): Promise<unknown> {
  const p = connectWithRecovery({
    btAdapter: makeAdapter(device),
    mac: 'AA:BB:CC:DD:EE:FF',
    initialDevice: device,
    maxRetries: 3,
    adapterPrivacy,
  }).then(
    () => 'connected',
    (e: unknown) => e,
  );
  // The retry backoff and the post-discovery quiesce sleep on timers.
  for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(1000);
  return p;
}

describe('connectWithRecovery with ble.adapter_privacy (#417)', () => {
  beforeEach(() => {
    calls.length = 0;
    privacyActive = true;
    fresh = [];
    discoveryThrows = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks privacy again before a retry connect, after the re-discovery', async () => {
    expect(await run(makeDevice(1), true)).toBe('connected');
    const connects = calls.flatMap((c, i) => (c === 'device.connect' ? [i] : []));
    expect(connects).toHaveLength(2);
    const check = calls.indexOf('requireAdapterPrivacy');
    expect(check).toBeGreaterThan(calls.indexOf('startDiscoverySafe'));
    expect(check).toBeLessThan(connects[1]);
  });

  it('still checks before the retry connect when the re-discovery threw and getDevice took over', async () => {
    discoveryThrows = 1;
    const device = makeDevice(1);
    const adapter = makeAdapter(device);
    const p = connectWithRecovery({
      btAdapter: adapter,
      mac: 'AA:BB:CC:DD:EE:FF',
      initialDevice: device,
      maxRetries: 3,
      adapterPrivacy: true,
    }).then(
      () => 'connected',
      (e: unknown) => e,
    );
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe('connected');
    // The fallback path really ran: no waitDevice, the device came from getDevice.
    expect(adapter.getDevice).toHaveBeenCalledTimes(1);
    expect(adapter.waitDevice).not.toHaveBeenCalled();
    const connects = calls.flatMap((c, i) => (c === 'device.connect' ? [i] : []));
    expect(connects).toHaveLength(2);
    const check = calls.indexOf('requireAdapterPrivacy');
    expect(check).toBeGreaterThan(calls.indexOf('startDiscoverySafe'));
    expect(check).toBeLessThan(connects[1]);
  });

  it('stops at the check, without connecting or retrying, when privacy is gone', async () => {
    const device = makeDevice(1);
    privacyActive = false;
    const err = await run(device, true);
    expect(bleFailureKind(err)).toBe('blocked');
    expect((err as Error).message).toMatch(/LE privacy is not active/);
    expect(device.connect).toHaveBeenCalledTimes(1);
    // Nothing after the refused check: no further removeDevice or rediscovery.
    expect(calls.at(-1)).toBe('requireAdapterPrivacy');
  });

  it('checks before the connect that follows an RSSI re-discovery', async () => {
    fresh = [false, true];
    expect(await run(makeDevice(0), true)).toBe('connected');
    const check = calls.indexOf('requireAdapterPrivacy');
    expect(check).toBeGreaterThan(calls.indexOf('startDiscoverySafe'));
    expect(check).toBeLessThan(calls.indexOf('device.connect'));
  });

  it('never checks without the option', async () => {
    expect(await run(makeDevice(2), false)).toBe('connected');
    expect(calls).not.toContain('requireAdapterPrivacy');
  });
});
