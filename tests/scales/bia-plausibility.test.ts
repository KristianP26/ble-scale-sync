import { describe, it, expect } from 'vitest';
import { KoogeekS1Adapter } from '../../src/scales/koogeek-s1.js';
import { EtekcityEsf551Adapter } from '../../src/scales/etekcity-esf551.js';
import { RenphoScaleAdapter } from '../../src/scales/renpho.js';
import { QnScaleAdapter } from '../../src/scales/qn-scale/index.js';
import { StandardGattScaleAdapter } from '../../src/scales/standard-gatt.js';
import { estimateBodyFat } from '../../src/scales/body-comp-helpers.js';
import type { ScaleAdapter, UserProfile } from '../../src/interfaces/scale-adapter.js';

const PROFILE: UserProfile = { height: 180, age: 35, gender: 'male', isAthlete: false };
const WEIGHT = 80;
const BMI = WEIGHT / 1.8 ** 2;

/**
 * #405. computeBiaFat bounds its OUTPUT but not its input: an impedance far too
 * high pins the 60 % ceiling, one far too low drives lean mass above body
 * weight and pins the 4 % floor. Both are published as confident numbers.
 * biaFatIfPlausible rejects outside 150-1200 ohm, and a rejected value lands on
 * the same Deurenberg estimate the adapter published before it read any
 * impedance at all.
 */
const ADAPTERS: Array<[string, ScaleAdapter]> = [
  ['Koogeek S1', new KoogeekS1Adapter()],
  ['Etekcity ESF-551', new EtekcityEsf551Adapter()],
  ['Renpho', new RenphoScaleAdapter()],
  ['QN Scale', new QnScaleAdapter()],
];

describe.each(ADAPTERS)('%s BIA plausibility guard', (_name, adapter) => {
  it('computes from a plausible impedance', () => {
    const payload = adapter.computeMetrics({ weight: WEIGHT, impedance: 500 }, PROFILE);
    expect(payload.bodyFatPercent).toBeGreaterThan(4);
    expect(payload.bodyFatPercent).toBeLessThan(60);
    // Not the BMI estimate: the impedance actually moved the number.
    expect(payload.bodyFatPercent).not.toBeCloseTo(estimateBodyFat(BMI, PROFILE), 3);
  });

  it('falls back to the BMI estimate for an impedance far above the band', () => {
    const payload = adapter.computeMetrics({ weight: WEIGHT, impedance: 3000 }, PROFILE);
    expect(payload.bodyFatPercent).toBeCloseTo(estimateBodyFat(BMI, PROFILE), 3);
  });

  it('falls back to the BMI estimate for an impedance far below the band', () => {
    const payload = adapter.computeMetrics({ weight: WEIGHT, impedance: 12 }, PROFILE);
    expect(payload.bodyFatPercent).toBeCloseTo(estimateBodyFat(BMI, PROFILE), 3);
  });

  it('still exports the raw impedance, whatever the guard decided', () => {
    // ADR D011: the guard is about what we COMPUTE, not about hiding what the
    // scale reported.
    expect(adapter.computeMetrics({ weight: WEIGHT, impedance: 3000 }, PROFILE).impedance).toBe(
      3000,
    );
  });
});

describe('StandardGattScaleAdapter keeps its own reported composition', () => {
  /** flags: muscle % + impedance + weight. */
  function frame(fatRaw: number, muscleRaw: number, impedanceRaw: number): Buffer {
    const buf = Buffer.alloc(10);
    buf.writeUInt16LE(0x0010 | 0x0200 | 0x0400, 0);
    buf.writeUInt16LE(fatRaw, 2);
    buf.writeUInt16LE(muscleRaw, 4);
    buf.writeUInt16LE(impedanceRaw, 6);
    buf.writeUInt16LE(WEIGHT / 0.005, 8);
    return buf;
  }

  it('uses the scale-reported fat when the impedance is implausible, not Deurenberg', () => {
    const adapter = new StandardGattScaleAdapter();
    adapter.onSessionStart?.();
    // 30000 * 0.1 = 3000 ohm, outside the band; the scale itself says 22.5 %.
    const reading = adapter.parseNotification(frame(225, 400, 30000))!;
    const payload = adapter.computeMetrics(reading, PROFILE);

    expect(payload.bodyFatPercent).toBeCloseTo(22.5, 3);
    expect(payload.bodyFatPercent).not.toBeCloseTo(estimateBodyFat(BMI, PROFILE), 3);
  });

  it('prefers BIA when the impedance is plausible', () => {
    const adapter = new StandardGattScaleAdapter();
    adapter.onSessionStart?.();
    const reading = adapter.parseNotification(frame(225, 400, 5000))!;
    const payload = adapter.computeMetrics(reading, PROFILE);

    expect(payload.bodyFatPercent).not.toBeCloseTo(22.5, 3);
  });
});
