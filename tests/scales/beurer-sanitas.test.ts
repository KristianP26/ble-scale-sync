import { describe, it, expect } from 'vitest';
import { BeurerSanitasScaleAdapter } from '../../src/scales/beurer-sanitas.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new BeurerSanitasScaleAdapter();
}

describe('BeurerSanitasScaleAdapter', () => {
  describe('matches()', () => {
    it.each([
      'bf-700',
      'beurer bf700',
      'bf-800',
      'beurer bf800',
      'rt-libra-b',
      'rt-libra-w',
      'libra-b',
      'libra-w',
      'bf700',
      'beurer bf710',
      'sanitas sbf70',
      'sbf75',
      'aicdscale1',
    ])('matches "%s"', (name) => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('BF-700'))).toBe(true);
      expect(adapter.matches(mockPeripheral('BEURER BF700'))).toBe(true);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  // Frames byte-for-byte from the #384 debug log (Sanitas SBF70 over an ESPHome
  // proxy, adapter forced so matches() never ran).
  describe('variant latching from the frame, without a name (#384)', () => {
    it('reads the 5-byte 0xE7 0x58 live frame as weight, not as nothing', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(Buffer.from('e758010713', 'hex'));
      // 0x0713 = 1811, * 50 / 1000 = 90.55 kg, the reporter's real ~90 kg.
      expect(reading?.weight).toBeCloseTo(90.55, 2);
    });

    it('never decodes the 0x59 finalize frame as the bogus constant 12.80 kg', () => {
      const adapter = makeAdapter();
      adapter.parseNotification(Buffer.from('e758010713', 'hex'));
      const reading = adapter.parseNotification(Buffer.from('e759030101000000000000000065', 'hex'));
      expect(reading?.weight).not.toBeCloseTo(12.8, 2);
    });

    it('decodes the same 0x59 frame as 12.80 kg only on the BF700 layout, which is the bug', () => {
      // Guards the discriminator itself: a BF700 frame opens with a Unix
      // timestamp, so its top byte is nowhere near 0xE7 and the latch stays off.
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('bf-700'));
      const bf700 = Buffer.from('69000000012c00000000000000000000', 'hex');
      expect(adapter.parseNotification(bf700)?.weight).toBeGreaterThan(0);
    });

    it('leaves a BF700 on its own layout, since no frame of its starts 0xE7', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('bf-700'));
      expect(adapter.unlockCommand).toEqual([0xf7, 0x01]);
    });
  });

  describe('unlockCommand', () => {
    it('returns 0xF7 for BF700/BF800 type', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('bf-700'));
      expect(adapter.unlockCommand[0]).toBe(0xf7);
    });

    it('returns 0xE7 for BF710/Sanitas type', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('beurer bf710'));
      expect(adapter.unlockCommand[0]).toBe(0xe7);
    });

    it('returns 0xE7 for SBF70', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('sanitas sbf70'));
      expect(adapter.unlockCommand[0]).toBe(0xe7);
    });

    it('returns 0xE7 for aicdscale1', () => {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('aicdscale1'));
      expect(adapter.unlockCommand[0]).toBe(0xe7);
    });
  });

  describe('parseNotification()', () => {
    it('parses weight-only frame (6 bytes)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      // [0-3] timestamp
      buf.writeUInt16BE(1600, 4); // 1600 * 50 / 1000 = 80 kg
      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(0);
    });

    it('parses full composition frame (16 bytes)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(16);
      buf.writeUInt16BE(1600, 4); // weight = 80 kg
      buf.writeUInt16BE(500, 6); // impedance = 500
      buf.writeUInt16BE(225, 8); // fat = 22.5%
      buf.writeUInt16BE(550, 10); // water = 55.0%
      buf.writeUInt16BE(400, 12); // muscle = 40.0%
      buf.writeUInt16BE(60, 14); // bone = 60 * 50 / 1000 = 3.0 kg

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBe(80);
      expect(reading!.impedance).toBe(500);
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(5))).toBeNull();
    });

    it('returns null when weight is zero', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf.writeUInt16BE(0, 4); // weight = 0
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null when weight exceeds 300 kg', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf.writeUInt16BE(6100, 4); // 6100 * 50 / 1000 = 305 kg
      expect(adapter.parseNotification(buf)).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('SBF70 / BF710 variant (issue #112)', () => {
    function sbf70Adapter() {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('SANITAS SBF70'));
      return adapter;
    }

    it('parses 5-byte 0x58 frame with weight at bytes [3-4] BE', () => {
      const adapter = sbf70Adapter();
      // Real captured frame from issue #112: [E7 58 01 08 5E]
      const frame = Buffer.from([0xe7, 0x58, 0x01, 0x08, 0x5e]);
      const reading = adapter.parseNotification(frame);
      expect(reading).not.toBeNull();
      // 0x085E = 2142 * 50/1000 = 107.1 kg
      expect(reading!.weight).toBeCloseTo(107.1, 2);
      expect(reading!.impedance).toBe(0);
    });

    it('ignores frames that do not start with 0xE7', () => {
      const adapter = sbf70Adapter();
      const frame = Buffer.from([0xf7, 0x58, 0x01, 0x08, 0x5e]);
      expect(adapter.parseNotification(frame)).toBeNull();
    });

    it('ignores 0x59 finalize frame for unregistered user (all composition zero)', () => {
      const adapter = sbf70Adapter();
      // Real captured frame from issue #112
      const frame = Buffer.from([
        0xe7, 0x59, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x65,
      ]);
      expect(adapter.parseNotification(frame)).toBeNull();
    });

    it('requires 3 consecutive readings within 0.3 kg for completion', () => {
      const adapter = sbf70Adapter();
      // First bogus frame from issue #112 capture
      const f0 = Buffer.from([0xe7, 0x58, 0x01, 0x01, 0x2b]); // 14.95 kg
      const f1 = Buffer.from([0xe7, 0x58, 0x01, 0x08, 0x5e]); // 107.1 kg
      const f2 = Buffer.from([0xe7, 0x58, 0x01, 0x08, 0x5f]); // 107.15 kg
      const f3 = Buffer.from([0xe7, 0x58, 0x01, 0x08, 0x5e]); // 107.1 kg

      const r0 = adapter.parseNotification(f0);
      expect(r0).not.toBeNull();
      expect(adapter.isComplete(r0!)).toBe(false); // only 1 reading buffered

      const r1 = adapter.parseNotification(f1);
      expect(adapter.isComplete(r1!)).toBe(false); // still drifting (14.95 vs 107.1)

      const r2 = adapter.parseNotification(f2);
      expect(adapter.isComplete(r2!)).toBe(false); // drift not yet cleared from buffer

      const r3 = adapter.parseNotification(f3);
      // Buffer now holds [107.1, 107.15, 107.1]: range 0.05 kg <= 0.3 kg
      expect(adapter.isComplete(r3!)).toBe(true);
      expect(r3!.weight).toBeCloseTo(107.1, 2);
    });

    it('rejects out-of-range weight in SBF70 frame', () => {
      const adapter = sbf70Adapter();
      // 0xFFFF * 50 / 1000 = 3276.75 kg -> too high
      const frame = Buffer.from([0xe7, 0x58, 0x01, 0xff, 0xff]);
      expect(adapter.parseNotification(frame)).toBeNull();
    });

    it('rejects zero weight in SBF70 frame', () => {
      const adapter = sbf70Adapter();
      const frame = Buffer.from([0xe7, 0x58, 0x00, 0x00, 0x00]);
      expect(adapter.parseNotification(frame)).toBeNull();
    });
  });

  describe('SBF70 / BF710 0x59 composition stream (issue #211)', () => {
    function sbf70Adapter() {
      const adapter = makeAdapter();
      adapter.matches(mockPeripheral('SANITAS SBF70'));
      return adapter;
    }

    // Real frames captured from the official-app HCI snoop in issue #211.
    const PART1 = Buffer.from([
      0xe7, 0x59, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x65,
    ]);
    const PART2 = Buffer.from([
      0xe7, 0x59, 0x03, 0x02, 0x6a, 0x21, 0xf4, 0xc6, 0x06, 0x87, 0x01, 0xb5, 0x00, 0xdf, 0x02,
    ]);
    const PART3 = Buffer.from([
      0xe7, 0x59, 0x03, 0x03, 0x09, 0x01, 0x8d, 0x00, 0xe9, 0x07, 0x17, 0x0a, 0xa2, 0x01, 0x08,
    ]);

    it('builds the per-frame ACK echoing bytes [1..3]', () => {
      const adapter = sbf70Adapter();
      expect(adapter.buildAck!(Buffer.from([0xe7, 0x58, 0x01, 0x06, 0x86]))).toEqual([
        0xe7, 0xf1, 0x58, 0x01, 0x06,
      ]);
      expect(adapter.buildAck!(PART3)).toEqual([0xe7, 0xf1, 0x59, 0x03, 0x03]);
    });

    it('does not ACK non-0xE7 frames', () => {
      const adapter = sbf70Adapter();
      expect(adapter.buildAck!(Buffer.from([0xf7, 0x58, 0x01, 0x08, 0x5e]))).toBeNull();
      expect(adapter.buildAck!(Buffer.from([0xe7]))).toBeNull();
    });

    it('returns null for part 1 and intermediate parts, reading on the last part', () => {
      const adapter = sbf70Adapter();
      expect(adapter.parseNotification(PART1)).toBeNull();
      expect(adapter.parseNotification(PART2)).toBeNull();
      const reading = adapter.parseNotification(PART3);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(83.55, 2);
      expect(reading!.impedance).toBe(437);
    });

    it('exposes the decoded composition through computeMetrics', () => {
      const adapter = sbf70Adapter();
      adapter.parseNotification(PART1);
      adapter.parseNotification(PART2);
      const reading = adapter.parseNotification(PART3)!;
      const payload = adapter.computeMetrics(reading, defaultProfile());
      expect(payload.bodyFatPercent).toBeCloseTo(22.3, 1);
      expect(payload.waterPercent).toBeCloseTo(52.1, 1);
      assertPayloadRanges(payload);
    });

    it('isFinal is true for a composition reading, false for weight-only', () => {
      const adapter = sbf70Adapter();
      expect(adapter.isFinal!({ weight: 83.55, impedance: 437 })).toBe(true);
      expect(adapter.isFinal!({ weight: 83.45, impedance: 0 })).toBe(false);
    });

    it('completionHoldMs is set for BF710 type and unset for BF700/800', () => {
      const sbf70 = sbf70Adapter();
      expect(sbf70.completionHoldMs).toBeGreaterThan(0);
      const bf700 = makeAdapter();
      bf700.matches(mockPeripheral('bf-700'));
      expect(bf700.completionHoldMs).toBeUndefined();
    });

    it('treats an all-zero composition (unregistered) as weight-only', () => {
      const adapter = sbf70Adapter();
      const z2 = Buffer.from([
        0xe7, 0x59, 0x03, 0x02, 0x6a, 0x21, 0xf4, 0xc6, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      const z3 = Buffer.from([
        0xe7, 0x59, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      expect(adapter.parseNotification(PART1)).toBeNull();
      expect(adapter.parseNotification(z2)).toBeNull();
      expect(adapter.parseNotification(z3)).toBeNull();
    });
  });

  describe('computeMetrics()', () => {
    it('returns payload with cached body comp from full frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(16);
      buf.writeUInt16BE(1600, 4); // 80 kg
      buf.writeUInt16BE(500, 6); // impedance
      buf.writeUInt16BE(225, 8); // fat 22.5%
      buf.writeUInt16BE(550, 10); // water 55%
      buf.writeUInt16BE(400, 12); // muscle 40%
      buf.writeUInt16BE(60, 14); // bone 3.0 kg

      adapter.parseNotification(buf);
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);
      expect(payload.weight).toBe(80);
      assertPayloadRanges(payload);
    });

    it('returns payload without cached comp (weight-only frame)', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf.writeUInt16BE(1600, 4); // 80 kg
      adapter.parseNotification(buf);

      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 0 }, profile);
      expect(payload.weight).toBe(80);
      assertPayloadRanges(payload);
    });

    it('returns zero weight in payload for zero weight input', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 0, impedance: 0 }, profile);
      expect(payload.weight).toBe(0);
    });
  });
});

// #386: this adapter parses an impedance out of the scale's frames and used to
// hand buildPayload an empty comp, so the exported body fat was the Deurenberg
// BMI estimate and the impedance was published but ignored.
//
// At 80 kg / 183 cm / 30 / male the two answers are far apart, which is the
// point: 19.37 % from BMI alone, 25.06 % from a 500 ohm BIA reading.
describe('Beurer / Sanitas BIA from the parsed impedance (#386)', () => {
  const BMI_ONLY_FAT = 19.37;
  const BIA_FAT_AT_500 = 25.06;

  it('computes body fat from a plausible impedance instead of from BMI', () => {
    const payload = makeAdapter().computeMetrics({ weight: 80, impedance: 500 }, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(BIA_FAT_AT_500, 1);
    expect(payload.impedance).toBe(500);
  });

  it('moves every derived field with it, not just the fat percentage', () => {
    const payload = makeAdapter().computeMetrics({ weight: 80, impedance: 500 }, defaultProfile());
    expect(payload.physiqueRating).toBe(2);
    expect(payload.visceralFat).toBe(12);
    expect(payload.waterPercent).toBeCloseTo(54.7, 2);
  });

  it('falls back to the BMI estimate when the impedance is not a body', () => {
    for (const impedance of [1, 149, 1201, 65535]) {
      const payload = makeAdapter().computeMetrics({ weight: 80, impedance }, defaultProfile());
      expect(payload.bodyFatPercent).toBeCloseTo(BMI_ONLY_FAT, 1);
    }
  });

  it('still falls back when no impedance was measured at all', () => {
    const payload = makeAdapter().computeMetrics({ weight: 80, impedance: 0 }, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(BMI_ONLY_FAT, 1);
  });
});

describe('Beurer / Sanitas: a zeroed composition is not a measurement (#386)', () => {
  it('does not export 0 % body fat when the frame carries a real impedance', () => {
    // buildPayload gates on `comp.fat ?? estimateBodyFat(...)`, which 0 passes.
    // A frame with a resistance next to a zeroed fat used to export 0 % fat,
    // 73 % water and a muscle mass equal to the whole body. The sibling SIG
    // adapter has guarded this since #211; this one did not.
    const adapter = makeAdapter();
    const buf = Buffer.alloc(16);
    buf.writeUInt16BE(1600, 4); // weight = 80 kg
    buf.writeUInt16BE(500, 6); // impedance = 500 ohm, a real measurement
    // fat, water, muscle and bone all left at 0.
    const reading = adapter.parseNotification(buf);
    expect(reading).not.toBeNull();

    const payload = adapter.computeMetrics(reading!, defaultProfile());
    // 500 ohm is in band, so the BIA figure is used rather than a zero.
    expect(payload.bodyFatPercent).toBeCloseTo(25.06, 1);
    expect(payload.muscleMass).toBeLessThan(80);
    assertPayloadRanges(payload);
  });

  it('still prefers the composition the scale sent, when it sent one', () => {
    const adapter = makeAdapter();
    const buf = Buffer.alloc(16);
    buf.writeUInt16BE(1600, 4);
    buf.writeUInt16BE(500, 6);
    buf.writeUInt16BE(225, 8); // fat = 22.5 %
    const reading = adapter.parseNotification(buf);
    const payload = adapter.computeMetrics(reading!, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(22.5, 2);
  });
});

// #394: the adapter is a shared singleton, so gating state from one weigh-in
// used to survive into the next. This is the most intricate reset in the set:
// `readingBuffer` drives the BF710 three-sample stability gate and `compParts`
// drives the multipart 0x59 reassembly, and two further fields are deliberately
// NOT cleared (see the onSessionStart doc comment).
describe('BeurerSanitasScaleAdapter session boundary (#394)', () => {
  /** BF710 live weight frame: E7 58 xx [weight u16 BE, *50/1000]. */
  function bf710Weight(raw: number): Buffer {
    const buf = Buffer.from('e7580000 00'.replace(/ /g, ''), 'hex');
    buf.writeUInt16BE(raw, 3);
    return buf;
  }

  it('re-arms the three-sample stability gate for each session', () => {
    const adapter = makeAdapter();
    // Three identical samples satisfy the gate.
    adapter.parseNotification(bf710Weight(1811));
    adapter.parseNotification(bf710Weight(1811));
    const settled = adapter.parseNotification(bf710Weight(1811))!;
    expect(adapter.isComplete(settled)).toBe(true);

    adapter.onSessionStart();

    // First frame of the next session, within the 0.3 kg tolerance of the
    // previous person (the realistic case - two adults in the same household
    // rarely differ by more than the gate notices on frame one). With the
    // buffer carried over, [90.55, 90.55, 90.60] satisfied the gate on that
    // single frame and the session completed on an unsettled weight.
    const first = adapter.parseNotification(bf710Weight(1812))!;
    expect(adapter.isComplete(first)).toBe(false);
  });

  it('does not splice a composition out of two different weigh-ins', () => {
    const adapter = makeAdapter();
    adapter.parseNotification(bf710Weight(1811));
    // Part 2 of a 3-part 0x59 stream; the session dies before part 3 arrives.
    // Payload bytes 0..9 of the merged 16-byte composition structure.
    adapter.parseNotification(Buffer.from('e7590302' + '00000000064001f400e1', 'hex'));

    adapter.onSessionStart();

    // Next session sends part 3 only: payload bytes 10..15. With the orphan
    // part 2 still held, the two concatenated reached the 16 bytes the decoder
    // needs and it returned a reading spliced out of two different weigh-ins.
    const spliced = adapter.parseNotification(Buffer.from('e7590303' + '022601900014', 'hex'));
    expect(spliced).toBeNull();
  });

  it('keeps the completed reading composition when the NEXT session starts first', () => {
    // computeMetrics runs after the parse that built the reading, and the very
    // next parse nulls cachedComp. On the watcher transports that next parse
    // can already belong to the next session, so the composition has to travel
    // on the reading rather than in the live cache.
    const adapter = makeAdapter();
    const buf = Buffer.alloc(16);
    buf.writeUInt16BE(1600, 4); // 80 kg
    buf.writeUInt16BE(500, 6); // 500 ohm
    buf.writeUInt16BE(225, 8); // fat 22.5 %
    const reading = adapter.parseNotification(buf)!;

    adapter.onSessionStart();
    // The next session's first frame nulls cachedComp on its way through.
    const next = Buffer.alloc(16);
    next.writeUInt16BE(1300, 4);
    adapter.parseNotification(next);

    const payload = adapter.computeMetrics(reading, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(22.5, 2);
  });
});
