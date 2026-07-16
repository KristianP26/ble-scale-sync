import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  HistoryBuffer,
  HoldTimer,
  WeightStabilityTracker,
} from '../../src/ble/notification-processor.js';
import { bleLog } from '../../src/ble/types.js';
import type { ScaleReading } from '../../src/interfaces/scale-adapter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const reading = (weight: number): ScaleReading => ({
  weight,
  impedance: 400,
  timestamp: new Date(0),
});

describe('HistoryBuffer', () => {
  it('buffers frames under the cap and reports length', () => {
    const buf = new HistoryBuffer(3, 'TestScale');
    expect(buf.push(reading(70))).toBe(true);
    expect(buf.push(reading(71))).toBe(true);
    expect(buf.length).toBe(2);
  });

  it('snapshot returns a defensive copy, undefined when empty', () => {
    const buf = new HistoryBuffer(3, 'TestScale');
    expect(buf.snapshot()).toBeUndefined();
    buf.push(reading(70));
    const snap = buf.snapshot()!;
    expect(snap).toHaveLength(1);
    snap.push(reading(99));
    expect(buf.length).toBe(1); // internal array not mutated by the snapshot
  });

  it('popLatest removes and returns the newest frame', () => {
    const buf = new HistoryBuffer(3, 'TestScale');
    buf.push(reading(70));
    buf.push(reading(71));
    expect(buf.popLatest()?.weight).toBe(71);
    expect(buf.length).toBe(1);
  });

  it('drops frames over the cap and warns exactly once', () => {
    const warnSpy = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const buf = new HistoryBuffer(2, 'TestScale');
    expect(buf.push(reading(70))).toBe(true);
    expect(buf.push(reading(71))).toBe(true);
    expect(buf.push(reading(72))).toBe(false);
    expect(buf.push(reading(73))).toBe(false);
    expect(buf.length).toBe(2);
    const capWarns = warnSpy.mock.calls.filter((a) =>
      String(a[0] ?? '').includes('Cached frame buffer hit 2'),
    );
    expect(capWarns).toHaveLength(1);
  });
});

describe('HoldTimer', () => {
  it('arms once, fires onElapsed with the held reading after holdMs', () => {
    vi.useFakeTimers();
    try {
      const onElapsed = vi.fn();
      const t = new HoldTimer(15000, onElapsed);
      t.hold(reading(83));
      expect(onElapsed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(15000);
      expect(onElapsed).toHaveBeenCalledTimes(1);
      expect(onElapsed.mock.calls[0][0].weight).toBe(83);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second hold updates the held reading without re-arming the timer', () => {
    vi.useFakeTimers();
    try {
      const onElapsed = vi.fn();
      const t = new HoldTimer(15000, onElapsed);
      t.hold(reading(83));
      vi.advanceTimersByTime(10000);
      t.hold(reading(84)); // must NOT reset the 15s window
      expect(t.heldReading?.weight).toBe(84);
      vi.advanceTimersByTime(5000); // 15s since first hold
      expect(onElapsed).toHaveBeenCalledTimes(1);
      expect(onElapsed.mock.calls[0][0].weight).toBe(84);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear cancels the timer but keeps the held reading', () => {
    vi.useFakeTimers();
    try {
      const onElapsed = vi.fn();
      const t = new HoldTimer(15000, onElapsed);
      t.hold(reading(83));
      t.clear();
      vi.advanceTimersByTime(15000);
      expect(onElapsed).not.toHaveBeenCalled();
      expect(t.heldReading?.weight).toBe(83);
    } finally {
      vi.useRealTimers();
    }
  });

  it('heldReading is null before any hold', () => {
    const t = new HoldTimer(15000, vi.fn());
    expect(t.heldReading).toBeNull();
  });
});

describe('WeightStabilityTracker', () => {
  it('requires consecutive equal weights by default', () => {
    const t = new WeightStabilityTracker({});
    expect(t.observe({ weight: 80.1, impedance: 0 })).toBe(false);
    expect(t.observe({ weight: 80, impedance: 0 })).toBe(false);
    expect(t.observe({ weight: 80, impedance: 0 })).toBe(true);
  });

  it('uses toleranceKg when comparing consecutive readings', () => {
    const t = new WeightStabilityTracker({ samples: 3, toleranceKg: 0.05 });
    expect(t.observe({ weight: 80, impedance: 0 })).toBe(false);
    expect(t.observe({ weight: 80.03, impedance: 0 })).toBe(false);
    expect(t.observe({ weight: 80.01, impedance: 0 })).toBe(true);
    expect(t.observe({ weight: 80.2, impedance: 0 })).toBe(false);
  });

  it('resets on non-finite readings', () => {
    const t = new WeightStabilityTracker({});
    expect(t.observe({ weight: 80, impedance: 0 })).toBe(false);
    expect(t.observe({ weight: Number.NaN, impedance: 0 })).toBe(false);
    expect(t.observe({ weight: 80, impedance: 0 })).toBe(false);
    expect(t.observe({ weight: 80, impedance: 0 })).toBe(true);
  });
});
