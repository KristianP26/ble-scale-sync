import { describe, it, expect } from 'vitest';
import { YunmaiScaleAdapter } from '../../src/scales/yunmai.js';
import { applyForcedAdapter } from '../../src/scales/force.js';
import { computeBiaFat } from '../../src/scales/body-comp-helpers.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

/** Hex as printed in the logs; spaces are ignored. */
const frame = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// #474 (Yunmai Mini 2 M1690, ESPHome proxy, force_scale_adapter: Yunmai, DEBUG
// log 2026-10-18), derived from the captured frame with the personal values
// replaced, so the reporter's numbers stay out of the repo: the user id
// [9..12], weight [13..14], resistance [15..16] and body fat [17..18] are
// 0x1234, 80.00 kg, 470 and 25.50 %, and the XOR [19] is recomputed. Bytes
// [0..8] (start, version, length, type, [4], scale clock) are as captured.
const M1690_FINAL = frame('0d 1f 14 02 00 00 0c 51 ef 00 00 12 34 1f 40 01 d6 09 f6 ea');
// The frame sent 7 s earlier, when the scale recognised nobody ([9..12] = 0):
// weight, resistance and body fat replaced (75.00 kg, 520, 24.00 %), XOR
// recomputed.
const M1690_NO_USER = frame('0d 1f 14 02 00 00 0c 51 e8 00 00 00 00 1d 4c 02 08 09 60 8e');
// M1690_FINAL with the resistance [15..16] zeroed (weighed in socks, #257) and
// the XOR recomputed.
const M1690_NO_RESISTANCE = frame('0d 1f 14 02 00 00 0c 51 ef 00 00 12 34 1f 40 00 00 09 f6 3d');
// M1690_FINAL with [2] set to 0x13 and the XOR recomputed: a buffer that no
// longer says it holds the fields.
const M1690_DECLARES_19 = frame('0d 1f 13 02 00 00 0c 51 ef 00 00 12 34 1f 40 01 d6 09 f6 ed');
// Length boundaries nobody has seen on a real scale, cut from M1690_FINAL with
// [2] set to the new length and the XOR recomputed into the last byte: 19
// bytes (resistance field whole, body fat field cut, [18] is the XOR) and 17
// bytes (resistance field cut, [16] is the XOR).
const M1690_19_BYTES = frame('0d 1f 13 02 00 00 0c 51 ef 00 00 12 34 1f 40 01 d6 09 1b');
const M1690_17_BYTES = frame('0d 1f 11 02 00 00 0c 51 ef 00 00 12 34 1f 40 01 c6');
// openScale issue #1286 (YUNMAI-SIGNAL, protocol 0x13, openScale debug log
// 2026-01-15), byte for byte: 18 bytes, no body fat field, [17] is the XOR.
const SIGNAL_0X13 = frame('0d 13 12 02 00 00 00 00 6d 00 00 00 01 1f 1f 00 bb d4');

function makeAdapter() {
  return new YunmaiScaleAdapter();
}

// Synthetic, from before the fixture rule: the protocol stands on the captured
// frames above, this one only drives state and ordering (#394).
function makeFrame(opts: {
  protocolVer?: number;
  respType?: number;
  weightRaw?: number;
  impedanceRaw?: number;
  fatRaw?: number;
  length?: number;
}): Buffer {
  const len = opts.length ?? 20;
  const buf = Buffer.alloc(len);
  buf[0] = 0x0d; // marker
  buf[1] = opts.protocolVer ?? 0x1e; // protocol version
  buf[2] = len; // the frame's own length: it is what says the fields are there
  buf[3] = opts.respType ?? 0x02; // final frame
  // bytes 4: padding
  // bytes 5-8: timestamp (zeroed)
  // bytes 9-12: user id (zeroed)
  buf.writeUInt16BE(opts.weightRaw ?? 8000, 13); // 8000/100=80 kg
  if (len >= 18) {
    buf.writeUInt16BE(opts.impedanceRaw ?? 500, 15);
  }
  if (len >= 20) {
    buf.writeUInt16BE(opts.fatRaw ?? 2200, 17); // 2200/100=22%
  }
  // XOR only from 18 bytes: on a shorter buffer it would overwrite the weight.
  if (len >= 18) buf[len - 1] = buf.subarray(1, len - 1).reduce((x, b) => x ^ b, 0);
  return buf;
}

describe('YunmaiScaleAdapter', () => {
  describe('matches()', () => {
    it('matches "Yunmai" name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('Yunmai Standard', []);
      expect(adapter.matches(p)).toBe(true);
    });

    it('matches case-insensitively', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('YUNMAI', []);
      expect(adapter.matches(p)).toBe(true);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      const p = mockPeripheral('QN-Scale', []);
      expect(adapter.matches(p)).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('reads only the weight of a frame whose [2] does not match its length', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('YUNMAI-ISM2-W', []));
      adapter.onSessionStart();

      const reading = adapter.parseNotification(M1690_DECLARES_19)!;
      expect(reading).toEqual({ weight: 80, impedance: 0 });
      expect(adapter.completionHoldMs).toBeUndefined();
      // Nor its body fat: 25.50 % sits at [17..18], and only the frame has it.
      const profile = defaultProfile({ gender: 'female', age: 30, height: 165 });
      expect(adapter.computeMetrics(reading, profile).bodyFatPercent).not.toBeCloseTo(25.5, 1);
    });

    it('reads the resistance but no body fat from a 19-byte frame', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('YUNMAI-ISM2-W', []));
      adapter.onSessionStart();

      const reading = adapter.parseNotification(M1690_19_BYTES)!;
      expect(reading).toEqual({ weight: 80, impedance: 470 });
      // Without a body fat field this is the Yunmai formula, the value a fresh
      // adapter with nothing pinned computes for the same reading; reading
      // [17..18] here would give 23.31 % from the cut field and the XOR.
      const profile = defaultProfile({ gender: 'female', age: 30, height: 165 });
      expect(adapter.computeMetrics(reading, profile).bodyFatPercent).toBeCloseTo(
        makeAdapter().computeMetrics({ weight: 80, impedance: 470 }, profile).bodyFatPercent,
        5,
      );
    });

    it('reads only the weight of a 17-byte frame', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('YUNMAI-ISM2-W', []));
      adapter.onSessionStart();

      expect(adapter.parseNotification(M1690_17_BYTES)).toEqual({ weight: 80, impedance: 0 });
      expect(adapter.completionHoldMs).toBeUndefined();
    });

    it('parses a frame that declares the resistance field', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));

      const buf = makeFrame({ weightRaw: 8000, impedanceRaw: 480 });
      const reading = adapter.parseNotification(buf);

      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(480);
    });

    it('returns null for non-final frame (respType != 0x02)', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));

      const buf = makeFrame({ respType: 0x01 }); // measuring, not final
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(10))).toBeNull();
    });

    it('returns null for zero weight', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []));
      const buf = makeFrame({ weightRaw: 0 });
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('complete when weight > 0', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []));
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('incomplete when weight = 0', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []));
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });

    it('complete on weight (impedance preferred via hold, not required)', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));
      // #257: a weight-only final frame is complete so a unit that never reports
      // impedance resolves weight-only instead of hanging until the read timeout.
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });
  });

  describe('completion hold (#257)', () => {
    it('a frame with an empty resistance field arms a hold so impedance can arrive', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('YUNMAI-ISSE-US', []));
      adapter.onSessionStart();
      const empty = adapter.parseNotification(M1690_NO_RESISTANCE)!;
      expect(adapter.completionHoldMs).toBe(4000);
      expect(adapter.isFinal(empty)).toBe(false);
    });

    it('a frame without the resistance field sets no hold (resolves immediately)', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('YUNMAI-ISSE-US', []));
      adapter.onSessionStart();
      adapter.parseNotification(M1690_DECLARES_19);
      expect(adapter.completionHoldMs).toBeUndefined();
    });

    it('isFinal resolves immediately once impedance is present', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISSE', []));
      expect(adapter.isFinal({ weight: 80, impedance: 500 })).toBe(true);
      expect(adapter.isFinal({ weight: 80, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid payload without impedance', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []));

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 0 }, profile);

      expect(payload.weight).toBe(80);
      assertPayloadRanges(payload);
    });

    it('returns valid payload with impedance', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));

      // Parse a frame to set embedded fat
      const buf = makeFrame({ protocolVer: 0x1e, fatRaw: 2200, impedanceRaw: 500 });
      adapter.parseNotification(buf);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);

      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(500);
      assertPayloadRanges(payload);
    });

    it('uses embedded fat percent when available', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));

      // Parse with embedded fat = 22%
      const buf = makeFrame({ protocolVer: 0x1e, fatRaw: 2200, impedanceRaw: 500 });
      adapter.parseNotification(buf);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);

      // The embedded fat (22%) should be used
      expect(payload.bodyFatPercent).toBeCloseTo(22, 0);
    });
  });
});

describe('Yunmai: the final frame says what it carries, not the name (#474)', () => {
  const ADDRESS = '0C:1C:00:00:00:01';
  // What the #474 reporter runs: the adapter forced onto an advertisement that
  // gives it no Yunmai name to go by. matches() runs for its side effects, as
  // the watcher calls it; the forced proxy claims the device either way.
  function forcedNameless() {
    const forced = applyForcedAdapter([new YunmaiScaleAdapter()], 'Yunmai')[0];
    forced.matches({ localName: '', address: ADDRESS, serviceUuids: [] });
    forced.onSessionStart?.(ADDRESS.replace(/:/g, ''));
    return forced;
  }

  it('reads the resistance of a forced unit that advertised no name', () => {
    expect(forcedNameless().parseNotification!(M1690_FINAL)).toEqual({
      weight: 80,
      impedance: 470,
    });
  });

  it('keeps a frame whose user the scale did not recognise as a weigh-in', () => {
    expect(forcedNameless().parseNotification!(M1690_NO_USER)).toEqual({
      weight: 75,
      impedance: 520,
    });
  });

  it('uses the body fat the scale put into a 0x1F frame', () => {
    const forced = forcedNameless();
    const reading = forced.parseNotification!(M1690_FINAL)!;
    // The BMI estimate (37 %) and the Yunmai formula (41 %) are both far from
    // 25.50 % for this profile, so only the frame can produce it.
    const profile = defaultProfile({ gender: 'female', age: 30, height: 165 });
    expect(forced.computeMetrics!(reading, profile).bodyFatPercent).toBeCloseTo(25.5, 1);
  });

  it('holds after a frame whose resistance field is empty, not after one that has it', () => {
    const forced = forcedNameless();
    const empty = forced.parseNotification!(M1690_NO_RESISTANCE)!;
    expect(forced.completionHoldMs).toBe(4000);
    expect(forced.isFinal!(empty)).toBe(false);
    expect(forced.isFinal!(forced.parseNotification!(M1690_FINAL)!)).toBe(true);
  });

  it('reads the resistance of an 18-byte 0x13 frame', () => {
    const a = new YunmaiScaleAdapter();
    // openScale counts SIGNAL as a Mini; this adapter used to call it standard.
    expect(a.matches({ localName: 'YUNMAI-SIGNAL', serviceUuids: [] })).toBe(true);
    a.onSessionStart();
    expect(a.parseNotification(SIGNAL_0X13)).toEqual({ weight: 79.67, impedance: 187 });
  });

  // Names from openScale's YunmaiHandler (Mini class SIGNAL / ISM / ISC2P /
  // Scale-3, SE = ISSE). Whatever the unit is called, the frame decides.
  it.each([
    'YUNMAI-ISM2-W',
    'YUNMAI-ISSE-US',
    'YUNMAI-SIGNAL-M1WS',
    'YUNMAI-ISC2P-US',
    'YUNMAI-Scale-3',
  ])('reads the same frame the same way for %s', (localName) => {
    const a = new YunmaiScaleAdapter();
    expect(a.matches({ localName, serviceUuids: [] })).toBe(true);
    a.onSessionStart();
    expect(a.parseNotification(M1690_FINAL)).toEqual({ weight: 80, impedance: 470 });
    expect(a.completionHoldMs).toBe(4000);
  });
});

// #394: adapters are shared singletons and computeMetrics() runs LATER than the
// parse that produced the reading. On the mqtt-proxy and esphome-proxy watchers
// the loop awaits processReading() - network exports included - while the
// watcher is free to open the NEXT session, so onSessionStart() for session N+1
// can land BEFORE computeMetrics() for session N. Reading the live cache there
// hands the completed reading somebody else's composition.
//
// Each test below interleaves the two in exactly that order. Asserting only on
// the payload of an uninterrupted session would pass with or without the fix.

describe('YunmaiScaleAdapter session boundary (#394)', () => {
  function miniAdapter() {
    const a = makeAdapter();
    // The name only claims the device; the frame decides what is read.
    a.matches({ localName: 'YUNMAI-ISM', serviceUuids: [] });
    return a;
  }

  it('keeps the completed reading embedded fat when the NEXT session starts first', () => {
    const a = miniAdapter();
    // impedanceRaw 0 so the embedded fat is the ONLY source of 22 %. With the
    // frame default impedance the BIA branch lands near 22 % on its own and the
    // test would pass whether or not the value was pinned.
    const reading = a.parseNotification(makeFrame({ fatRaw: 2200, impedanceRaw: 0 }))!;
    a.onSessionStart();
    const payload = a.computeMetrics(reading, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(22, 1);
  });

  // ReadingComposition.of() checks has(), not `?? live`. That distinction is the
  // helper's one real subtlety and nothing else exercises it: Yunmai is the only
  // current user whose "no composition" state is ITSELF a value (null), so with
  // a nullish fallback a legitimately-null pin would silently fall through to
  // the live field. Mutating of() to `?? live` leaves the whole suite green
  // except this test.
  it('a pinned null is honoured, not treated as absent', () => {
    const a = miniAdapter();
    // Session N: protocol < 0x1E, so no embedded fat is read and null is pinned.
    const readingN = a.parseNotification(
      makeFrame({ protocolVer: 0x1d, impedanceRaw: 0, weightRaw: 8000 }),
    )!;
    // Session N+1 starts and parses a frame that DOES carry embedded fat,
    // before N's computeMetrics runs - the watcher-transport ordering.
    a.onSessionStart();
    a.parseNotification(makeFrame({ fatRaw: 2200, impedanceRaw: 0 }));

    const payload = a.computeMetrics(readingN, defaultProfile());
    // N must get the estimator, not the next person's 22 %.
    expect(payload.bodyFatPercent).not.toBeCloseTo(22, 1);
  });

  it('does not hand a hand-built reading the previous session embedded fat', () => {
    const a = miniAdapter();
    a.parseNotification(makeFrame({ fatRaw: 2200 }));
    a.onSessionStart();
    // Impedance 0 and no pinned value: must fall through to the estimator, not
    // to the 22 % the previous weigh-in left behind.
    const payload = a.computeMetrics({ weight: 80, impedance: 0 }, defaultProfile());
    expect(payload.bodyFatPercent).not.toBeCloseTo(22, 1);
  });
});

// D-08 / ADR D028: YunmaiCalc.fat() returns 0 for "outside 5-75 %", which is
// reachable from a real impedance at a BMI around 50 and above. Every other
// field was then derived from that 0: a visceral rating of 1 next to 60 % body
// fat. The composition is one set, so all of it has to come from the fat value
// that is actually exported.
describe('Yunmai when its own fat formula gives up (D-08, D028)', () => {
  // BMI 55: the Yunmai equation lands above 75 % and is discarded.
  const profile = defaultProfile({ gender: 'female', height: 160, age: 40 });
  const reading = () => ({ weight: 141, impedance: 500 });

  it('falls back to BIA on the plausible impedance, as the processor would', () => {
    const payload = makeAdapter().computeMetrics(reading(), profile);
    expect(payload.bodyFatPercent).toBeCloseTo(computeBiaFat(141, 500, profile), 1);
  });

  it('derives water, muscle, bone and visceral fat from that same fat value', () => {
    const payload = makeAdapter().computeMetrics(reading(), profile);
    // Yunmai's water equation, (100 - fat) * 0.726, on the exported fat.
    expect(payload.waterPercent).toBeCloseTo((100 - payload.bodyFatPercent) * 0.726, 1);
    // Was 1, the rating Yunmai's formula gives a body with no fat at all.
    expect(payload.visceralFat).toBeGreaterThan(20);
    expect(payload.bodyFatPercent + payload.waterPercent).toBeLessThan(100);
    assertPayloadRanges(payload);
  });

  it('keeps the Yunmai equation whenever it gives a usable value', () => {
    const typical = defaultProfile();
    const payload = makeAdapter().computeMetrics({ weight: 80, impedance: 500 }, typical);
    expect(payload.bodyFatPercent).not.toBeCloseTo(computeBiaFat(80, 500, typical), 1);
  });
});
