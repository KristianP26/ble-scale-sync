import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Adapter, Device } from '../../src/ble/handler-node-ble/dbus.js';

const removeDevice = vi.fn(async () => undefined);

vi.mock('../../src/ble/handler-node-ble/discovery.js', () => ({
  removeDevice: (...args: unknown[]) => removeDevice(...(args as [])),
  startDiscoverySafe: vi.fn(async () => undefined),
  stopDiscoveryAndQuiesce: vi.fn(async () => undefined),
}));

vi.mock('../../src/ble/handler-node-ble/freshness.js', () => ({
  startPeerFreshnessTracker: () => ({ stop: () => {}, isFresh: async () => true }),
}));

vi.mock('../../src/ble/handler-node-ble/device-object.js', () => ({
  isDeviceObjectGone: () => false,
}));

const { connectWithRecovery } = await import('../../src/ble/handler-node-ble/connect.js');

const MAC = 'AA:BB:CC:DD:EE:FF';

/**
 * A peer that rejects the stored key on every connect, which is what a scale
 * that has forgotten its half of the pairing looks like from BlueZ (#335).
 */
function makeDevice(opts: { paired: boolean }): Device {
  return {
    connect: vi.fn(async () => {
      throw new Error('le-connection-abort-by-local');
    }),
    disconnect: vi.fn(async () => undefined),
    isPaired: vi.fn(async () => opts.paired),
  } as unknown as Device;
}

function makeAdapter(device: Device): Adapter {
  return {
    waitDevice: vi.fn(async () => device),
    getDevice: vi.fn(async () => device),
  } as unknown as Adapter;
}

async function run(opts: { paired: boolean; autoClear?: boolean }): Promise<string> {
  const device = makeDevice(opts);
  const btAdapter = makeAdapter(device);
  try {
    await connectWithRecovery({
      btAdapter,
      mac: MAC,
      initialDevice: device,
      maxRetries: 4,
      ...(opts.autoClear === undefined ? {} : { autoClearStaleBond: opts.autoClear }),
    });
    return 'connected';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('stale-bond recovery (#335)', () => {
  beforeEach(() => {
    removeDevice.mockClear();
    vi.useFakeTimers();
  });

  /** Drive the retry loop, whose backoff sleeps on real timers. */
  async function drive(p: Promise<string>): Promise<string> {
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(1000);
    return p;
  }

  it('leaves the bond alone by default and reports the diagnosis', async () => {
    const msg = await drive(run({ paired: true }));
    expect(msg).toContain('rejected the stored pairing key');
    for (const call of removeDevice.mock.calls) {
      expect((call as unknown[])[2]).toEqual({ includeBonded: false });
    }
  });

  it('clears the bond once when the opt-in is set and the peer is bonded', async () => {
    await drive(run({ paired: true, autoClear: true }));
    const clearing = removeDevice.mock.calls.filter(
      (c) => ((c as unknown[])[2] as { includeBonded?: boolean })?.includeBonded === true,
    );
    // Exactly one: re-clearing would delete the bond the previous attempt just
    // established and turn a slow re-pair into an endless one.
    expect(clearing).toHaveLength(1);
  });

  it('never clears the bond of a peer BlueZ does not list as paired', async () => {
    await drive(run({ paired: false, autoClear: true }));
    for (const call of removeDevice.mock.calls) {
      expect(((call as unknown[])[2] as { includeBonded?: boolean }).includeBonded).toBe(false);
    }
  });
});
