import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ScaleAdapter } from '../../../src/interfaces/scale-adapter.js';
import { defaultProfile } from '../../helpers/scale-test-utils.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

vi.mock('dbus-next', () => ({
  Variant: class {},
  interface: {
    Interface: class {
      constructor(_name?: string) {}
      static configureMembers(): void {}
    },
    ACCESS_READWRITE: 'readwrite',
  },
  DBusError: class extends Error {},
}));

vi.mock('node-ble', () => ({ default: { createBluetooth: vi.fn() } }));

// A reading that never completes, so the only way out is the abort (or the
// 120 s idle timeout, which is exactly what these tests must not wait for).
vi.mock('../../../src/ble/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/shared.js')>();
  return { ...actual, waitForRawReading: vi.fn(() => new Promise(() => {})) };
});

const { _internals } = await import('../../../src/ble/handler-node-ble/index.js');
const { readWithTimeouts } = await import('../../../src/ble/handler-node-ble/scan-stages.js');
const { acquireGattServer } = await import('../../../src/ble/handler-node-ble/scan.js');

type Helper = EventEmitter & {
  prop: ReturnType<typeof vi.fn>;
  callMethod: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  removeListeners: ReturnType<typeof vi.fn>;
  object: string;
};

function makeHelper(object: string): Helper {
  const h = new EventEmitter() as Helper;
  h.prop = vi.fn(async (name: string) => (name === 'RSSI' ? -55 : undefined));
  h.callMethod = vi.fn(async () => undefined);
  h.set = vi.fn(async () => undefined);
  h.removeListeners = vi.fn();
  h.object = object;
  return h;
}

/** Settles to the state of `p` without ever throwing out of the test. */
function track(p: Promise<unknown>): { state: () => 'pending' | 'resolved' | 'rejected' } {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  p.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  );
  return { state: () => state };
}

/**
 * A-07. A shutdown arriving while a session is in its connect, GATT discovery
 * or reading phase was seen by nothing: the shutdown waited on a 30 s connect
 * timeout, a 30 s GATT timeout or a 120 s reading idle timeout, the 5 s
 * force-exit fired first, and teardownSession never ran, leaving the LE link to
 * the scale up.
 */
describe('node-ble session honours the abort signal (A-07)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connectWithRecovery stops waiting on a hung connect when aborted', async () => {
    const device = {
      helper: makeHelper('/org/bluez/hci0/dev_AA'),
      connect: vi.fn(() => new Promise<void>(() => {})),
      disconnect: vi.fn(async () => undefined),
    };
    const btAdapter = {
      helper: makeHelper('/org/bluez/hci0'),
      waitDevice: vi.fn(async () => device),
      getDevice: vi.fn(async () => device),
      stopDiscovery: vi.fn(async () => undefined),
    };
    const ctrl = new AbortController();
    const result = track(
      _internals.connectWithRecovery({
        btAdapter: btAdapter as never,
        mac: 'AA:BB:CC:DD:EE:FF',
        initialDevice: device as never,
        maxRetries: 5,
        abortSignal: ctrl.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(device.connect).toHaveBeenCalledTimes(1);
    expect(result.state()).toBe('pending');

    ctrl.abort(new Error('shutdown'));
    await vi.advanceTimersByTimeAsync(10);
    expect(result.state()).toBe('rejected');
    // No retry was started after the abort.
    expect(device.connect).toHaveBeenCalledTimes(1);
  });

  it('acquireGattServer stops waiting on a hung GATT resolution when aborted', async () => {
    const device = { gatt: vi.fn(() => new Promise(() => {})) };
    const ctrl = new AbortController();
    const result = track(
      acquireGattServer(device as never, undefined, undefined, undefined, ctrl.signal),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.state()).toBe('pending');

    ctrl.abort(new Error('shutdown'));
    await vi.advanceTimersByTimeAsync(10);
    expect(result.state()).toBe('rejected');
  });

  it('readWithTimeouts ends the reading and fires the disconnect when aborted', async () => {
    const fireDisconnect = vi.fn();
    const bleDevice = { onDisconnect: () => {}, fireDisconnect };
    const ctrl = new AbortController();
    const result = track(
      readWithTimeouts(new Map(), bleDevice as never, {} as ScaleAdapter, 'AA:BB:CC:DD:EE:FF', {
        profile: defaultProfile(),
        abortSignal: ctrl.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.state()).toBe('pending');

    ctrl.abort(new Error('shutdown'));
    await vi.advanceTimersByTimeAsync(10);
    expect(result.state()).toBe('rejected');
    // The abandoned waitForRawReading is driven to its own cleanup the same
    // way a timeout drives it.
    expect(fireDisconnect).toHaveBeenCalledTimes(1);
  });
});
