import { describe, expect, it } from 'vitest';

import { parseSigDateTime, parseSigWeightMeasurement } from '../../src/scales/sig-wss.js';
import { BeurerBf720Adapter } from '../../src/scales/beurer-bf720.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';

/**
 * Weight Measurement 0x2A9D from the #229 BF788 capture: 79.96 kg, measured
 * 2026-05-12 18:53:54. Flags 0x0e = kg, timestamp present, user id present,
 * BMI/height present.
 */
const WSS_FRAME = Buffer.from('0e783eea07050c12353601ee002607', 'hex');

describe('parseSigWeightMeasurement (0x2A9D)', () => {
  it('decodes weight at the SIG 0.005 kg resolution', () => {
    expect(parseSigWeightMeasurement(WSS_FRAME).weightKg).toBeCloseTo(79.96, 2);
  });

  it('decodes the embedded timestamp', () => {
    const ts = parseSigWeightMeasurement(WSS_FRAME).timestamp;
    expect(ts).toBeInstanceOf(Date);
    expect(ts!.getFullYear()).toBe(2026);
    expect(ts!.getMonth()).toBe(4); // May, zero-based
    expect(ts!.getDate()).toBe(12);
    expect(ts!.getHours()).toBe(18);
    expect(ts!.getMinutes()).toBe(53);
    expect(ts!.getSeconds()).toBe(54);
  });

  it('converts a pounds frame to kilograms', () => {
    // Flags bit 0 set = imperial, 0.01 lb per unit. 26000 units = 260.00 lb.
    const lb = Buffer.alloc(3);
    lb[0] = 0x01;
    lb.writeUInt16LE(26000, 1);
    expect(parseSigWeightMeasurement(lb).weightKg).toBeCloseTo(117.93, 1);
  });

  it('leaves the timestamp undefined when the flag is clear', () => {
    const noTs = Buffer.from('00783e', 'hex');
    const out = parseSigWeightMeasurement(noTs);
    expect(out.weightKg).toBeCloseTo(79.96, 2);
    expect(out.timestamp).toBeUndefined();
  });

  it('does not read a timestamp out of a long frame whose flag is clear', () => {
    // The 3-byte case above cannot catch a decoder that ignores the flag: there
    // are no bytes to misread, so the bounds check hides the bug. This frame is
    // long enough that bytes 3-9 WOULD decode as a date if the flag were not
    // honoured.
    const longNoTs = Buffer.from('0c783eea07050c123536', 'hex');
    const out = parseSigWeightMeasurement(longNoTs);
    expect(out.weightKg).toBeCloseTo(79.96, 2);
    expect(out.timestamp).toBeUndefined();
  });

  it('passes 0xFFFF through as a weight rather than suppressing it', () => {
    // Pins today's behaviour rather than endorsing it. `sig-bcs.ts` treats
    // 0xFFFF as the SIG "measurement unsuccessful" sentinel in every field;
    // this decoder does not, so 0xFFFF decodes as 327.675 kg. No capture shows
    // a scale sending it on 0x2A9D, so it is not suppressed on a guess - but a
    // second caller must make that decision knowingly, and this test is what
    // makes it visible when they do.
    const sentinel = Buffer.from('00ffff', 'hex');
    expect(parseSigWeightMeasurement(sentinel).weightKg).toBeCloseTo(327.675, 3);
  });

  it('still yields the weight when the flagged timestamp is truncated away', () => {
    // The flag claims a Date Time that the frame does not carry. Dropping the
    // whole frame would cost a usable weight, so only the timestamp is lost.
    const truncated = WSS_FRAME.subarray(0, 6);
    const out = parseSigWeightMeasurement(truncated);
    expect(out.weightKg).toBeCloseTo(79.96, 2);
    expect(out.timestamp).toBeUndefined();
  });

  it('returns nothing for a frame too short to carry the weight', () => {
    expect(parseSigWeightMeasurement(Buffer.from('0e78', 'hex'))).toEqual({});
  });
});

describe('parseSigDateTime', () => {
  it('rejects the "year unknown" zero date', () => {
    const zeroYear = Buffer.from('0000050c123536', 'hex');
    expect(parseSigDateTime(zeroYear, 0)).toBeUndefined();
  });

  it('rejects a field that runs past the end of the frame', () => {
    // Without the bounds check this is not a wrong date, it is a thrown
    // ERR_OUT_OF_RANGE from readUInt16LE, which would take down the whole
    // notification rather than losing one timestamp.
    expect(() => parseSigDateTime(WSS_FRAME, WSS_FRAME.length - 1)).not.toThrow();
    expect(parseSigDateTime(WSS_FRAME, WSS_FRAME.length - 1)).toBeUndefined();
  });
});

describe('cross-check: the adapter and the shared decoder agree', () => {
  /**
   * Runs the real BF720 adapter over the same bytes rather than comparing the
   * decoder against transcribed literals.
   *
   * What this pins is that the adapter still routes 0x2A9D through the shared
   * decoder and caches the result. It canNOT detect a wrong constant inside the
   * decoder: both sides of the assertion call the same function, so they move
   * together. The direct tests above are what guard the values.
   */
  it('BeurerBf720Adapter reports the weight the shared decoder returns', () => {
    const a = new BeurerBf720Adapter();
    a.onSessionStart?.('E7DB49F186DE');
    expect(a.parseCharNotification!(uuid16(0x2a9d), WSS_FRAME)).toBeNull();

    // Body composition frame with no weight field: the weight can only have
    // come from the 0x2A9D frame above.
    const reading = a.parseCharNotification!(uuid16(0x2a9c), Buffer.from('0000c200', 'hex'));
    expect(reading).not.toBeNull();
    expect(reading!.weight).toBeCloseTo(parseSigWeightMeasurement(WSS_FRAME).weightKg!, 5);
  });
});
