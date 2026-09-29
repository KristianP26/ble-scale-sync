import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateAdvertisement,
  GraceTimers,
  DedupWindow,
  readsFromAdvertisement,
} from '../../src/ble/advertisement.js';
import { MiScale2Adapter } from '../../src/scales/mi-scale-2.js';
import { QnScaleAdapter } from '../../src/scales/qn-scale/index.js';
import { applyForcedAdapter } from '../../src/scales/force.js';
import type { RawReading } from '../../src/ble/shared.js';
import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
} from '../../src/interfaces/scale-adapter.js';

// ─── Minimal adapter builders ─────────────────────────────────────────────────

const baseAdapter = (over: Partial<ScaleAdapter>): ScaleAdapter =>
  ({
    name: 'Test',
    charNotifyUuid: '',
    charWriteUuid: '',
    unlockCommand: [],
    unlockIntervalMs: 0,
    matches: () => true,
    parseNotification: () => null,
    isComplete: (r: ScaleReading) => r.weight > 0 && r.impedance > 0,
    computeMetrics: () => ({}) as never,
    ...over,
  }) as ScaleAdapter;

const MFG = (weight: number, impedance: number): BleDeviceInfo => ({
  localName: 'x',
  serviceUuids: [],
  manufacturerData: { id: 0xffff, data: encode(weight, impedance) },
});

const SVC = (weight: number, impedance: number): BleDeviceInfo => ({
  localName: 'x',
  serviceUuids: [],
  serviceData: [{ uuid: '181b', data: encode(weight, impedance) }],
});

function encode(weight: number, impedance: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(Math.round(weight * 100), 0);
  b.writeUInt16LE(impedance, 2);
  return b;
}

const parseMfg = (data: Buffer): ScaleReading => ({
  weight: data.readUInt16LE(0) / 100,
  impedance: data.readUInt16LE(2),
});

describe('evaluateAdvertisement', () => {
  it('returns complete for a non-passive adapter on any non-null reading', () => {
    const adapter = baseAdapter({ parseBroadcast: parseMfg });
    const d = evaluateAdvertisement(adapter, MFG(75, 0));
    expect(d).toEqual({ kind: 'complete', reading: { weight: 75, impedance: 0 } });
  });

  it('returns complete for a passive adapter only when isComplete is true', () => {
    const adapter = baseAdapter({
      preferPassive: true,
      parseServiceData: () => parseMfg(encode(70, 500)),
    });
    const d = evaluateAdvertisement(adapter, SVC(70, 500));
    expect(d.kind).toBe('complete');
  });

  it('returns partial for a passive adapter when the frame is weight-only', () => {
    const adapter = baseAdapter({
      preferPassive: true,
      parseServiceData: () => parseMfg(encode(70, 0)),
    });
    const d = evaluateAdvertisement(adapter, SVC(70, 0));
    expect(d).toEqual({ kind: 'partial', reading: { weight: 70, impedance: 0 } });
  });

  it('prefers parseBroadcast over parseServiceData', () => {
    const adapter = baseAdapter({
      parseBroadcast: () => parseMfg(encode(80, 0)),
      parseServiceData: () => parseMfg(encode(99, 0)),
    });
    const info: BleDeviceInfo = {
      ...MFG(80, 0),
      serviceData: [{ uuid: '181b', data: encode(99, 0) }],
    };
    const d = evaluateAdvertisement(adapter, info);
    expect(d.kind === 'complete' && d.reading.weight).toBe(80);
  });

  it('iterates serviceData entries and breaks on the first non-null', () => {
    const seen: string[] = [];
    const adapter = baseAdapter({
      parseServiceData: (uuid: string, data: Buffer) => {
        seen.push(uuid);
        return uuid === 'match' ? parseMfg(data) : null;
      },
    });
    const info: BleDeviceInfo = {
      localName: 'x',
      serviceUuids: [],
      serviceData: [
        { uuid: 'miss', data: encode(0, 0) },
        { uuid: 'match', data: encode(60, 0) },
        { uuid: 'after', data: encode(0, 0) },
      ],
    };
    const d = evaluateAdvertisement(adapter, info);
    expect(d.kind).toBe('complete');
    expect(seen).toEqual(['miss', 'match']); // stopped after the match
  });

  it('returns wait when no reading but a parseable broadcast source is present', () => {
    const adapter = baseAdapter({
      charNotifyUuid: 'fff4',
      parseBroadcast: () => null,
    });
    const d = evaluateAdvertisement(adapter, MFG(0, 0));
    expect(d).toEqual({ kind: 'wait' });
  });

  it('returns gatt when no reading, no broadcast source, but a notify char exists', () => {
    const adapter = baseAdapter({ charNotifyUuid: 'fff4' });
    const info: BleDeviceInfo = { localName: 'x', serviceUuids: [] };
    expect(evaluateAdvertisement(adapter, info)).toEqual({ kind: 'gatt' });
  });

  it('returns none when no reading, no broadcast source, and no notify char', () => {
    const adapter = baseAdapter({ charNotifyUuid: '' });
    const info: BleDeviceInfo = { localName: 'x', serviceUuids: [] };
    expect(evaluateAdvertisement(adapter, info)).toEqual({ kind: 'none' });
  });

  it('with waitForBroadcast=false, a parseable broadcast source falls through to gatt', () => {
    const adapter = baseAdapter({
      charNotifyUuid: 'fff4',
      parseBroadcast: () => null,
    });
    const d = evaluateAdvertisement(adapter, MFG(0, 0), { waitForBroadcast: false });
    expect(d).toEqual({ kind: 'gatt' });
  });

  it('with waitForBroadcast=false and no notify char, returns none', () => {
    const adapter = baseAdapter({ charNotifyUuid: '', parseBroadcast: () => null });
    const d = evaluateAdvertisement(adapter, MFG(0, 0), { waitForBroadcast: false });
    expect(d).toEqual({ kind: 'none' });
  });
});

const sharedAdapter = baseAdapter({});
const raw = (weight: number): RawReading =>
  ({ reading: { weight, impedance: 0 }, adapter: sharedAdapter }) as RawReading;

describe('readsFromAdvertisement (#422)', () => {
  it('is true for the real Mi Scale 2, which also carries GATT wiring', () => {
    const mi = new MiScale2Adapter();
    expect(mi.charNotifyUuid).toBeTruthy();
    expect(readsFromAdvertisement(mi)).toBe(true);
  });

  it('is true for a forced Mi Scale 2 (ble.force_scale_adapter)', () => {
    const [forced] = applyForcedAdapter([new MiScale2Adapter()], 'Xiaomi Mi Scale 2');
    expect(readsFromAdvertisement(forced)).toBe(true);
  });

  it('is false for the dual-mode QN adapter, which parses broadcasts but prefers GATT', () => {
    const qn = new QnScaleAdapter();
    expect(typeof qn.parseBroadcast).toBe('function');
    expect(readsFromAdvertisement(qn)).toBe(false);
  });

  it('is false for preferPassive without any advertisement parser', () => {
    const odd = baseAdapter({ preferPassive: true } as Partial<ScaleAdapter>);
    expect(readsFromAdvertisement(odd)).toBe(false);
  });
});

describe('GraceTimers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires onElapsed with the held reading after graceMs', () => {
    const onElapsed = vi.fn();
    const g = new GraceTimers(1000, onElapsed);
    g.hold('AA', raw(70));
    expect(onElapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(onElapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(onElapsed).toHaveBeenCalledWith('AA', raw(70));
  });

  it('arms once per address: a second hold refreshes the reading without resetting the clock', () => {
    const onElapsed = vi.fn();
    const g = new GraceTimers(1000, onElapsed);
    g.hold('AA', raw(70));
    vi.advanceTimersByTime(800);
    g.hold('AA', raw(71)); // refresh, clock not reset
    vi.advanceTimersByTime(200); // 1000 total since first hold
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(onElapsed).toHaveBeenCalledWith('AA', raw(71));
  });

  it('takeHeld returns the first held reading and cancels its timer (#357)', () => {
    const onElapsed = vi.fn();
    const g = new GraceTimers(1000, onElapsed);
    expect(g.takeHeld()).toBeNull();
    g.hold('AA', raw(70));
    g.hold('BB', raw(80));
    g.hold('AA', raw(71));
    expect(g.takeHeld()).toEqual({ address: 'AA', reading: raw(71) });
    vi.advanceTimersByTime(1000);
    // Only BB's timer is left to fire.
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(onElapsed).toHaveBeenCalledWith('BB', raw(80));
    expect(g.takeHeld()).toBeNull();
  });

  it('cancel stops a pending timer and drops the stored reading', () => {
    const onElapsed = vi.fn();
    const g = new GraceTimers(1000, onElapsed);
    g.hold('AA', raw(70));
    g.cancel('AA');
    vi.advanceTimersByTime(2000);
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it('tracks independent timers per address', () => {
    const onElapsed = vi.fn();
    const g = new GraceTimers(1000, onElapsed);
    g.hold('AA', raw(70));
    g.hold('BB', raw(80));
    g.cancel('AA');
    vi.advanceTimersByTime(1000);
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(onElapsed).toHaveBeenCalledWith('BB', raw(80));
  });

  it('clear cancels all pending timers', () => {
    const onElapsed = vi.fn();
    const g = new GraceTimers(1000, onElapsed);
    g.hold('AA', raw(70));
    g.hold('BB', raw(80));
    g.clear();
    vi.advanceTimersByTime(2000);
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it('a clear() called from inside onElapsed does not throw or double-fire', () => {
    const onElapsed = vi.fn(() => g.clear());
    const g = new GraceTimers(1000, onElapsed);
    g.hold('AA', raw(70));
    vi.advanceTimersByTime(1000);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });
});

describe('DedupWindow', () => {
  it('emits a new (address, weight) and suppresses a repeat within the window', () => {
    let t = 1000;
    const d = new DedupWindow(30_000, () => t);
    expect(d.shouldEmit('AA', 70.0)).toBe(true);
    t = 5000;
    expect(d.shouldEmit('AA', 70.0)).toBe(false);
  });

  it('re-emits after the window elapses', () => {
    let t = 1000;
    const d = new DedupWindow(30_000, () => t);
    expect(d.shouldEmit('AA', 70.0)).toBe(true);
    t = 1000 + 30_000;
    expect(d.shouldEmit('AA', 70.0)).toBe(true);
  });

  it('keys on weight rounded to one decimal', () => {
    let t = 1000;
    const d = new DedupWindow(30_000, () => t);
    expect(d.shouldEmit('AA', 70.04)).toBe(true);
    t = 2000;
    expect(d.shouldEmit('AA', 70.0)).toBe(false); // 70.04 -> "70.0"
    expect(d.shouldEmit('AA', 70.1)).toBe(true); // different rounded key
  });

  it('treats different addresses independently', () => {
    const t = 1000;
    const d = new DedupWindow(30_000, () => t);
    expect(d.shouldEmit('AA', 70.0)).toBe(true);
    expect(d.shouldEmit('BB', 70.0)).toBe(true);
  });

  it('prunes expired entries so the map does not grow unbounded', () => {
    let t = 1000;
    const d = new DedupWindow(30_000, () => t);
    d.shouldEmit('AA', 70.0);
    t = 1000 + 30_000;
    d.shouldEmit('BB', 80.0); // triggers prune of AA
    // AA is gone, so it re-emits as new rather than being suppressed
    expect(d.shouldEmit('AA', 70.0)).toBe(true);
  });

  it('defaults now to Date.now when not injected', () => {
    const d = new DedupWindow(30_000);
    expect(d.shouldEmit('AA', 70.0)).toBe(true);
    expect(d.shouldEmit('AA', 70.0)).toBe(false);
  });
});
