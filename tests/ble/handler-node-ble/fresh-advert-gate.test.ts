import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Adapter } from '../../../src/ble/handler-node-ble/dbus.js';

/**
 * The gate a kept BlueZ object has to pass in waitForTargetDevice (#425, D060).
 *
 * waitDevice() only polls for the object's path, so on an object BlueZ kept
 * from an earlier cycle it returns at once, scale awake or not. The wait may
 * hand the device on only once the latch heard a report, within the same
 * 120 s budget and with the same no-show message as before.
 */

vi.spyOn(console, 'log').mockImplementation(() => {});

/** When the watchdog-wrapped wait settled, relative to the test's start. */
let waitEndedAt: number | undefined;
vi.mock('../../../src/ble/handler-node-ble/scan-watchdog.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/scan-watchdog.js')>();
  return {
    ...actual,
    withScanActivityWatchdog: async (
      _adapter: unknown,
      _signal: unknown,
      wait: () => Promise<unknown>,
    ) => {
      try {
        return await wait();
      } finally {
        waitEndedAt = Date.now();
      }
    },
  };
});

const { waitForTargetDevice } = await import('../../../src/ble/handler-node-ble/scan-stages.js');
const { armFreshAdvertLatch } = await import('../../../src/ble/handler-node-ble/device-cache.js');

const MAC = 'AA:BB:CC:DD:EE:FF';

/** The proxy waitDevice hands back. */
function waitedDevice() {
  return { helper: { removeListeners: vi.fn() } };
}

/** The kept object the latch listens on. */
function keptDevice() {
  return {
    helper: Object.assign(new EventEmitter(), { removeListeners: vi.fn() }),
    isPaired: async () => false,
  };
}

function fakeAdapter(waited: unknown, kept: unknown, waitMs: number): Adapter {
  return {
    getDevice: async () => kept,
    waitDevice: () => new Promise((r) => setTimeout(() => r(waited), waitMs)),
    devices: async () => [],
  } as unknown as Adapter;
}

async function latchOn(btAdapter: Adapter) {
  const held = await armFreshAdvertLatch(btAdapter, MAC);
  if (held.kind !== 'armed') throw new Error(`expected armed, got ${held.kind}`);
  return held.latch;
}

describe('waitForTargetDevice with a kept object (D060)', () => {
  let start = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    start = Date.now();
    waitEndedAt = undefined;
  });
  afterEach(() => vi.useRealTimers());

  it('ends a kept object that never advertises as a no-show, within the one 120 s budget', async () => {
    const waited = waitedDevice();
    const btAdapter = fakeAdapter(waited, keptDevice(), 100_000);
    const latch = await latchOn(btAdapter);
    let settledAt: number | undefined;
    const result = waitForTargetDevice(btAdapter, MAC, undefined, undefined, latch).catch(
      (e: unknown) => {
        settledAt = Date.now() - start;
        return e;
      },
    );
    await vi.advanceTimersByTimeAsync(119_000);
    expect(settledAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(((await result) as Error).message).toBe(`Device ${MAC} not found within 120s`);
    expect(settledAt).toBe(120_000);
    expect(waited.helper.removeListeners).toHaveBeenCalledTimes(1);
    latch.release();
  });

  it('hands the device on at once when the latch already heard the scale', async () => {
    const waited = waitedDevice();
    const kept = keptDevice();
    const btAdapter = fakeAdapter(waited, kept, 1_000);
    const latch = await latchOn(btAdapter);
    kept.helper.emit('PropertiesChanged', { RSSI: { value: -70 } });
    const result = waitForTargetDevice(btAdapter, MAC, undefined, undefined, latch);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(waited);
    expect(Date.now() - start).toBe(1_000);
    expect(waited.helper.removeListeners).not.toHaveBeenCalled();
    latch.release();
  });

  it('rejects with the abort reason during the gate and releases the proxy', async () => {
    const waited = waitedDevice();
    const btAdapter = fakeAdapter(waited, keptDevice(), 1_000);
    const latch = await latchOn(btAdapter);
    const ctrl = new AbortController();
    const result = waitForTargetDevice(btAdapter, MAC, ctrl.signal, undefined, latch).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    ctrl.abort(new Error('shutdown'));
    expect(((await result) as Error).message).toBe('shutdown');
    expect(waited.helper.removeListeners).toHaveBeenCalledTimes(1);
    latch.release();
  });

  it('without a latch, hands the device on as soon as waitDevice returns', async () => {
    const waited = waitedDevice();
    const btAdapter = fakeAdapter(waited, keptDevice(), 1_000);
    const result = waitForTargetDevice(btAdapter, MAC);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(waited);
  });

  it('runs the gate inside the scan activity watchdog', async () => {
    const btAdapter = fakeAdapter(waitedDevice(), keptDevice(), 1_000);
    const latch = await latchOn(btAdapter);
    const result = waitForTargetDevice(btAdapter, MAC, undefined, undefined, latch).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(waitEndedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
    expect((waitEndedAt ?? 0) - start).toBe(120_000);
    latch.release();
  });
});
