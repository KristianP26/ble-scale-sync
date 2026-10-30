import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QnScaleAdapter } from '../../src/scales/qn-scale/index.js';
import { NINETEEN_BYTE_RESULT_HOLD_MS } from '../../src/scales/qn-scale/constants.js';
import { bleLog } from '../../src/ble/types.js';
import { isHistoricalReading } from '../../src/interfaces/reading-time.js';
import type {
  AdapterRuntimeConfig,
  ConnectionContext,
  ScaleReading,
  UserProfile,
} from '../../src/interfaces/scale-adapter.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';
import { buildPayload } from '../../src/scales/body-comp-helpers.js';
import {
  decodeEightResult,
  decodeEightStoredRecord,
  decodeVaComposition,
  decryptQnResistance,
  hasValidSumChecksum,
} from '../../src/scales/qn-scale/frames.js';

// The 19-byte QN dialect's 8-electrode frames (#331). Every frame below is byte
// for byte from the public #331 logs of one reporter, who agreed to their use as
// test data (#331, 2026-10-12), unless its comment says it is derived.

const hex = (h: string): Buffer => Buffer.from(h.replace(/ /g, ''), 'hex');
const withSum = (frame: Buffer): Buffer => {
  const f = Buffer.from(frame);
  f[f.length - 1] = [...f.subarray(0, f.length - 1)].reduce((a, b) => a + b, 0) & 0xff;
  return f;
};
/** A copy of `frame` whose checksum no longer closes. */
const badSum = (frame: Buffer): Buffer => {
  const f = Buffer.from(frame);
  f[f.length - 1] ^= 0x01;
  return f;
};
/** A copy of `frame` with `bytes` written at `at` and the checksum recomputed. */
const patched = (frame: Buffer, at: number, ...bytes: number[]): Buffer => {
  const f = Buffer.from(frame);
  f.set(bytes, at);
  return withSum(f);
};

/**
 * #331 comment of 2026-10-06 and its attachment
 * `QN-Scale-v1.30.1-second-weigh-in-CLEAN.log` (lines 407-441): a weigh-in the
 * scale measured with the link up, 76.85 kg.
 */
const R06 = {
  P1: hex('10 14 01 02 31 1e 05 0c be 09 9e 0c 72 09 59 09 96 08 79 ec'),
  P2: hex('10 14 09 fa 32 08 ed 01 6a 02 52 0c be 09 9e 0c 72 09 59 5e'),
  P3: hex('10 14 09 96 33 08 79 09 fa 08 ed 01 74 01 4d 00 b4 00 00 e6'),
  C15: hex('15 10 ff 00 eb 02 4f 03 0b 06 30 06 c2 00 ba 26'),
  D16: hex('16 10 ff 00 00 2a 03 34 00 a1 02 12 03 99 04 db'),
};

/**
 * #331 attachment `qn-scale-v1.31.0-76.55kg.log.txt` (comment of 2026-10-07):
 * one stored record (lines 207-241) and the live result block after it
 * (lines 251-287).
 */
const R07 = {
  S1: hex('23 01 01 01 31 a5 60 59 32 1d e7 0e 3d 0c ad 0d e4 0c 54 40'),
  S2: hex('23 09 14 01 32 08 18 09 e2 08 f7 01 75 02 8d 00 00 00 00 82'),
  S3: hex('23 00 00 01 33 00 00 00 00 00 00 00 00 00 00 00 00 00 00 57'),
  S24: hex('24 13 ff 00 e7 00 00 00 00 00 00 00 00 00 00 00 00 00 1d'),
  S25: hex('25 0f ff 00 00 00 00 00 00 00 00 00 00 00 00 33'),
  P1: hex('10 14 01 02 31 1d e7 0e 1e 0c 8e 0d bf 0c 2f 09 3f 08 4e c7'),
  P2: hex('10 14 09 6b 32 08 70 01 7c 02 88 0e 1e 0c 8e 0d bf 0c 2f 16'),
  P3: hex('10 14 09 3f 33 08 4e 09 6b 08 70 01 86 01 72 00 ae 00 00 89'),
  C15: hex('15 10 ff 00 e7 02 54 03 10 06 2f 06 c7 00 bb 31'),
  D16: hex('16 10 ff 00 00 2a 03 3a 00 9b 02 15 03 a9 04 ee'),
};

/**
 * Derived: R07's stored record, whose corrected channels and composition the
 * scale left at zero, with those fields filled from the live result block of
 * the same log (adjusted channels from P2/P3, body fat from P3, 0x24/0x25
 * payload from 0x15/0x16), checksums recomputed. It checks that the stored
 * layout reads the same fields the live one does, not a capture of a full
 * stored record.
 */
const R07_FULL = {
  S1: R07.S1,
  S2: patched(R07.S2, 15, ...R07.P2.subarray(11, 15)),
  S3: patched(
    R07.S3,
    1,
    ...R07.P2.subarray(15, 17),
    0x01,
    0x33,
    ...R07.P2.subarray(17, 19),
    ...R07.P3.subarray(2, 4),
    ...R07.P3.subarray(5, 15),
  ),
  S24: patched(R07.S24, 3, ...R07.C15.subarray(3, 15), ...R07.P3.subarray(15, 18)),
  S25: patched(R07.S25, 3, ...R07.D16.subarray(3, 15)),
};

/**
 * The session frames around them, from the same two logs: 2026-10-06 lines
 * 43, 145, 173, 211, 235 and 391 (scale info, ready, config request, the
 * scale's acceptance of our profile, a measuring frame, the stable frame);
 * 2026-10-07 lines 53, 107, 137 and 175.
 */
const R06_SESSION = {
  INFO: hex('12 13 ff 54 0b 04 00 07 ff 15 0f 27 00 00 05 03 e0 6f 2f'),
  READY: hex('14 0b ff 01 00 01 00 00 00 00 20'),
  CONFIG_REQ: hex('21 05 ff 01 26'),
  VISIT_OK: hex('a1 06 02 01 01 ab'),
  MEASURING: hex('10 14 01 00 11 1e 05 00 00 00 00 00 00 00 00 00 00 00 00 59'),
  STABLE: hex('10 14 01 01 11 1e 05 00 00 00 00 00 00 00 00 00 00 00 00 5a'),
};
const R07_SESSION = {
  INFO: hex('12 13 ff 54 0b 04 00 07 ff 15 0f 27 00 01 05 03 e0 6f 30'),
  READY: R06_SESSION.READY,
  CONFIG_REQ: R06_SESSION.CONFIG_REQ,
  VISIT_OK: R06_SESSION.VISIT_OK,
};
/** The 2026-10-07 session's own 0x20 time (line 113, `20 09 ff 6c 61 59 32 08 88`). */
const R07_CONNECTED = '2026-10-07T20:00:44.000Z';
/** The time R07's stored record carries: 199 s before that. */
const R07_RECORD_AT = '2026-10-07T19:57:25.000Z';

const R07_STORED = [R07.S1, R07.S2, R07.S3, R07.S24, R07.S25];
const R07_LIVE = [R07.P1, R07.P2, R07.P3, R07.C15, R07.D16];
/** The scale's "no stored weigh-ins" answer to the 0x22, 2026-10-06 line 399. */
const NO_RECORDS = hex('23 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 23');
const R06_LIVE = [R06.P1, R06.P2, R06.P3, R06.C15, R06.D16];
/**
 * The profile the 2026-10-06 visit frame carried: 1810 mm. The age is the
 * fixtures' own: the frames' body age and BMR are what the scale computed for
 * the reporter's profile, so they are checked as sent, not against 40 (D078).
 */
const P181: UserProfile = { height: 181, age: 40, gender: 'male', isAthlete: false };

/**
 * Derived: the 2026-10-06 block with every payload byte zeroed, the shape of
 * the all-zero blocks reported in #331.
 */
function allZeroBlock(): Buffer[] {
  return R06_LIVE.map((f, i) => {
    const z = Buffer.alloc(f.length);
    // Kept: opcode and length; part 1's slot, status, part byte and weight;
    // the part byte of parts 2 and 3; 0x15/0x16's [2].
    const kept = i === 0 ? [0, 1, 2, 3, 4, 5, 6] : i < 3 ? [0, 1, 4] : [0, 1, 2];
    for (const at of kept) z[at] = f[at];
    return withSum(z);
  });
}

/**
 * Derived: R07's stored record moved to another time and made record `index`
 * of a batch of `count`, checksums recomputed.
 */
function storedRecordAt(iso: string, index = 1, count = 1): Buffer[] {
  const t = Math.round(new Date(iso).getTime() / 1000) - 946684800;
  const s1 = Buffer.from(R07.S1);
  s1[2] = count;
  s1[3] = index;
  s1.writeUInt32LE(t, 5);
  return [withSum(s1), patched(R07.S2, 3, index), patched(R07.S3, 3, index), R07.S24, R07.S25];
}

const R06_RESULT = {
  slot: 1,
  weight: 76.85,
  original: [326.2, 246.2, 318.6, 239.3, 245.4, 216.9, 255.4, 228.5, 36.2, 59.4],
  adjusted: [326.2, 246.2, 318.6, 239.3, 245.4, 216.9, 255.4, 228.5, 37.2, 33.3],
  fatPercent: 18,
  heartRate: 0,
};

const R07_ADJUSTED = [361.4, 321.4, 351.9, 311.9, 236.7, 212.6, 241.1, 216, 39, 37];

const R07_COMPOSITION = {
  bmi: 23.1,
  water: 59.6,
  muscle: 78.4,
  visceral: 6,
  bodyAge: 47,
  bmr: 1735,
  protein: 18.7,
  heartIndex: 0,
  bone: 4.2,
  lbm: 82.6,
  subcutaneousFat: 15.5,
  skeletalMuscle: 53.3,
  score: 93.7,
  bodyShape: 4,
};

describe('QN 8-electrode decoders (#331)', () => {
  it('fixtures close under the family checksum', () => {
    for (const set of [R06, R07, R07_FULL]) {
      for (const f of Object.values(set)) expect(hasValidSumChecksum(f)).toBe(true);
    }
  });

  describe('decodeEightResult', () => {
    it('reads the slot, weight, both channel sets, body fat and heart rate', () => {
      expect(decodeEightResult(R06.P1, R06.P2, R06.P3, false)).toEqual(R06_RESULT);
      expect(decodeEightResult(R07.P1, R07.P2, R07.P3, false)).toEqual({
        slot: 1,
        weight: 76.55,
        original: [361.4, 321.4, 351.9, 311.9, 236.7, 212.6, 241.1, 216, 38, 64.8],
        adjusted: R07_ADJUSTED,
        fatPercent: 17.4,
        heartRate: 0,
      });
    });

    // The measured trunk reads higher at 100 kHz than at 20 kHz, which a body
    // does not; the scale's corrected trunk reads lower. Holds on both blocks,
    // and would not if the channel order were shifted.
    it('puts the trunk last, measured and corrected', () => {
      for (const s of [R06, R07]) {
        const r = decodeEightResult(s.P1, s.P2, s.P3, false)!;
        expect(r.original[9]).toBeGreaterThan(r.original[8]);
        expect(r.adjusted[9]).toBeLessThan(r.adjusted[8]);
      }
    });

    it.each([
      ['a bad checksum on part 2', () => [R06.P1, badSum(R06.P2), R06.P3]],
      ['parts out of order', () => [R06.P1, R06.P3, R06.P2]],
      ['a short part', () => [R06.P1, R06.P2, R06.P3.subarray(0, 19)]],
      ['a stable frame as part 1', () => [patched(R06.P1, 4, 0x11), R06.P2, R06.P3]],
    ])('returns null for %s', (_name, frames) => {
      const [a, b, c] = frames();
      expect(decodeEightResult(a, b, c, false)).toBeNull();
    });

    // A scrambled channel, the #461 value from the vendor SDK's flag: 0x10cf
    // reads 0x01f6 (502). Derived: R06 part 1 with LH20 replaced by it.
    it('unscrambles the channels when the advertisement says so, and only them', () => {
      const p1 = patched(R06.P1, 7, 0x10, 0xcf);
      const r = decodeEightResult(p1, R06.P2, R06.P3, true)!;
      expect(r.original[0]).toBe(50.2);
      expect(r.original[1]).toBe(decryptQnResistance(0x099e) / 10);
      expect(r.fatPercent).toBe(18);
      expect(r.weight).toBe(76.85);
    });
  });

  describe('decodeVaComposition', () => {
    it('reads the 0x15 and 0x16 fields', () => {
      expect(decodeVaComposition(R06.C15, R06.D16)).toEqual({
        bmi: 23.5,
        water: 59.1,
        muscle: 77.9,
        visceral: 6,
        bodyAge: 48,
        bmr: 1730,
        protein: 18.6,
        heartIndex: 0,
        bone: 4.2,
        lbm: 82,
        subcutaneousFat: 16.1,
        skeletalMuscle: 53,
        score: 92.1,
        bodyShape: 4,
      });
      expect(decodeVaComposition(R07.C15, R07.D16)).toEqual(R07_COMPOSITION);
    });

    // Independent of the layout: the scale's muscle is its fat-free mass minus
    // its bone, and its lean mass percentage is 100 minus its body fat.
    it('agrees with the body fat of the same weigh-in', () => {
      for (const s of [R06, R07]) {
        const r = decodeEightResult(s.P1, s.P2, s.P3, false)!;
        const c = decodeVaComposition(s.C15, s.D16)!;
        const w = r.weight;
        const fatFree = w * (1 - r.fatPercent / 100);
        expect(Math.abs((c.muscle * w) / 100 - (fatFree - (c.bone * w) / 100))).toBeLessThan(0.1);
        expect(Math.abs(c.lbm - (100 - r.fatPercent))).toBeLessThanOrEqual(0.1);
      }
    });

    it.each([
      ['0x15 and 0x16 swapped', () => [R06.D16, R06.C15]],
      ['a bad checksum', () => [R06.C15, badSum(R06.D16)]],
      ['a short 0x15', () => [R06.C15.subarray(0, 15), R06.D16]],
    ])('returns null for %s', (_name, frames) => {
      const [c, d] = frames();
      expect(decodeVaComposition(c, d)).toBeNull();
    });
  });

  describe('decodeEightStoredRecord', () => {
    it('reads the slot, batch, time, weight and channels of a stored record', () => {
      expect(decodeEightStoredRecord(R07.S1, R07.S2, R07.S3, R07.S24, R07.S25, false)).toEqual({
        slot: 1,
        count: 1,
        index: 1,
        // 2026-10-07T19:57:25Z, 199 s before the session's own 0x20 time.
        recordSeconds: 844718245,
        weight: 76.55,
        original: [364.5, 324.5, 355.6, 315.6, 232.4, 207.2, 253, 229.5, 37.3, 65.3],
        adjusted: new Array<number>(10).fill(0),
        fatPercent: 0,
        heartRate: 0,
        composition: { ...zeroComposition(), bmi: 23.1 },
      });
    });

    it('reads the corrected channels and composition where the live block has them', () => {
      const r = decodeEightStoredRecord(
        R07_FULL.S1,
        R07_FULL.S2,
        R07_FULL.S3,
        R07_FULL.S24,
        R07_FULL.S25,
        false,
      )!;
      expect(r.adjusted).toEqual(R07_ADJUSTED);
      expect(r.fatPercent).toBe(17.4);
      expect(r.composition).toEqual(R07_COMPOSITION);
    });

    it.each([
      ['a bad checksum on part 3', () => [R07.S1, R07.S2, badSum(R07.S3)]],
      ['part 2 from another record', () => [R07.S1, patched(R07.S2, 3, 0x02), R07.S3]],
      ['parts out of order', () => [R07.S1, R07.S3, R07.S2]],
    ])('returns null for %s', (_name, parts) => {
      const [a, b, c] = parts();
      expect(decodeEightStoredRecord(a, b, c, R07.S24, R07.S25, false)).toBeNull();
    });

    it('returns null for a 0x24 of the wrong length or a 0x25 shorter than 16 bytes', () => {
      const s24 = withSum(Buffer.concat([R07.S24, Buffer.from([0])]));
      expect(decodeEightStoredRecord(R07.S1, R07.S2, R07.S3, s24, R07.S25, false)).toBeNull();
      const s25 = withSum(R07.S25.subarray(0, 15));
      expect(decodeEightStoredRecord(R07.S1, R07.S2, R07.S3, R07.S24, s25, false)).toBeNull();
    });
  });
});

function zeroComposition() {
  return {
    bmi: 0,
    water: 0,
    muscle: 0,
    visceral: 0,
    bodyAge: 0,
    bmr: 0,
    protein: 0,
    heartIndex: 0,
    bone: 0,
    lbm: 0,
    subcutaneousFat: 0,
    skeletalMuscle: 0,
    score: 0,
    bodyShape: 0,
  };
}

interface SessionOptions {
  /** Wall clock when the session opens. */
  now: string;
  info?: Buffer;
  ready?: Buffer;
  profile?: Partial<UserProfile>;
  config?: AdapterRuntimeConfig;
}

/**
 * One 19-byte session in transport order with `qn_weight_ack` on (both
 * reporters' config): scale info, ready, config request, then 2 s for the
 * profile frame, 0x22 and the anchors to go out. Every write is collected,
 * with the time it went out. The caller runs fake timers.
 */
async function openSession(adapter: QnScaleAdapter, opts: SessionOptions) {
  vi.setSystemTime(new Date(opts.now));
  const writes: number[][] = [];
  const sentAt: number[] = [];
  const ctx = {
    write: async (_uuid: string, data: Buffer | number[]) => {
      writes.push([...data]);
      sentAt.push(Date.now());
    },
    read: async () => Buffer.alloc(0),
    subscribe: async () => {},
    profile: defaultProfile({ lastKnownWeight: 76, ...opts.profile }),
    deviceAddress: '',
    availableChars: new Set<string>(),
  } as unknown as ConnectionContext;
  adapter.configure(opts.config ?? { qnWeightAck: true });
  adapter.onSessionStart();
  await adapter.onConnected(ctx);
  adapter.parseNotification(opts.info ?? R07_SESSION.INFO);
  adapter.parseNotification(opts.ready ?? R07_SESSION.READY);
  adapter.parseNotification(R07_SESSION.CONFIG_REQ);
  await vi.advanceTimersByTimeAsync(2000);
  /** Every frame in order; the readings they return, nulls included. */
  const feed = (...frames: Buffer[]): (ScaleReading | null)[] =>
    frames.map((f) => adapter.parseNotification(f));
  const starts = (): number => writes.filter((w) => w[0] === 0x22).length;
  /** Milliseconds since the session's 0x22 went out. */
  const msSinceQuery = (): number => Date.now() - sentAt[writes.findIndex((w) => w[0] === 0x22)];
  return { writes, sentAt, feed, starts, msSinceQuery };
}

function spyLines(level: 'debug' | 'info') {
  const spy = vi.spyOn(bleLog, level).mockImplementation(() => {});
  return {
    lines: (): string[] => spy.mock.calls.map((c) => String(c[0])),
    restore: () => spy.mockRestore(),
  };
}

describe('QN 19-byte stored records (#331)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // The 2026-10-07 log: the scale handed over a weigh-in from 199 s before the
  // connect as five frames, which the adapter read as five empty records and
  // answered with re-queries.
  it('reports a fresh stored record once, with its own time, held, without a re-query', async () => {
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, { now: R07_CONNECTED });
    expect(s.starts()).toBe(1);
    const out = s.feed(R07_SESSION.VISIT_OK, ...R07_STORED);
    expect(out.slice(0, 5)).toEqual([null, null, null, null, null]);
    const reading = out[5]!;
    expect(reading).toEqual({ weight: 76.55, impedance: 0, timestamp: new Date(R07_RECORD_AT) });
    expect(isHistoricalReading(reading)).toBe(false);
    expect(adapter.isFinal(reading)).toBe(false);
    expect(adapter.completionHoldMs).toBe(NINETEEN_BYTE_RESULT_HOLD_MS);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.starts()).toBe(1);
  });

  it('reports an older stored record as history, without holding the link', async () => {
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, { now: '2026-10-07T20:10:00Z' });
    const reading = s.feed(...R07_STORED)[4]!;
    expect(reading).toEqual({ weight: 76.55, impedance: 0, timestamp: new Date(R07_RECORD_AT) });
    expect(isHistoricalReading(reading)).toBe(true);
    expect(adapter.completionHoldMs).toBeUndefined();
  });

  // The same log: the result block that follows the stored record is the
  // session's own result, which replaces the held record.
  it('lets the live result after a fresh stored record close the weigh-in', async () => {
    const info = spyLines('info');
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, { now: R07_CONNECTED });
    const stored = s.feed(...R07_STORED)[4]!;
    const [part1, , , , done] = s.feed(...R07_LIVE);
    expect(part1).toEqual({ weight: 76.55, impedance: 0 });
    expect(adapter.isFinal(part1!)).toBe(false);
    expect(done).toEqual({ weight: 76.55, impedance: 0, scaleComposition: expect.any(Object) });
    expect(adapter.isFinal(done!)).toBe(true);
    expect(adapter.isFinal(stored)).toBe(false);
    // The held record is gone once the live weight takes its place in the
    // hold, and the mark already counts it: the log keeps its weight and time.
    expect(info.lines()).toContain(
      `QN: a stored weigh-in (76.55 kg at ${R07_RECORD_AT}) is replaced by the weigh-in ` +
        'in progress (76.55 kg), not exported (#331)',
    );
  });

  it('says so when a later fresh stored record takes the place of the held one', async () => {
    const info = spyLines('info');
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, { now: R07_CONNECTED });
    const out = s.feed(
      ...storedRecordAt(R07_RECORD_AT, 1, 2),
      ...storedRecordAt('2026-10-07T19:58:25Z', 2, 2),
    );
    expect(out[4]?.timestamp).toEqual(new Date(R07_RECORD_AT));
    expect(out[9]?.timestamp).toEqual(new Date('2026-10-07T19:58:25Z'));
    expect(info.lines()).toContain(
      `QN: a stored weigh-in (76.55 kg at ${R07_RECORD_AT}) is replaced by a later stored ` +
        'weigh-in (76.55 kg at 2026-10-07T19:58:25.000Z), not exported (#331)',
    );
  });

  it('drops a fresh stored record while a live weight is held', async () => {
    const info = spyLines('info');
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, { now: '2026-10-07T19:58:25Z' });
    expect(s.feed(R06_SESSION.STABLE)[0]).toEqual({ weight: 76.85, impedance: 0 });
    expect(s.feed(...R07_STORED)[4]).toBeNull();
    expect(info.lines().some((l) => l.includes('superseded by the weigh-in in progress'))).toBe(
      true,
    );
  });

  it('keeps the newest reported record as a mark that survives a restart', async () => {
    const debug = spyLines('debug');
    const first = new QnScaleAdapter();
    let s = await openSession(first, { now: '2026-10-07T20:10:00Z' });
    expect(s.feed(...R07_STORED)[4]).not.toBeNull();
    expect(first.dedupMark()).toBe(844718245);

    // The same adapter in its next session.
    s = await openSession(first, { now: '2026-10-07T20:11:00Z' });
    expect(s.feed(...R07_STORED)[4]).toBeNull();

    // A new process with the mark restored.
    const restored = new QnScaleAdapter();
    restored.restoreDedupMark(844718245);
    s = await openSession(restored, { now: '2026-10-07T20:12:00Z' });
    expect(s.feed(...R07_STORED)[4]).toBeNull();
    expect(debug.lines().filter((l) => l.includes('was already reported'))).toHaveLength(2);
  });

  it.each([
    ['negative', -1],
    ['not a number', Number.NaN],
    ['not whole seconds', 844718245.5],
    ['two days past now', 844718245 + 2 * 86_400 + 600],
  ])('ignores a restored mark that is %s', async (_name, mark) => {
    const adapter = new QnScaleAdapter();
    vi.setSystemTime(new Date('2026-10-07T20:10:00Z'));
    adapter.restoreDedupMark(mark);
    expect(adapter.dedupMark()).toBeUndefined();
    const s = await openSession(adapter, { now: '2026-10-07T20:10:00Z' });
    expect(s.feed(...R07_STORED)[4]).not.toBeNull();
  });

  // The scale may hand over the weigh-in it just streamed as a stored record in
  // the next session; a proxy reconnects within seconds.
  it('drops a stored record that is the live result reported just before', async () => {
    const debug = spyLines('debug');
    const adapter = new QnScaleAdapter();
    // Session 1 publishes 76.55 kg 30 s after the record's time.
    let s = await openSession(adapter, { now: '2026-10-07T19:57:53Z' });
    expect(s.feed(...R07_LIVE)[4]).toEqual({
      weight: 76.55,
      impedance: 0,
      scaleComposition: expect.any(Object),
    });
    // Session 2 gets the same weigh-in as a stored record.
    s = await openSession(adapter, { now: '2026-10-07T19:59:30Z' });
    expect(s.feed(...R07_STORED)[4]).toBeNull();
    expect(debug.lines().some((l) => l.includes('is the live result reported at'))).toBe(true);

    // Without that live result the record goes out.
    const other = new QnScaleAdapter();
    s = await openSession(other, { now: '2026-10-07T19:59:30Z' });
    expect(s.feed(...R07_STORED)[4]).not.toBeNull();
  });

  it('drops a record the scale assigned to no user, saying so', async () => {
    const info = spyLines('info');
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, { now: '2026-10-07T20:10:00Z' });
    // Derived: R07's record with slot 0xf0.
    const unassigned = [patched(R07.S1, 1, 0xf0), ...R07_STORED.slice(1)];
    expect(s.feed(...unassigned)[4]).toBeNull();
    expect(info.lines()).toContain(
      `QN: a stored weigh-in (76.55 kg at 2026-10-07T19:57:25.000Z) is not exported: ` +
        'the scale did not assign it to a user (#331)',
    );
  });

  it.each([
    ['5 minutes ahead of now', '2026-10-07T19:52:25Z'],
    ['366 days old', '2027-10-08T19:57:25Z'],
  ])('drops a record stamped %s', async (_name, now) => {
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, { now });
    expect(s.feed(...R07_STORED)[4]).toBeNull();
  });

  // A batch need not come in time order. Judged against a mark that moved with
  // each record, the earlier record behind the later one would be dropped.
  it('reports both records of a batch whose second one is the older', async () => {
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, { now: '2026-10-07T21:00:00Z' });
    const later = storedRecordAt('2026-10-07T19:58:25Z', 1, 2);
    const earlier = storedRecordAt(R07_RECORD_AT, 2, 2);
    const out = s.feed(...later, ...earlier);
    expect(out[4]?.timestamp).toEqual(new Date('2026-10-07T19:58:25Z'));
    expect(out[9]?.timestamp).toEqual(new Date(R07_RECORD_AT));
    expect(adapter.dedupMark()).toBe(844718305);
  });

  it('drops a record whose parts come out of order', async () => {
    const debug = spyLines('debug');
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, { now: '2026-10-07T20:10:00Z' });
    expect(s.feed(R07.S1, R07.S3, R07.S2, R07.S24, R07.S25)).toEqual(new Array(5).fill(null));
    expect(debug.lines()).toContain(
      'QN: stored-record part 3/3 out of order, record dropped (#331)',
    );
  });

  // A result block that arrives with no measurement in its session and repeats
  // a result already published is that weigh-in handed over again.
  it('does not publish a repeated result block a second time', async () => {
    const debug = spyLines('debug');
    const adapter = new QnScaleAdapter();
    let s = await openSession(adapter, { now: '2026-10-07T20:00:44Z' });
    expect(s.feed(...R07_LIVE)[4]).toEqual({
      weight: 76.55,
      impedance: 0,
      scaleComposition: expect.any(Object),
    });

    s = await openSession(adapter, { now: '2026-10-07T20:02:44Z' });
    expect(s.feed(...R07_LIVE)).toEqual(new Array(5).fill(null));
    expect(adapter.completionHoldMs).toBeUndefined();
    expect(debug.lines().some((l) => l.includes('repeats the one reported at'))).toBe(true);

    // Measured in this session: a new weigh-in, even at the same weight.
    s = await openSession(adapter, { now: '2026-10-07T20:04:44Z' });
    const measured = s.feed(R06_SESSION.MEASURING, ...R07_LIVE);
    expect(measured[1]).toEqual({ weight: 76.55, impedance: 0 });
    expect(measured[5]).toEqual({
      weight: 76.55,
      impedance: 0,
      scaleComposition: expect.any(Object),
    });

    // Another weight: a new weigh-in.
    s = await openSession(adapter, { now: '2026-10-07T20:06:44Z' });
    const other = s.feed(patched(R07.P1, 5, 0x1e, 0x05), ...R07_LIVE.slice(1));
    expect(other[0]).toEqual({ weight: 76.85, impedance: 0 });
  });

  // A weight that settled just before the scale accepted the profile leaves
  // its session no live frame: the scale sends nothing during its BIA and
  // answers the 0x22 once it is done, about 13 s after the acceptance. That is
  // a new weigh-in even at the weight just published. The frames are the
  // reporter's; their order and timing are those of such a weigh-in.
  it('publishes a result block that answered the 0x22 long after the profile was accepted', async () => {
    const adapter = new QnScaleAdapter();
    let s = await openSession(adapter, { now: '2026-10-07T20:00:44Z' });
    expect(s.feed(...R07_LIVE)[4]).toEqual({
      weight: 76.55,
      impedance: 0,
      scaleComposition: expect.any(Object),
    });

    s = await openSession(adapter, { now: '2026-10-07T20:02:44Z' });
    s.feed(R07_SESSION.VISIT_OK);
    await vi.advanceTimersByTimeAsync(13_000);
    const out = s.feed(NO_RECORDS, ...R07_LIVE);
    expect(out[1]).toEqual({ weight: 76.55, impedance: 0 });
    expect(out[5]).toEqual({ weight: 76.55, impedance: 0, scaleComposition: expect.any(Object) });
  });

  // The same with no 0x23 before the block: its first part is the answer.
  it('times the answer from the result block when no 0x23 comes first', async () => {
    const adapter = new QnScaleAdapter();
    let s = await openSession(adapter, { now: '2026-10-07T20:00:44Z' });
    expect(s.feed(...R07_LIVE)[4]).toEqual({
      weight: 76.55,
      impedance: 0,
      scaleComposition: expect.any(Object),
    });

    s = await openSession(adapter, { now: '2026-10-07T20:02:44Z' });
    s.feed(R07_SESSION.VISIT_OK);
    await vi.advanceTimersByTimeAsync(13_000);
    const out = s.feed(...R07_LIVE);
    expect(out[0]).toEqual({ weight: 76.55, impedance: 0 });
    expect(out[4]).toEqual({ weight: 76.55, impedance: 0, scaleComposition: expect.any(Object) });
  });

  // Without a profile answer only the time since the 0x22 counts.
  it.each([
    [2_999, null],
    [3_000, { weight: 76.55, impedance: 0 }],
  ])('judges a repeated block by an answer %i ms after the 0x22 went out', async (ms, expected) => {
    const adapter = new QnScaleAdapter();
    let s = await openSession(adapter, { now: '2026-10-07T20:00:44Z' });
    expect(s.feed(...R07_LIVE)[4]).toEqual({
      weight: 76.55,
      impedance: 0,
      scaleComposition: expect.any(Object),
    });

    s = await openSession(adapter, { now: '2026-10-07T20:02:44Z' });
    await vi.advanceTimersByTimeAsync(ms - s.msSinceQuery());
    const out = s.feed(NO_RECORDS, ...R07_LIVE);
    expect(out[1]).toEqual(expected);
    expect(out[5]).toEqual(expected && { ...expected, scaleComposition: expect.any(Object) });
  });
});

describe("QN 19-byte: the scale's own body composition (#331)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const estimate = (profile: UserProfile, weight = 76.85) => buildPayload(weight, 0, {}, profile);

  /**
   * The 2026-10-06 weigh-in in order: the scale accepts the profile, measures,
   * settles, answers "no stored weigh-ins", then the result block. Returns the
   * 0x16 reading.
   */
  async function weighIn(
    opts: { profile?: Partial<UserProfile>; config?: AdapterRuntimeConfig } = {},
    frames: { visit?: Buffer | null; ready?: Buffer; live?: Buffer[] } = {},
  ) {
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, {
      now: '2026-10-06T15:10:52Z',
      info: R06_SESSION.INFO,
      profile: { ...P181, ...opts.profile },
      config: opts.config,
      ready: frames.ready,
    });
    const visit = frames.visit === undefined ? R06_SESSION.VISIT_OK : frames.visit;
    const out = s.feed(
      ...(visit ? [visit] : []),
      R06_SESSION.MEASURING,
      R06_SESSION.STABLE,
      NO_RECORDS,
      ...(frames.live ?? R06_LIVE),
    );
    const reading = out[out.length - 1];
    // Whether the scale's own results came with it is up to each test.
    expect({ ...reading, scaleComposition: undefined }).toEqual({ weight: 76.85, impedance: 0 });
    return { adapter, reading: reading! };
  }

  it("uses the scale's values when the matched user has the profile it was sent", async () => {
    const info = spyLines('info');
    const debug = spyLines('debug');
    const { adapter, reading } = await weighIn();
    // The scale's display shows the percentages; the log gives the kg exported.
    expect(debug.lines()).toContain(
      'QN: the scale reports muscle and bone as % of body weight: muscle 77.9 % (59.87 kg), ' +
        'bone 4.2 % (3.23 kg); exported in kg (#331)',
    );
    const payload = adapter.computeMetrics(reading, P181);
    expect(payload).toMatchObject({
      weight: 76.85,
      bodyFatPercent: 18,
      waterPercent: 59.1,
      // 77.9 % and 4.2 % of 76.85 kg.
      muscleMass: 59.87,
      boneMass: 3.23,
      visceralFat: 6,
      // 0x15 [11..12] and [10] (D078); the formulas give 1704 and 45.
      bmr: 1730,
      metabolicAge: 48,
    });
    expect(info.lines()).toContain(
      'QN: the scale sent its own body composition for this weigh-in (#331)',
    );
    expect(info.lines()).toContain(
      "QN: using the scale's own body composition for this weigh-in (#331)",
    );
    expect(debug.lines()).toContain(
      "QN: BMR 1730 kcal from the scale, metabolic age 48 from the scale's body age (#331)",
    );
  });

  // The reporter's app had 182 cm while the config sent 181: the scale's BMI
  // fits what we sent, so the composition is someone else's for a user at 182.
  it('estimates for a matched user whose profile differs from the one sent', async () => {
    const info = spyLines('info');
    const { adapter, reading } = await weighIn();
    const p182 = { ...P181, height: 182 };
    expect(adapter.computeMetrics(reading, p182)).toEqual(estimate(p182));
    expect(info.lines().some((l) => l.includes('is not the profile sent to the scale'))).toBe(true);
  });

  // 1800 mm sent and accepted, but the scale's BMI of 23.5 fits 1810: 0.22
  // off. A tolerance of a centimetre on the implied height would pass this.
  it("estimates when the scale's BMI does not fit the height sent to it", async () => {
    const info = spyLines('info');
    const p180 = { ...P181, height: 180 };
    const { adapter, reading } = await weighIn({ profile: p180 });
    expect(adapter.computeMetrics(reading, p180)).toEqual(estimate(p180));
    expect(info.lines().some((l) => l.includes('BMI does not fit the height'))).toBe(true);
  });

  it.each([
    ['a year older', { age: 41 }],
    ['a woman', { gender: 'female' as const }],
  ])('estimates when the matched user is %s, unlike the profile sent', async (_name, change) => {
    const { adapter, reading } = await weighIn();
    const other = { ...P181, ...change };
    expect(adapter.computeMetrics(reading, other)).toEqual(estimate(other));
  });

  // The vendor's published SDK has no athlete mode for these scales.
  it("uses the scale's values for an athlete, and says it has no athlete mode", async () => {
    const info = spyLines('info');
    const athlete = { ...P181, isAthlete: true };
    const { adapter, reading } = await weighIn({ profile: athlete });
    // BMR and body age as the scale sent them too: the athlete formulas give
    // 1789 and 40.
    expect(adapter.computeMetrics(reading, athlete)).toMatchObject({
      bodyFatPercent: 18,
      waterPercent: 59.1,
      bmr: 1730,
      metabolicAge: 48,
    });
    expect(info.lines()).toContain('QN: the scale computed it without an athlete mode (#331)');
  });

  // Derived frames: the scale's answer with 0 (refused) at [4], the ready frame
  // with bit 0 of [3] clear, the result block's first part with slot 2.
  it.each([
    [
      'the scale refused the profile',
      { visit: patched(R06_SESSION.VISIT_OK, 4, 0x00) },
      'the scale did not accept the profile',
    ],
    ['the scale never answered the profile', { visit: null }, 'did not answer the profile'],
    [
      'the scale reports its results as kilograms',
      { ready: patched(R07_SESSION.READY, 3, 0x00) },
      'did not report its results as percentages',
    ],
    [
      'the weigh-in is on another user slot',
      { live: [patched(R06.P1, 2, 0x02), ...R06_LIVE.slice(1)] },
      'on another user slot',
    ],
  ])('estimates when %s', async (_name, frames, reason) => {
    const info = spyLines('info');
    const { adapter, reading } = await weighIn({}, frames);
    expect(adapter.computeMetrics(reading, P181)).toEqual(estimate(P181));
    expect(info.lines().some((l) => l.includes(reason))).toBe(true);
  });

  // Without qn_weight_ack the 19-byte session sends openScale's constant
  // profile frame, which is nobody's.
  it('estimates when the session sent no profile of a configured user', async () => {
    const info = spyLines('info');
    const { adapter, reading } = await weighIn({ config: {} });
    expect(adapter.computeMetrics(reading, P181)).toEqual(estimate(P181));
    expect(info.lines().some((l) => l.includes('no profile of a configured user'))).toBe(true);
  });

  // Those frames overwrite the slot's stored segment values, which the scale
  // corrects its channels with, with values from someone else's capture.
  it('estimates in a session that sent the qn_a4_prelude frames', async () => {
    const { adapter, reading } = await weighIn({
      config: { qnWeightAck: true, qnA4Prelude: true },
    });
    expect(adapter.computeMetrics(reading, P181)).toEqual(estimate(P181));
  });

  /**
   * The 2026-10-06 frames in the order of a weigh-in whose weight settled just
   * before the scale accepted the profile: no live frame after the acceptance
   * (the scale sends none during its BIA), then, `answerMs` after it, "no
   * stored weigh-ins" and the result block (#331). Returns the 0x16 reading.
   */
  async function settledBeforeAccept(answerMs: number) {
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, {
      now: '2026-10-06T15:10:52Z',
      info: R06_SESSION.INFO,
      profile: P181,
    });
    s.feed(R06_SESSION.VISIT_OK);
    await vi.advanceTimersByTimeAsync(answerMs);
    const out = s.feed(NO_RECORDS, ...R06_LIVE);
    const reading = out[out.length - 1];
    expect(reading).toEqual({ weight: 76.85, impedance: 0, scaleComposition: expect.any(Object) });
    return { adapter, reading: reading! };
  }

  // The scale finished its BIA 13 s after it accepted the profile, so it
  // computed the result after accepting it, although no live frame followed.
  it("uses the scale's values when its weight settled just before it accepted the profile", async () => {
    const info = spyLines('info');
    const debug = spyLines('debug');
    const { adapter, reading } = await settledBeforeAccept(13_000);
    expect(adapter.computeMetrics(reading, P181)).toMatchObject({
      bodyFatPercent: 18,
      waterPercent: 59.1,
      muscleMass: 59.87,
      boneMass: 3.23,
      visceralFat: 6,
      bmr: 1730,
      metabolicAge: 48,
    });
    expect(info.lines()).toContain(
      "QN: using the scale's own body composition for this weigh-in (#331)",
    );
    expect(debug.lines()).toContain(
      'QN: the scale answered the stored-record query 14.6 s after it was sent, ' +
        '13.0 s after it accepted the profile (#331)',
    );
  });

  it.each([
    [2_999, false],
    [3_000, true],
  ])("uses the scale's values for an answer %i ms after the acceptance: %s", async (ms, used) => {
    const { adapter, reading } = await settledBeforeAccept(ms);
    const payload = adapter.computeMetrics(reading, P181);
    if (used) expect(payload.bodyFatPercent).toBe(18);
    else expect(payload).toEqual(estimate(P181));
  });

  // The 2026-10-07 log: the scale finished the weigh-in before the link came
  // up and sent its stored record and result 0.93 s after accepting our
  // profile. It may have computed them with the profile the slot held before
  // ours.
  it('estimates for a result the scale measured before it accepted the profile', async () => {
    const info = spyLines('info');
    const adapter = new QnScaleAdapter();
    const p182 = { ...P181, height: 182 };
    const s = await openSession(adapter, { now: R07_CONNECTED, profile: p182 });
    s.feed(R07_SESSION.VISIT_OK);
    await vi.advanceTimersByTimeAsync(928);
    const out = s.feed(...R07_STORED, ...R07_LIVE);
    const reading = out[out.length - 1]!;
    expect(reading).toEqual({ weight: 76.55, impedance: 0, scaleComposition: expect.any(Object) });
    expect(adapter.computeMetrics(reading, p182)).toEqual(estimate(p182, 76.55));
    expect(info.lines()).toContain(
      "QN: the scale's own body composition is not used for this weigh-in: the scale " +
        'answered 0.9 s after it accepted the profile, with no live weight in between, so it ' +
        'most likely measured before that; estimating instead (#331)',
    );
  });

  // #497: with the estimate off the line says what goes out instead.
  it('says it exports no body composition when the user turned the estimate off', async () => {
    const info = spyLines('info');
    const adapter = new QnScaleAdapter();
    const p182 = { ...P181, height: 182 };
    const s = await openSession(adapter, { now: R07_CONNECTED, profile: p182 });
    s.feed(R07_SESSION.VISIT_OK);
    await vi.advanceTimersByTimeAsync(928);
    const out = s.feed(...R07_STORED, ...R07_LIVE);
    const reading = out[out.length - 1]!;
    const off = { ...p182, estimateBodyComposition: false };
    expect(adapter.computeMetrics(reading, off).bodyFatPercent).toBeNull();
    expect(info.lines()).toContain(
      "QN: the scale's own body composition is not used for this weigh-in: the scale " +
        'answered 0.9 s after it accepted the profile, with no live weight in between, so it ' +
        'most likely measured before that; exporting no body composition ' +
        '(estimate_body_composition is off) (#331)',
    );
  });

  // Derived: the same weigh-in with a usable impedance. Body fat then comes
  // from that impedance, so the setting does not apply and the line says so.
  it('keeps estimating instead with a usable impedance and the estimate off', async () => {
    const info = spyLines('info');
    const adapter = new QnScaleAdapter();
    const p182 = { ...P181, height: 182 };
    const s = await openSession(adapter, { now: R07_CONNECTED, profile: p182 });
    s.feed(R07_SESSION.VISIT_OK);
    await vi.advanceTimersByTimeAsync(928);
    const out = s.feed(...R07_STORED, ...R07_LIVE);
    const reading = out[out.length - 1]!;
    reading.impedance = 500;
    const off = { ...p182, estimateBodyComposition: false };
    expect(adapter.computeMetrics(reading, off).bodyFatPercent).toEqual(expect.any(Number));
    expect(info.lines()).toContain(
      "QN: the scale's own body composition is not used for this weigh-in: the scale " +
        'answered 0.9 s after it accepted the profile, with no live weight in between, so it ' +
        'most likely measured before that; estimating instead (#331)',
    );
  });

  // Only the first answer counts. Derived timing: the same frames with the
  // result block 3 s after the stored record (in the log it came 0.85 s
  // after).
  it('judges by the first answer, not by a result block that comes later', async () => {
    const adapter = new QnScaleAdapter();
    const p182 = { ...P181, height: 182 };
    const s = await openSession(adapter, { now: R07_CONNECTED, profile: p182 });
    s.feed(R07_SESSION.VISIT_OK);
    await vi.advanceTimersByTimeAsync(928);
    s.feed(...R07_STORED);
    await vi.advanceTimersByTimeAsync(3_000);
    const reading = s.feed(...R07_LIVE)[4]!;
    expect(reading).toEqual({ weight: 76.55, impedance: 0, scaleComposition: expect.any(Object) });
    expect(adapter.computeMetrics(reading, p182)).toEqual(estimate(p182, 76.55));
  });

  it('pins nothing when the scale sent an all-zero block', async () => {
    const info = spyLines('info');
    const { adapter, reading } = await weighIn({}, { live: allZeroBlock() });
    expect(adapter.computeMetrics(reading, P181)).toEqual(estimate(P181));
    expect(info.lines()).toContain(
      'QN: the scale sent no body composition for this weigh-in (#331)',
    );
  });

  // Derived: 0x15 with the water at 0. The whole set goes, visceral fat,
  // BMR and body age included, which buildPayload would otherwise take on
  // their own.
  it('estimates everything, visceral fat included, when one value is not a measurement', async () => {
    const live = [...R06_LIVE];
    live[3] = patched(R06.C15, 5, 0x00, 0x00);
    const { adapter, reading } = await weighIn({}, { live });
    const payload = adapter.computeMetrics(reading, P181);
    expect(payload).toEqual(estimate(P181));
    expect(payload.visceralFat).not.toBe(6);
    expect(payload).toMatchObject({ bmr: 1704, metabolicAge: 45 });
  });

  // Derived: 0x15 with the BMR ([11..12]) or the body age ([10]) at 0 or at
  // the 0xff sentinel, checksum recomputed. Only that value falls back to its
  // formula (1704 kcal, 45 for P181); the other and the rest of the set stay
  // the scale's (D078).
  it.each([
    ['a BMR of 0', 11, [0x00, 0x00], 'bmr', 'BMR calculated (the scale sent 0 kcal)'],
    ['a BMR of 0xffff', 11, [0xff, 0xff], 'bmr', 'BMR calculated (the scale sent 65535 kcal)'],
    [
      'a body age of 0',
      10,
      [0x00],
      'metabolicAge',
      'metabolic age calculated (the scale sent a body age of 0)',
    ],
    [
      'a body age of 0xff',
      10,
      [0xff],
      'metabolicAge',
      'metabolic age calculated (the scale sent a body age of 255)',
    ],
  ] as const)(
    'calculates only that value when the scale sends %s',
    async (_name, at, bytes, field, logged) => {
      const debug = spyLines('debug');
      const live = [...R06_LIVE];
      live[3] = patched(R06.C15, at, ...bytes);
      const { adapter, reading } = await weighIn({}, { live });
      const payload = adapter.computeMetrics(reading, P181);
      const formula = estimate(P181);
      expect(payload).toMatchObject({
        bodyFatPercent: 18,
        waterPercent: 59.1,
        visceralFat: 6,
        bmr: field === 'bmr' ? formula.bmr : 1730,
        metabolicAge: field === 'metabolicAge' ? formula.metabolicAge : 48,
      });
      expect(formula).toMatchObject({ bmr: 1704, metabolicAge: 45 });
      expect(debug.lines().some((l) => l.includes(logged))).toBe(true);
    },
  );

  // The derived R07_FULL record carries the live block's BMR and body age, but
  // a stored record goes with its weight alone (D048 point 3), so both stay
  // the formulas', also after an accepted profile.
  it("keeps the formulas for a stored record that carries the scale's BMR and body age", async () => {
    const adapter = new QnScaleAdapter();
    const s = await openSession(adapter, { now: R07_CONNECTED });
    const out = s.feed(
      R07_SESSION.VISIT_OK,
      R07_FULL.S1,
      R07_FULL.S2,
      R07_FULL.S3,
      R07_FULL.S24,
      R07_FULL.S25,
    );
    const reading = out[5]!;
    expect(reading).toEqual({ weight: 76.55, impedance: 0, timestamp: new Date(R07_RECORD_AT) });
    const payload = adapter.computeMetrics(reading, P181);
    expect(payload).toEqual(buildPayload(76.55, 0, {}, P181));
    expect(payload).toMatchObject({ bmr: 1701, metabolicAge: 45 });
  });

  it('keeps the composition with the reading it was measured with', async () => {
    const first = await weighIn();
    // The next session of the same adapter opens before the first reading is
    // processed, as the proxy watchers allow.
    await openSession(first.adapter, { now: '2026-10-06T15:12:00Z', info: R06_SESSION.INFO });
    expect(first.adapter.computeMetrics(first.reading, P181).bodyFatPercent).toBe(18);
  });
});

describe('QN 19-byte: ble.qn_result_ack (#331)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * The end-of-measurement frame as the vendor's published SDK builds it, for
   * the protocol type 0xff of the reporter's scale-info frame.
   */
  const ACK = [0x1f, 0x05, 0xff, 0x10, 0x33];
  const ON: AdapterRuntimeConfig = { qnWeightAck: true, qnResultAck: true };

  /**
   * A 2026-10-06 session after its handshake; `after()` is every write since.
   * `now` is when it opens.
   */
  async function session(
    config: AdapterRuntimeConfig,
    now = '2026-10-06T15:10:52Z',
    adapter = new QnScaleAdapter(),
  ) {
    const s = await openSession(adapter, { now, info: R06_SESSION.INFO, profile: P181, config });
    const from = s.writes.length;
    return { adapter, s, after: () => s.writes.slice(from) };
  }

  /** The 2026-10-06 weigh-in up to the frame before its 0x16. */
  const UNTIL_D16 = [
    R06_SESSION.VISIT_OK,
    R06_SESSION.MEASURING,
    R06_SESSION.STABLE,
    NO_RECORDS,
    ...R06_LIVE.slice(0, 4),
  ];

  it('sends the 0x1F at the 0x16 of a complete result block, and not before', async () => {
    expect(hasValidSumChecksum(Buffer.from(ACK))).toBe(true);
    const { s, after } = await session(ON);
    s.feed(...UNTIL_D16);
    expect(after()).toEqual([]);
    expect(s.feed(R06.D16)[0]).toEqual({
      weight: 76.85,
      impedance: 0,
      scaleComposition: expect.any(Object),
    });
    expect(after()).toEqual([ACK]);
  });

  it.each([
    ['unset', { qnWeightAck: true }],
    ['false', { qnWeightAck: true, qnResultAck: false }],
  ])('sends nothing when the option is %s, and changes nothing else', async (_name, config) => {
    /** One weigh-in: its readings, info lines, debug lines and writes. */
    const run = async (c: AdapterRuntimeConfig) => {
      const info = spyLines('info');
      const debug = spyLines('debug');
      const { adapter, s, after } = await session(c);
      const out = s.feed(...UNTIL_D16, R06.D16);
      const payload = adapter.computeMetrics(out[out.length - 1]!, P181);
      // writeCmd logs a write once it has gone out.
      await vi.advanceTimersByTimeAsync(0);
      const result = { out, payload, info: info.lines(), debug: debug.lines(), writes: after() };
      info.restore();
      debug.restore();
      return result;
    };
    const off = await run(config);
    const on = await run(ON);
    expect(off.writes).toEqual([]);
    expect(on.writes).toEqual([ACK]);
    expect(off.out).toEqual(on.out);
    expect(off.payload).toEqual(on.payload);
    expect(off.info).toEqual(on.info);
    expect(on.debug.filter((l) => !off.debug.includes(l))).toEqual([
      'QN: 0x16 completes the result block, sending 0x1F as the vendor app does ' +
        '(ble.qn_result_ack, #331)',
      'QN write: [1f 05 ff 10 33]',
    ]);
  });

  // The vendor's SDK answers an all-zero block too; after one, a scale stored
  // a copy of the weigh-in it had delivered.
  it('sends it for an all-zero result block', async () => {
    const { s, after } = await session(ON);
    s.feed(R06_SESSION.VISIT_OK, R06_SESSION.MEASURING, R06_SESSION.STABLE, NO_RECORDS);
    s.feed(...allZeroBlock());
    expect(after()).toEqual([ACK]);
  });

  it('sends nothing for a result block that is missing a part', async () => {
    const debug = spyLines('debug');
    const { s, after } = await session(ON);
    s.feed(...UNTIL_D16.filter((f) => f !== R06.P2), R06.D16);
    expect(after()).toEqual([]);
    expect(debug.lines()).toContain(
      'QN: 0x16 without a complete result block, no 0x1F sent (ble.qn_result_ack, #331)',
    );
  });

  // The shape of the repeated-block test above: the block is not published
  // again, but the scale still gets its answer, as the SDK gives it.
  it('sends it for a repeated result block that is not published again', async () => {
    const adapter = new QnScaleAdapter();
    let { s, after } = await session(ON, '2026-10-07T20:00:44Z', adapter);
    expect(s.feed(...R07_LIVE)[4]).toEqual({
      weight: 76.55,
      impedance: 0,
      scaleComposition: expect.any(Object),
    });
    expect(after()).toEqual([ACK]);

    ({ s, after } = await session(ON, '2026-10-07T20:02:44Z', adapter));
    expect(s.feed(...R07_LIVE)).toEqual(new Array(5).fill(null));
    expect(after()).toEqual([ACK]);
  });

  // Derived: a repeated block leaves the session open, and the next block in
  // it (the 2026-10-06 one) arrives without its 0x15. The repeated block's
  // 0x15 does not complete it.
  it("does not count an earlier block's 0x15 toward the next block", async () => {
    const debug = spyLines('debug');
    const adapter = new QnScaleAdapter();
    let { s, after } = await session(ON, '2026-10-07T20:00:44Z', adapter);
    s.feed(...R07_LIVE);

    ({ s, after } = await session(ON, '2026-10-07T20:02:44Z', adapter));
    s.feed(...R07_LIVE);
    const out = s.feed(R06.P1, R06.P2, R06.P3, R06.D16);
    expect(out[3]).toEqual({ weight: 76.85, impedance: 0 });
    expect(after()).toEqual([ACK]);
    expect(debug.lines()).toContain(
      'QN: 0x16 without a complete result block, no 0x1F sent (ble.qn_result_ack, #331)',
    );
    expect(debug.lines()).toContain('QN: no complete result block for this weigh-in (#331)');
  });

  it('sends nothing for a stored record', async () => {
    const { s, after } = await session(ON, R07_CONNECTED);
    expect(s.feed(R07_SESSION.VISIT_OK, ...R07_STORED)[5]).not.toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(after()).toEqual([]);
  });

  // The session ends on the 0x16's reading in the same tick, which drops the
  // connection context, so the write has to be issued before that.
  it('writes the 0x1F before the session ends on the reading', async () => {
    const { adapter, s, after } = await session(ON);
    s.feed(...UNTIL_D16);
    expect(adapter.parseNotification(R06.D16)).not.toBeNull();
    adapter.onSessionEnd();
    expect(after()).toEqual([ACK]);
  });

  it('carries the protocol byte the session sends with', async () => {
    const { s, after } = await session({ ...ON, qnProtocolByte: 0x00 });
    s.feed(...UNTIL_D16, R06.D16);
    expect(after()).toEqual([[0x1f, 0x05, 0x00, 0x10, 0x34]]);
  });
});
