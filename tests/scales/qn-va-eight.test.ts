import { describe, it, expect } from 'vitest';
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
