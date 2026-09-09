import { describe, it, expect, vi } from 'vitest';
import { DedupWindow, emitDeduped } from '../../src/ble/advertisement.js';
import type { RawReading } from '../../src/ble/shared.js';

const ADDR = 'AA:BB:CC:DD:EE:FF';

function raw(weight: number): RawReading {
  return {
    reading: { weight, impedance: 0 },
    adapter: { name: 'TestScale' } as unknown as RawReading['adapter'],
  };
}

/**
 * #406: two watchers held a byte-identical private copy of this and the third
 * inlined it and had drifted. Only the mqtt-proxy watcher suite covered the
 * dedup behaviour at all, so a regression in the other two would have passed CI.
 */
describe('emitDeduped', () => {
  it('queues the first reading and reports that it did', () => {
    const queue = { push: vi.fn() };
    const emitted = emitDeduped(new DedupWindow(60_000), queue, ADDR, raw(80), 80);
    expect(emitted).toBe(true);
    expect(queue.push).toHaveBeenCalledTimes(1);
  });

  it('suppresses the same weight from the same address inside the window', () => {
    const queue = { push: vi.fn() };
    const dedup = new DedupWindow(60_000);
    emitDeduped(dedup, queue, ADDR, raw(80), 80);
    const second = emitDeduped(dedup, queue, ADDR, raw(80), 80);

    expect(second).toBe(false);
    expect(queue.push).toHaveBeenCalledTimes(1);
  });

  it('lets a different weight through', () => {
    const queue = { push: vi.fn() };
    const dedup = new DedupWindow(60_000);
    emitDeduped(dedup, queue, ADDR, raw(80), 80);
    expect(emitDeduped(dedup, queue, ADDR, raw(80.5), 80.5)).toBe(true);
    expect(queue.push).toHaveBeenCalledTimes(2);
  });

  it('lets the same weight through from a different address', () => {
    const queue = { push: vi.fn() };
    const dedup = new DedupWindow(60_000);
    emitDeduped(dedup, queue, ADDR, raw(80), 80);
    expect(emitDeduped(dedup, queue, '11:22:33:44:55:66', raw(80), 80)).toBe(true);
    expect(queue.push).toHaveBeenCalledTimes(2);
  });

  it('lets the same weight through once the window has passed', () => {
    let now = 1_000_000;
    const queue = { push: vi.fn() };
    const dedup = new DedupWindow(60_000, () => now);
    emitDeduped(dedup, queue, ADDR, raw(80), 80);
    now += 60_001;
    expect(emitDeduped(dedup, queue, ADDR, raw(80), 80)).toBe(true);
    expect(queue.push).toHaveBeenCalledTimes(2);
  });

  it('the return value is what gates a caller side effect', () => {
    // The mqtt watcher registers the scale MAC with the ESP32 only when a
    // reading is actually emitted; on a repeat advertisement that would
    // otherwise publish to the proxy every time.
    const queue = { push: vi.fn() };
    const dedup = new DedupWindow(60_000);
    const sideEffect = vi.fn();

    for (let i = 0; i < 3; i += 1) {
      if (emitDeduped(dedup, queue, ADDR, raw(80), 80)) sideEffect();
    }
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });
});
