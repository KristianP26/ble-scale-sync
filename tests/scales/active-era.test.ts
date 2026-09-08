import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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

/**
 * The raw `[4..5]` value is the single number that decides whether this
 * adapter's correction should carry its `/10` (#386). Until it was logged it was
 * unobtainable: `imp` was reassigned in place, so a reporter running with debug
 * on could only ever see the corrected figure, and the question could not be
 * answered by the only person able to answer it.
 */
describe('ActiveEraAdapter: raw impedance is observable (#386)', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { bleLog } = await import('../../src/ble/types.js');
    debugSpy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const logged = (): string => debugSpy.mock.calls.map((c) => String(c[0])).join(' | ');

  it('logs the raw value alongside the corrected one when the gate fires', () => {
    const adapter = new ActiveEraAdapter();
    adapter.parseNotification(weightFrame());
    adapter.parseNotification(impedanceFrame(1600));

    // Both numbers, so the reporter's paste answers the question by itself.
    expect(logged()).toContain('raw=1600');
    expect(logged()).toMatch(/corrected\s+46\.7 ohm/);
  });

  it('logs the raw value below the gate too, and says the gate did not fire', () => {
    const adapter = new ActiveEraAdapter();
    adapter.parseNotification(weightFrame());
    adapter.parseNotification(impedanceFrame(500));

    expect(logged()).toContain('raw=500');
    expect(logged()).toContain('below the 1500 correction gate');
  });

  it('reports the cached weight, which the correction multiplies in', () => {
    const adapter = new ActiveEraAdapter();
    adapter.parseNotification(weightFrame(80000));
    adapter.parseNotification(impedanceFrame(1600));

    expect(logged()).toContain('cached weight 80 kg');
  });
});
