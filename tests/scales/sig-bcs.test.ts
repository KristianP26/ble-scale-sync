import { describe, it, expect } from 'vitest';
import { parseSigBodyComposition, toScaleReading } from '../../src/scales/sig-bcs.js';
import { StandardGattScaleAdapter } from '../../src/scales/standard-gatt.js';
import type { UserProfile } from '../../src/interfaces/scale-adapter.js';

const PROFILE: UserProfile = {
  height: 180,
  age: 35,
  gender: 'male',
  isAthlete: false,
};

/** Build a 0x2A9C frame from flags + the 16-bit fields, in flag-bit order. */
function frame(flags: number, fields: number[]): Buffer {
  const buf = Buffer.alloc(2 + fields.length * 2);
  buf.writeUInt16LE(flags, 0);
  fields.forEach((v, i) => buf.writeUInt16LE(v, 2 + i * 2));
  return buf;
}

const MUSCLE_PCT = 0x0010;
const IMPEDANCE = 0x0200;
const WEIGHT = 0x0400;

describe('parseSigBodyComposition', () => {
  it('decodes a full frame', () => {
    // fat 20.0 %, muscle 40.0 %, impedance 500 ohm, weight 80 kg
    const buf = frame(MUSCLE_PCT | IMPEDANCE | WEIGHT, [200, 400, 5000, 16000]);
    const decoded = parseSigBodyComposition(buf);

    expect(decoded).toMatchObject({
      bodyFatPercent: 20,
      musclePct: 40,
      impedanceOhm: 500,
      weightKg: 80,
    });
    expect(toScaleReading(decoded!)).toEqual({ weight: 80, impedance: 500 });
  });

  it('converts imperial mass fields', () => {
    // 17637 * 0.01 lb -> kg
    const decoded = parseSigBodyComposition(frame(0x0001 | WEIGHT, [200, 17637]));
    expect(decoded!.weightKg).toBeCloseTo(80, 1);
  });

  it('treats a zeroed body fat as no measurement, not as 0 %', () => {
    // The shape 35 of the 36 body-comp frames in the #229 BF788 capture had.
    const decoded = parseSigBodyComposition(frame(MUSCLE_PCT | WEIGHT, [0, 0, 16000]));
    expect(decoded!.bodyFatPercent).toBeUndefined();
    expect(decoded!.musclePct).toBeUndefined();
    expect(decoded!.weightKg).toBe(80);
  });

  it('rejects the 0xFFFF "measurement unsuccessful" sentinel in every field', () => {
    const decoded = parseSigBodyComposition(
      frame(MUSCLE_PCT | IMPEDANCE | WEIGHT, [0xffff, 0xffff, 0xffff, 0xffff]),
    );
    // 0xFFFF as a fat is 6553.5 %, which drives lean mass negative and exports
    // a negative bone mass, water and muscle mass.
    expect(decoded!.bodyFatPercent).toBeUndefined();
    expect(decoded!.musclePct).toBeUndefined();
    expect(decoded!.impedanceOhm).toBeUndefined();
    expect(decoded!.weightKg).toBeUndefined();
  });

  it('leaves a field undefined when the frame is too short to carry it', () => {
    const buf = frame(WEIGHT, [200]); // weight flagged, bytes absent
    const decoded = parseSigBodyComposition(buf);
    expect(decoded!.bodyFatPercent).toBe(20);
    expect(decoded!.weightKg).toBeUndefined();
    expect(toScaleReading(decoded!).weight).toBe(0);
  });

  it('returns null for a frame too short for the mandatory field', () => {
    expect(parseSigBodyComposition(Buffer.from([0x00, 0x00, 0x01]))).toBeNull();
  });
});

describe('StandardGattScaleAdapter sentinel handling (#405)', () => {
  it('does not export 0 kg of muscle from a zeroed composition frame', () => {
    const adapter = new StandardGattScaleAdapter();
    adapter.onSessionStart?.();

    const reading = adapter.parseNotification(frame(MUSCLE_PCT | WEIGHT, [0, 0, 16000]))!;
    const payload = adapter.computeMetrics(reading, PROFILE);

    // buildPayload guards on `comp.muscle != null`, so a 0 that got this far
    // exported 0 kg of muscle and a physique rating computed from it.
    expect(payload.muscleMass).toBeGreaterThan(10);
    expect(payload.bodyFatPercent).toBeGreaterThan(0);
  });

  it('does not export a negative bone mass from the 0xFFFF sentinel', () => {
    const adapter = new StandardGattScaleAdapter();
    adapter.onSessionStart?.();

    const reading = adapter.parseNotification(frame(WEIGHT, [0xffff, 16000]))!;
    const payload = adapter.computeMetrics(reading, PROFILE);

    // 6553.5 % fat -> lbm = weight * (1 - 65.535)
    expect(payload.boneMass).toBeGreaterThan(0);
    expect(payload.waterPercent).toBeGreaterThan(0);
    expect(payload.bodyFatPercent).toBeLessThan(100);
  });
});
