import { describe, it, expect, beforeEach } from 'vitest';
import { ActiveEraAdapter } from '../../src/scales/active-era.js';
import {
  mockPeripheral,
  defaultProfile,
  expectMatches,
  parseOk,
  expectValidMetrics,
} from '../helpers/scale-test-utils.js';

/** 0xD5 weight frame: 24-bit BE weight at [3-5] (mask 0x3FFFF / 1000). */
function weightFrame(grams = 80000): Buffer {
  const buf = Buffer.alloc(20);
  buf[0] = 0xac; // magic
  buf[3] = (grams >> 16) & 0xff;
  buf[4] = (grams >> 8) & 0xff;
  buf[5] = grams & 0xff;
  buf[18] = 0xd5;
  return buf;
}

/** 0xD6 impedance frame: impedance uint16 BE at [4-5]. */
function impedanceFrame(value: number): Buffer {
  const buf = Buffer.alloc(20);
  buf[0] = 0xac;
  buf.writeUInt16BE(value, 4);
  buf[18] = 0xd6;
  return buf;
}

describe('ActiveEraAdapter', () => {
  let adapter: ActiveEraAdapter;
  beforeEach(() => {
    adapter = new ActiveEraAdapter();
  });

  describe('matches()', () => {
    it('matches "ae bs-06" name (case-insensitive), not unrelated', () => {
      expectMatches(adapter, {
        yes: ['ae bs-06', 'AE BS-06 Pro', 'AE BS-06'],
        no: ['Random Scale'],
      });
    });

    it('does not match by service UUID alone (removed to avoid MGB collision)', () => {
      expect(adapter.matches(mockPeripheral('Unknown', ['ffb0']))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses 0xD5 weight frame', () => {
      parseOk(adapter, weightFrame(), { weight: 80, impedance: 0 });
    });

    it('parses 0xD6 impedance frame after weight', () => {
      adapter.parseNotification(weightFrame());
      parseOk(adapter, impedanceFrame(500), { weight: 80, impedance: 500 });
    });

    it('applies impedance correction when >= 1500', () => {
      adapter.parseNotification(weightFrame());
      const reading = parseOk(adapter, impedanceFrame(1600)); // >= 1500 → correction
      // corrected: (1600 - 1000 + 80 * 10 * -0.4) / 0.6 / 10
      const expected = (1600 - 1000 + 80 * 10 * -0.4) / 0.6 / 10;
      expect(reading.impedance).toBeCloseTo(expected, 1);
    });

    it('returns null for wrong magic', () => {
      const buf = Buffer.alloc(20);
      buf[0] = 0xab; // wrong magic
      buf[18] = 0xd5;
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      expect(adapter.parseNotification(Buffer.alloc(19))).toBeNull();
    });

    it('returns null when no weight frame received yet', () => {
      expect(adapter.parseNotification(impedanceFrame(500))).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and impedance > 0', () => {
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      expect(adapter.isComplete({ weight: 0, impedance: 500 })).toBe(false);
    });

    it('returns false when impedance is 0', () => {
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition', () => {
      const payload = expectValidMetrics(adapter, { weight: 80, impedance: 500 });
      expect(payload.impedance).toBe(500);
    });

    it('returns zero weight in payload for zero weight input', () => {
      const payload = adapter.computeMetrics({ weight: 0, impedance: 0 }, defaultProfile());
      expect(payload.weight).toBe(0);
    });
  });
});

// #394: adapters are shared singletons. Before onSessionStart existed, a second
// weigh-in could resolve on the FIRST frame using the previous person's data.
//
// Every one of these also asserts that computeMetrics still carries the scale's
// own composition, because the first attempt at this fix cleared the caches in
// onSessionEnd - which runs BEFORE computeMetrics - and would have deleted the
// body composition from every reading while these tests stayed green.

describe('ActiveEraAdapter session boundary (#394)', () => {
  it('does not resolve the next session on the previous weight and impedance', () => {
    const a = new ActiveEraAdapter();
    a.parseNotification(weightFrame(80000));
    const first = a.parseNotification(impedanceFrame(500))!;
    expect(a.isComplete(first)).toBe(true);

    a.onSessionStart();

    // A 0xAC frame whose type byte is neither 0xD5 nor 0xD6 updates nothing.
    // It used to fall through and return the whole previous weigh-in.
    const stray = Buffer.alloc(20);
    stray[0] = 0xac;
    stray[18] = 0x00;
    expect(a.parseNotification(stray)).toBeNull();
  });

  it('does not corrupt the impedance correction with a stale weight', () => {
    // The >= 1500 branch multiplies cachedWeight in, so a stale weight makes
    // even a fresh impedance frame decode wrongly.
    const a = new ActiveEraAdapter();
    a.parseNotification(weightFrame(120000)); // 120 kg
    a.parseNotification(impedanceFrame(500));

    a.onSessionStart();

    // An impedance frame arriving BEFORE any weight frame of the new session
    // used to return a whole reading: the previous person's weight, with an
    // impedance the correction had computed FROM that stale weight. With the
    // cache cleared there is simply no weight yet, so there is no reading.
    expect(a.parseNotification(impedanceFrame(1600))).toBeNull();
  });
});
