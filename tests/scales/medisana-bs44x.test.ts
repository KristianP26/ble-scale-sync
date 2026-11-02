import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MedisanaBs44xAdapter,
  medisanaRecordTime,
  MEDISANA_EPOCH_2010_OFFSET,
} from '../../src/scales/medisana-bs44x.js';
import type { ConnectionContext, ScaleReading } from '../../src/interfaces/scale-adapter.js';
import { bleLog } from '../../src/ble/types.js';
import { isHistoricalReading } from '../../src/interfaces/reading-time.js';
import { fromDebugLog } from '../helpers/replay/trace.js';
import { CAPTURED_511 } from '../fixtures/medisana/bs444-511.js';
import {
  mockPeripheral,
  defaultProfile,
  makeConnectionContext,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new MedisanaBs44xAdapter();
}

describe('MedisanaBs44xAdapter', () => {
  describe('matches()', () => {
    it.each(['013197', '013198', '0202b6'])('matches exact name "%s"', (name) => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    });

    it('matches "0203b..." prefix', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('0203b123'))).toBe(true);
      expect(adapter.matches(mockPeripheral('0203bABC'))).toBe(true);
    });

    it('matches by service UUID "78b2"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Unknown', ['78b2']))).toBe(true);
    });

    it('matches case-insensitive name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('013197'))).toBe(true);
      expect(adapter.matches(mockPeripheral('0203B123'))).toBe(true);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });

    it('does not match unrelated UUID', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Unknown', ['1234']))).toBe(false);
    });
  });

  describe('onConnected()', () => {
    it('sends time sync with real Unix timestamp', async () => {
      const adapter = makeAdapter();
      const writeFn = vi.fn().mockResolvedValue(undefined);

      const ctx = makeConnectionContext({
        write: writeFn,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile: defaultProfile(),
      });

      const before = Math.floor(Date.now() / 1000);
      await adapter.onConnected!(ctx);
      const after = Math.floor(Date.now() / 1000);

      expect(writeFn).toHaveBeenCalledOnce();
      const [charUuid, data, withResponse] = writeFn.mock.calls[0];
      expect(charUuid).toBe(adapter.charWriteUuid);
      expect(withResponse).toBe(true);

      expect(data[0]).toBe(0x02);
      // Verify the timestamp is within the expected range
      const buf = Buffer.from(data);
      const ts = buf.readUInt32LE(1);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    // Epoch per model, as openScale's MedisanaBs44xHandler predicts it from
    // the name: BS444/BS440 count from 2010-01-01, the BS430 and anything
    // unknown count Unix seconds. Only the epoch choice is tested here; there
    // is no Medisana capture in the repo to pin a frame against.
    const NOW_SEC = 1_790_000_000;
    async function syncedSeconds(deviceName: string | undefined): Promise<number> {
      vi.useFakeTimers();
      vi.setSystemTime(NOW_SEC * 1000);
      try {
        const writeFn = vi.fn().mockResolvedValue(undefined);
        const ctx = {
          write: writeFn,
          read: vi.fn(),
          subscribe: vi.fn(),
          profile: defaultProfile(),
          deviceAddress: '',
          availableChars: new Set<string>(),
          ...(deviceName !== undefined ? { deviceName } : {}),
        } as ConnectionContext;
        await makeAdapter().onConnected!(ctx);
        return Buffer.from(writeFn.mock.calls[0][1]).readUInt32LE(1);
      } finally {
        vi.useRealTimers();
      }
    }

    it.each(['013197A1B2', '013198', '0202B6FF'])(
      'sends seconds since 2010-01-01 to a BS444/BS440 named "%s"',
      async (name) => {
        expect(await syncedSeconds(name)).toBe(NOW_SEC - 1262304000);
      },
    );

    it.each([['0203B0123'], ['some other name'], [undefined]])(
      'sends Unix seconds for name %s',
      async (name) => {
        expect(await syncedSeconds(name)).toBe(NOW_SEC);
      },
    );
  });

  describe('characteristics', () => {
    it('enables 0x8A22 before 0x8A21 and writes the time to 0x8A81', () => {
      expect(makeAdapter().characteristics).toEqual([
        { uuid: F, type: 'notify' },
        { uuid: W, type: 'notify' },
        { uuid: '00008a8100001000800000805f9b34fb', type: 'write' },
      ]);
    });
  });
});

// #511: the frames of a BS444 session from the reporter's log
// (tests/fixtures/medisana/bs444-511.ts). The scale sends its whole memory,
// one 0x8A21 + 0x8A22 pair per record, oldest first; the last record is the
// weigh-in of the session.
const W = '00008a2100001000800000805f9b34fb';
const F = '00008a2200001000800000805f9b34fb';
interface Frame {
  uuid: string;
  data: Buffer;
}
const STEPS: Frame[] = fromDebugLog(CAPTURED_511).map((s) => ({
  uuid: s.uuid ?? '',
  data: Buffer.from(s.hex, 'hex'),
}));
/** The receipt time of the last frame of the memory. */
const END_MS = Date.UTC(2026, 10, 1, 6, 27, 9, 416);
const END_SEC = Math.floor(END_MS / 1000);
/** Raw stamp of each record, in memory order. */
const RAWS = STEPS.filter((s) => s.uuid === W).map((s) => s.data.readUInt32LE(5));
const secOf = (i: number) => medisanaRecordTime(RAWS[i], END_SEC);
const LAST = RAWS.length - 1;

function weightFrame(raw: number, hundredths = 8000): Buffer {
  const b = Buffer.from(STEPS[0].data);
  b.writeUInt16LE(hundredths, 1);
  b.writeUInt32LE(raw, 5);
  return b;
}

function featureFrame(raw: number, fatTenths = 225, bmr = 1650): Buffer {
  const b = Buffer.from(STEPS[1].data);
  b.writeUInt32LE(raw, 1);
  b.writeUInt16LE(bmr, 6);
  b.writeUInt16LE(0xf000 | fatTenths, 8);
  return b;
}

describe('MedisanaBs44xAdapter memory (#511)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(END_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function replay(adapter: MedisanaBs44xAdapter, steps: Frame[] = STEPS): ScaleReading[] {
    const out: ScaleReading[] = [];
    for (const s of steps) {
      const r = adapter.parseCharNotification(s.uuid, s.data);
      if (r) out.push(r);
    }
    return out;
  }

  function session(mark?: number): MedisanaBs44xAdapter {
    const adapter = makeAdapter();
    if (mark !== undefined) adapter.restoreDedupMark(mark);
    adapter.onSessionStart();
    return adapter;
  }

  it('holds 30 records, the last 8 s old, two earlier ones inside the 5 min window', () => {
    expect(RAWS).toHaveLength(30);
    expect(END_SEC - secOf(LAST)).toBeLessThan(10);
    expect(END_SEC - secOf(LAST - 1)).toBeLessThan(300);
    expect(END_SEC - secOf(LAST - 2)).toBeLessThan(300);
    expect(END_SEC - secOf(LAST - 3)).toBeGreaterThan(300);
  });

  it('first session without a mark: exports only the live weigh-in and marks the newest record', () => {
    const info = vi.spyOn(bleLog, 'info');
    const adapter = session();
    const readings = replay(adapter);

    expect(readings).toHaveLength(1);
    expect(readings[0].timestamp).toEqual(new Date(secOf(LAST) * 1000));
    expect(readings[0].fromMemory).toBeUndefined();
    expect(isHistoricalReading(readings[0])).toBe(false);
    expect(adapter.dedupMark()).toBe(secOf(LAST));
    expect(info.mock.calls.filter((c) => String(c[0]).includes('first session'))).toHaveLength(1);
  });

  it('with a mark: the newer stored records go out as history, the newest as live', () => {
    const adapter = session(secOf(LAST - 4));
    const readings = replay(adapter);

    expect(readings.map((r) => r.timestamp!.getTime() / 1000)).toEqual([
      secOf(LAST - 3),
      secOf(LAST - 2),
      secOf(LAST - 1),
      secOf(LAST),
    ]);
    expect(readings.map((r) => isHistoricalReading(r))).toEqual([true, true, true, false]);
    // Every stored record carries the flag: the two inside the 5 min window
    // would otherwise be judged live by their age.
    expect(readings.map((r) => r.fromMemory === true)).toEqual([true, true, true, false]);
    expect(adapter.dedupMark()).toBe(secOf(LAST));
  });

  it('a mark at the newest record exports nothing, and the next session sees the same memory', () => {
    const adapter = session(secOf(LAST));
    expect(replay(adapter)).toEqual([]);
    adapter.onSessionStart();
    expect(replay(adapter)).toEqual([]);
  });

  it('the mark outlives the session: a second session exports only what is new', () => {
    const adapter = session();
    replay(adapter);
    adapter.onSessionStart();
    const next = RAWS[LAST] + 60;
    vi.setSystemTime(END_MS + 70_000);
    const readings = replay(adapter, [
      ...STEPS,
      { uuid: W, data: weightFrame(next) },
      { uuid: F, data: featureFrame(next) },
    ]);
    expect(readings).toHaveLength(1);
    expect(readings[0].timestamp).toEqual(new Date(medisanaRecordTime(next, END_SEC) * 1000));
  });

  it('reads the epoch per record: the two Unix-epoch stamps land in 2026, not 2066', () => {
    const unix = RAWS.filter((r) => r + MEDISANA_EPOCH_2010_OFFSET > END_SEC + 86400);
    expect(unix).toHaveLength(2);
    for (const r of unix) expect(medisanaRecordTime(r, END_SEC)).toBe(r);
    expect(medisanaRecordTime(RAWS[0], END_SEC)).toBe(RAWS[0] + MEDISANA_EPOCH_2010_OFFSET);
    const adapter = session(secOf(0) - 1);
    const years = replay(adapter).map((r) => r.timestamp!.getUTCFullYear());
    expect(new Set(years)).toEqual(new Set([2026]));
  });

  it('pairs the halves by stamp, in either order', () => {
    const adapter = session(secOf(LAST) - 1);
    const w = STEPS[STEPS.length - 2];
    const f = STEPS[STEPS.length - 1];
    expect(adapter.parseCharNotification(f.uuid, f.data)).toBeNull();
    const r = adapter.parseCharNotification(w.uuid, w.data);
    expect(r?.timestamp).toEqual(new Date(secOf(LAST) * 1000));
    expect(r?.scaleComposition?.fat).toBeGreaterThan(0);
  });

  it('does not pair halves with different stamps, and ignores a repeated half', () => {
    const adapter = session(secOf(LAST) - 600);
    const raw = RAWS[LAST];
    expect(adapter.parseCharNotification(W, weightFrame(raw))).toBeNull();
    expect(adapter.parseCharNotification(F, featureFrame(raw + 1))).toBeNull();
    expect(adapter.parseCharNotification(F, featureFrame(raw))).not.toBeNull();
    expect(adapter.parseCharNotification(F, featureFrame(raw))).toBeNull();
    expect(adapter.parseCharNotification(W, weightFrame(raw))).toBeNull();
  });

  it('a record inside the 5 min window but over 60 s old goes out as a stored record', () => {
    const adapter = session(secOf(LAST - 3));
    const pairs = (i: number) => STEPS.slice(2 * i, 2 * i + 2);
    const readings = replay(adapter, [...pairs(LAST), ...pairs(LAST - 1)]);
    expect(readings.map((r) => isHistoricalReading(r))).toEqual([false, true]);
    expect(readings[1].fromMemory).toBe(true);
  });

  it('a record under 60 s old that comes after a newer one is a stored record (proxy reorder)', () => {
    const adapter = session(secOf(LAST - 3));
    const pairs = (i: number) => STEPS.slice(2 * i, 2 * i + 2);
    const earlier = RAWS[LAST] - 20;
    const readings = replay(adapter, [
      ...pairs(LAST),
      { uuid: W, data: weightFrame(earlier) },
      { uuid: F, data: featureFrame(earlier) },
    ]);
    expect(readings.map((r) => r.fromMemory === true)).toEqual([false, true]);
  });

  it('says so when a record before any live one is between 60 s and 5 min old', () => {
    const info = vi.spyOn(bleLog, 'info');
    const adapter = session(secOf(LAST - 2));
    const pairs = (i: number) => STEPS.slice(2 * i, 2 * i + 2);
    const readings = replay(adapter, pairs(LAST - 1));
    expect(readings[0].fromMemory).toBe(true);
    expect(
      info.mock.calls.filter((c) => String(c[0]).includes('handled as a stored weigh-in')),
    ).toHaveLength(1);
  });

  it('a baseline session without a live record still sets the mark', () => {
    const adapter = session();
    const readings = replay(adapter, STEPS.slice(0, STEPS.length - 2));
    expect(readings).toEqual([]);
    expect(adapter.dedupMark()).toBe(secOf(LAST - 1));
  });

  it('drops a record with zero weight', () => {
    const adapter = session(secOf(LAST) - 600);
    const raw = RAWS[LAST];
    adapter.parseCharNotification(W, weightFrame(raw, 0));
    expect(adapter.parseCharNotification(F, featureFrame(raw))).toBeNull();
  });

  it('reads only the weight and composition frame types', () => {
    const adapter = session(secOf(LAST) - 600);
    const raw = RAWS[LAST];
    const w = weightFrame(raw);
    w[0] = 0x1e;
    expect(adapter.parseCharNotification(W, w)).toBeNull();
    expect(adapter.parseCharNotification(F, featureFrame(raw))).toBeNull();
    const f = featureFrame(raw + 1);
    f[0] = 0x70;
    adapter.parseCharNotification(W, weightFrame(raw + 1));
    expect(adapter.parseCharNotification(F, f)).toBeNull();
  });

  it('drops a record stamped before 2015 (clock never set) and says so', () => {
    // The mark (2015 or later) would skip it too; the debug line tells the two apart.
    const debug = vi.spyOn(bleLog, 'debug');
    const adapter = session(secOf(0) - 1);
    expect(adapter.parseCharNotification(W, weightFrame(1000))).toBeNull();
    expect(adapter.parseCharNotification(F, featureFrame(1000))).toBeNull();
    expect(debug.mock.calls.some((c) => String(c[0]).includes('before 2015'))).toBe(true);
    expect(adapter.dedupMark()).toBe(secOf(0) - 1);
  });

  it('drops a record stamped more than 10 min ahead and leaves the mark alone', () => {
    const adapter = session(secOf(LAST));
    const ahead = RAWS[LAST] + 3600;
    adapter.parseCharNotification(W, weightFrame(ahead));
    expect(adapter.parseCharNotification(F, featureFrame(ahead))).toBeNull();
    expect(adapter.dedupMark()).toBe(secOf(LAST));
    // A few minutes ahead is read, but it is not the weigh-in of the session.
    const nearAhead = RAWS[LAST] + 120;
    adapter.parseCharNotification(W, weightFrame(nearAhead));
    expect(adapter.parseCharNotification(F, featureFrame(nearAhead))?.fromMemory).toBe(true);
  });

  it('reads the composition fields, masking the top nibble, and BMR', () => {
    const adapter = session(secOf(LAST) - 600);
    const raw = RAWS[LAST];
    adapter.parseCharNotification(W, weightFrame(raw, 8000));
    const r = adapter.parseCharNotification(F, featureFrame(raw, 225, 0xf000 | 1700))!;
    expect(r.weight).toBe(80);
    expect(r.scaleComposition).toMatchObject({ fat: 22.5, bmr: 1700 });
    const payload = adapter.computeMetrics(r, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(22.5, 1);
    assertPayloadRanges(payload);
  });

  it('a record without composition (all zero) still completes, with no composition values', () => {
    const adapter = session(secOf(LAST) - 600);
    const raw = RAWS[LAST];
    const f = featureFrame(raw, 0, 0);
    f.fill(0, 10, 16);
    adapter.parseCharNotification(W, weightFrame(raw));
    const r = adapter.parseCharNotification(F, f)!;
    expect(r.scaleComposition).toEqual({
      bmr: undefined,
      fat: undefined,
      water: undefined,
      muscle: undefined,
      bone: undefined,
    });
    expect(adapter.isComplete(r)).toBe(true);
    expect(adapter.isFinal()).toBe(false);
  });

  it('restoreDedupMark ignores values that cannot be a record time, and never lowers', () => {
    for (const bad of [1.5, -1, 0, 1_000_000, END_SEC + 3600, Number.NaN]) {
      const adapter = makeAdapter();
      adapter.restoreDedupMark(bad);
      expect(adapter.dedupMark()).toBeUndefined();
    }
    const adapter = makeAdapter();
    adapter.restoreDedupMark(secOf(LAST));
    adapter.restoreDedupMark(secOf(0));
    expect(adapter.dedupMark()).toBe(secOf(LAST));
    const ahead = makeAdapter();
    ahead.restoreDedupMark(END_SEC + 300);
    expect(ahead.dedupMark()).toBe(END_SEC + 300);
  });

  it('keeps the reading composition when the next session starts before computeMetrics (#394)', () => {
    // On the proxy watchers onSessionStart() for session N+1 can land before
    // computeMetrics() for session N; the reading carries its own composition.
    const adapter = session(secOf(LAST) - 600);
    const raw = RAWS[LAST];
    adapter.parseCharNotification(W, weightFrame(raw));
    const reading = adapter.parseCharNotification(F, featureFrame(raw, 225))!;
    adapter.onSessionStart();
    expect(adapter.computeMetrics(reading, defaultProfile()).bodyFatPercent).toBeCloseTo(22.5, 1);
  });

  it('does not pair a half from the previous session (#394)', () => {
    const adapter = session(secOf(LAST) - 600);
    const raw = RAWS[LAST];
    adapter.parseCharNotification(W, weightFrame(raw));
    adapter.onSessionStart();
    expect(adapter.parseCharNotification(F, featureFrame(raw))).toBeNull();
  });

  it('parseNotification() reads nothing: the characteristic tells the frames apart', () => {
    expect(makeAdapter().parseNotification()).toBeNull();
  });
});
