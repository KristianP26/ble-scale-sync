import { describe, it, expect } from 'vitest';
import { YunmaiScaleAdapter } from '../../src/scales/yunmai.js';
import { applyForcedAdapter } from '../../src/scales/force.js';
import { computeBiaFat, estimateBodyFat, uuid16 } from '../../src/scales/body-comp-helpers.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';
import {
  M1690_ADVERT,
  M1690_FE95_PID_018E,
  M1690_LIVE_80KG,
  M1690_PROTOCOL_VERSION_REPLY,
  M1690_REPLY_WRONG_LENGTH,
} from '../helpers/yunmai-m1690.js';
import type { ScaleAdapter } from '../../src/interfaces/scale-adapter.js';

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
// M1690_FINAL with the protocol version [1] set to 0x1D and 0x1E, XOR
// recomputed: the body fat field is read from 0x1E on (openScale uses its
// formula below that). No real 20-byte frame below 0x1F is on record.
const M1690_PROTO_1D = frame('0d 1d 14 02 00 00 0c 51 ef 00 00 12 34 1f 40 01 d6 09 f6 e8');
const M1690_PROTO_1E = frame('0d 1e 14 02 00 00 0c 51 ef 00 00 12 34 1f 40 01 d6 09 f6 eb');
// M1690_FINAL with the response type [3] set to 0x01 (measuring) and the XOR
// recomputed. A real measuring frame is 11 bytes; this one keeps the final
// layout so only [3] can be what rejects it.
const M1690_TYPE_MEASURING = frame('0d 1f 14 01 00 00 0c 51 ef 00 00 12 34 1f 40 01 d6 09 f6 e9');
// M1690_FINAL with the weight [13..14] zeroed and the XOR recomputed.
const M1690_ZERO_WEIGHT = frame('0d 1f 14 02 00 00 0c 51 ef 00 00 12 34 00 00 01 d6 09 f6 b5');
// openScale issue #1286 (YUNMAI-SIGNAL, protocol 0x13, openScale debug log
// 2026-01-15), byte for byte: 18 bytes, no body fat field, [17] is the XOR.
const SIGNAL_0X13 = frame('0d 13 12 02 00 00 00 00 6d 00 00 00 01 1f 1f 00 bb d4');
// SIGNAL_0X13 with the weight [13..14] set to 141.00 kg (0x3714) and the XOR
// [17] recomputed; the resistance 187 at [15..16] is as captured.
const SIGNAL_0X13_141KG = frame('0d 13 12 02 00 00 00 00 6d 00 00 00 01 37 14 00 bb f7');
// openScale issue #1286 (YUNMAI-SIGNAL, protocol 0x13, openScale debug log
// 2026-01-15), byte for byte: the reply to GET_PROTOCOL_VERSION `0d 05 13 00 16`.
const SIGNAL_0X13_PROTOCOL_VERSION_REPLY = frame('0d 13 05 05 13');
// The same log, byte for byte: a live 0x01 frame with weight 79.86 kg and one
// with weight 0, which the SIGNAL alternates with it during a weigh-in.
const SIGNAL_0X13_LIVE = frame('0d 13 0b 01 00 00 00 49 1f 32 7d');
const SIGNAL_0X13_LIVE_ZERO = frame('0d 13 0b 01 00 00 00 49 00 00 50');

function makeAdapter() {
  return new YunmaiScaleAdapter();
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

    // #474: the Mini 2 there advertises no name, only Xiaomi 0xFE95 service data.
    it('matches the nameless Mini 2 (M1690) by its MiBeacon product id 0x018D', () => {
      expect(makeAdapter().matches(M1690_ADVERT)).toBe(true);
    });

    // Holds on the code before #474 too: only 0x018D is claimed.
    it('does not match another MiBeacon product id', () => {
      const other = { ...M1690_ADVERT, serviceData: [{ uuid: 'fe95', data: M1690_FE95_PID_018E }] };
      expect(makeAdapter().matches(other)).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('reads only the weight of a frame whose [2] does not match its length', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('YUNMAI-ISM2-W', []));
      adapter.onSessionStart();

      const reading = adapter.parseNotification(M1690_DECLARES_19)!;
      expect(reading).toEqual({ weight: 80, impedance: 0, scaleComposition: null });
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
      expect(reading).toEqual({ weight: 80, impedance: 470, scaleComposition: null });
      // Without a body fat field this is the Yunmai formula, the value a fresh
      // adapter with nothing pinned computes for the same reading; reading
      // [17..18] here would give 23.31 % from the cut field and the XOR.
      const profile = defaultProfile({ gender: 'female', age: 30, height: 165 });
      expect(adapter.computeMetrics(reading, profile).bodyFatPercent).toBeCloseTo(
        makeAdapter().computeMetrics({ weight: 80, impedance: 470 }, profile).bodyFatPercent!,
        5,
      );
    });

    it('reads only the weight of a 17-byte frame', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('YUNMAI-ISM2-W', []));
      adapter.onSessionStart();

      expect(adapter.parseNotification(M1690_17_BYTES)).toEqual({
        weight: 80,
        impedance: 0,
        scaleComposition: null,
      });
      expect(adapter.completionHoldMs).toBeUndefined();
    });

    it('returns null for non-final frame (respType != 0x02)', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai ISM', []));

      expect(adapter.parseNotification(M1690_TYPE_MEASURING)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(10))).toBeNull();
    });

    it('returns null for zero weight', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('Yunmai Standard', []));
      expect(adapter.parseNotification(M1690_ZERO_WEIGHT)).toBeNull();
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

      const reading = adapter.parseNotification(M1690_FINAL)!;
      const payload = adapter.computeMetrics(reading, defaultProfile());

      expect(payload.weight).toBe(80);
      expect(payload.impedance).toBe(470);
      assertPayloadRanges(payload);
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
      scaleComposition: 25.5,
    });
  });

  it('keeps a frame whose user the scale did not recognise as a weigh-in', () => {
    expect(forcedNameless().parseNotification!(M1690_NO_USER)).toEqual({
      weight: 75,
      impedance: 520,
      scaleComposition: 24,
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

  it('reads the body fat field from protocol 0x1E on, not below it', () => {
    // The BMI estimate (37 %) and the Yunmai formula (41 %) are far from the
    // 25.50 % in the frame for this profile.
    const profile = defaultProfile({ gender: 'female', age: 30, height: 165 });
    const fatOf = (f: Buffer) => {
      const a = new YunmaiScaleAdapter();
      a.onSessionStart();
      return a.computeMetrics(a.parseNotification(f)!, profile).bodyFatPercent;
    };
    expect(fatOf(M1690_PROTO_1E)).toBeCloseTo(25.5, 1);
    expect(fatOf(M1690_PROTO_1D)).not.toBeCloseTo(25.5, 0);
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
    expect(a.parseNotification(SIGNAL_0X13)).toEqual({
      weight: 79.67,
      impedance: 187,
      scaleComposition: null,
    });
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
    expect(a.parseNotification(M1690_FINAL)).toEqual({
      weight: 80,
      impedance: 470,
      scaleComposition: 25.5,
    });
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
    // Resistance 0 so the scale's 25.50 % is the ONLY source of that value: the
    // BMI estimate for this profile is about 19 %.
    const reading = a.parseNotification(M1690_NO_RESISTANCE)!;
    a.onSessionStart();
    const payload = a.computeMetrics(reading, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(25.5, 1);
  });

  // computeMetrics checks `scaleComposition === undefined`, not `?? live`:
  // Yunmai's "no composition" state is ITSELF a value (null), so with a nullish
  // fallback a legitimately-null pin would silently fall through to the live
  // field. Mutating it to `?? live` fails this test and the Yunmai A-02 and X-11
  // contracts.
  it('a pinned null is honoured, not treated as absent', () => {
    const a = miniAdapter();
    // Session N: an 18-byte 0x13 frame has no body fat field, so null is pinned.
    const readingN = a.parseNotification(SIGNAL_0X13)!;
    // Session N+1 starts and parses a frame that DOES carry the scale's body
    // fat, before N's computeMetrics runs - the watcher-transport ordering.
    a.onSessionStart();
    a.parseNotification(M1690_NO_RESISTANCE);

    const payload = a.computeMetrics(readingN, defaultProfile());
    // N must get the Yunmai formula (about 21 %), not the next person's 25.50 %.
    expect(payload.bodyFatPercent).not.toBeCloseTo(25.5, 1);
  });

  it('does not hand a hand-built reading the previous session embedded fat', () => {
    const a = miniAdapter();
    a.parseNotification(M1690_FINAL);
    a.onSessionStart();
    // Impedance 0 and no pinned value: must fall through to the estimator, not
    // to the 25.50 % the previous weigh-in left behind.
    const payload = a.computeMetrics({ weight: 80, impedance: 0 }, defaultProfile());
    expect(payload.bodyFatPercent).not.toBeCloseTo(25.5, 1);
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

  // A SIGNAL resistance from 150 up passes the 150-1200 gate (187 here), but
  // nothing shows it is in ohms; generic BIA on it gave 33 % against the 60 %
  // estimate.
  it('falls back to the BMI estimate, not BIA on a resistance of unknown unit', () => {
    const a = makeAdapter();
    a.onSessionStart();
    const parsed = a.parseNotification(SIGNAL_0X13_141KG)!;
    expect(parsed).toEqual({ weight: 141, impedance: 187, scaleComposition: null });
    const payload = a.computeMetrics(parsed, profile);
    expect(payload.bodyFatPercent).toBeCloseTo(estimateBodyFat(141 / 1.6 ** 2, profile), 1);
    expect(payload.bodyFatPercent).not.toBeCloseTo(computeBiaFat(141, 187, profile), 0);
  });

  it('derives water, muscle, bone and visceral fat from that same fat value', () => {
    const payload = makeAdapter().computeMetrics(reading(), profile);
    // Yunmai's water equation, (100 - fat) * 0.726, on the exported fat.
    expect(payload.waterPercent).toBeCloseTo((100 - payload.bodyFatPercent!) * 0.726, 1);
    // Was 1, the rating Yunmai's formula gives a body with no fat at all.
    expect(payload.visceralFat).toBeGreaterThan(20);
    expect(payload.bodyFatPercent! + payload.waterPercent!).toBeLessThan(100);
    assertPayloadRanges(payload);
  });

  it('keeps the Yunmai equation whenever it gives a usable value', () => {
    const typical = defaultProfile();
    const payload = makeAdapter().computeMetrics({ weight: 80, impedance: 500 }, typical);
    expect(payload.bodyFatPercent).not.toBeCloseTo(computeBiaFat(80, 500, typical), 1);
  });
});

describe('Yunmai: the reply to the unlock is not a weigh-in (#474, D070)', () => {
  const MEAS = uuid16(0xffe4);
  // Typed as the registry sees it, so the optional hook is called the way
  // waitForRawReading calls it.
  const adapter = (): ScaleAdapter => new YunmaiScaleAdapter();

  it('calls the reply to GET_PROTOCOL_VERSION a status frame, on protocol 0x1F and 0x13', () => {
    expect(adapter().isStatusFrame?.(MEAS, M1690_PROTOCOL_VERSION_REPLY)).toBe(true);
    expect(adapter().isStatusFrame?.(MEAS, SIGNAL_0X13_PROTOCOL_VERSION_REPLY)).toBe(true);
  });

  it('never calls a live or a final frame a status frame', () => {
    for (const f of [
      M1690_LIVE_80KG,
      M1690_FINAL,
      M1690_NO_RESISTANCE,
      SIGNAL_0X13,
      SIGNAL_0X13_LIVE,
      SIGNAL_0X13_LIVE_ZERO,
    ]) {
      expect(adapter().isStatusFrame?.(MEAS, f), f.toString('hex')).toBe(false);
    }
  });

  it('does not call a reply whose [2] is not its length a status frame', () => {
    expect(adapter().isStatusFrame?.(MEAS, M1690_REPLY_WRONG_LENGTH)).toBe(false);
  });

  it('answers through the force_scale_adapter wrapper too', () => {
    // The #474 reporter's configuration: force_scale_adapter: Yunmai.
    const forced = applyForcedAdapter([new YunmaiScaleAdapter()], 'Yunmai')[0];
    expect(forced.isStatusFrame?.(MEAS, M1690_PROTOCOL_VERSION_REPLY)).toBe(true);
    expect(forced.isStatusFrame?.(MEAS, M1690_LIVE_80KG)).toBe(false);
  });

  it('parses neither the reply nor a live frame', () => {
    const a = makeAdapter();
    expect(a.parseNotification(M1690_PROTOCOL_VERSION_REPLY)).toBeNull();
    expect(a.parseNotification(SIGNAL_0X13_PROTOCOL_VERSION_REPLY)).toBeNull();
    expect(a.parseNotification(M1690_LIVE_80KG)).toBeNull();
    expect(a.parseNotification(SIGNAL_0X13_LIVE)).toBeNull();
  });
});
