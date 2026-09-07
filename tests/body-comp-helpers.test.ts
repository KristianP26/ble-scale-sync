import { describe, it, expect } from 'vitest';
import {
  r2,
  uuid16,
  xorChecksum,
  estimateBodyFat,
  computePhysiqueRating,
  computeBiaFat,
  buildPayload,
  biaFatIfPlausible,
  IMPEDANCE_MIN_OHM,
  IMPEDANCE_MAX_OHM,
} from '../src/scales/body-comp-helpers.js';
import type { UserProfile } from '../src/interfaces/scale-adapter.js';
import { defaultProfile } from './helpers/scale-test-utils.js';

describe('r2()', () => {
  it('rounds 1.005 to 1 (IEEE 754 — 1.005*100 = 100.49999…)', () => {
    // 1.005 can't be represented exactly in float64; 1.005*100 < 100.5
    expect(r2(1.005)).toBe(1);
  });

  it('rounds 3.456789 to 3.46', () => {
    expect(r2(3.456789)).toBe(3.46);
  });

  it('keeps integers unchanged', () => {
    expect(r2(5)).toBe(5);
  });
});

describe('uuid16()', () => {
  it('expands 0x2a9c to full 128-bit UUID', () => {
    expect(uuid16(0x2a9c)).toBe('00002a9c00001000800000805f9b34fb');
  });

  it('expands 0xfff1 to full 128-bit UUID', () => {
    expect(uuid16(0xfff1)).toBe('0000fff100001000800000805f9b34fb');
  });
});

describe('xorChecksum()', () => {
  it('XORs all bytes in range', () => {
    expect(xorChecksum([0x01, 0x02, 0x03], 0, 3)).toBe(0x01 ^ 0x02 ^ 0x03);
  });

  it('XORs a single byte', () => {
    expect(xorChecksum([0xab, 0xcd], 1, 2)).toBe(0xcd);
  });

  it('returns 0 for empty range', () => {
    expect(xorChecksum([0x01, 0x02], 1, 1)).toBe(0);
  });

  it('works with Buffer', () => {
    const buf = Buffer.from([0x10, 0x20, 0x30]);
    expect(xorChecksum(buf, 0, 3)).toBe(0x10 ^ 0x20 ^ 0x30);
  });
});

describe('estimateBodyFat()', () => {
  const maleNonAthlete: UserProfile = {
    height: 183,
    age: 30,
    gender: 'male',
    isAthlete: false,
  };

  const femaleAthlete: UserProfile = {
    height: 165,
    age: 25,
    gender: 'female',
    isAthlete: true,
  };

  it('computes male non-athlete body fat', () => {
    const bmi = 80 / (1.83 * 1.83); // ~23.89
    const expected = 1.2 * bmi + 0.23 * 30 - 10.8 * 1 - 5.4;
    expect(estimateBodyFat(bmi, maleNonAthlete)).toBeCloseTo(expected, 5);
  });

  it('applies 0.85 modifier for female athlete', () => {
    const bmi = 65 / (1.65 * 1.65); // ~23.88
    const raw = 1.2 * bmi + 0.23 * 25 - 10.8 * 0 - 5.4;
    const expected = raw * 0.85;
    expect(estimateBodyFat(bmi, femaleAthlete)).toBeCloseTo(expected, 5);
  });

  it('clamps to minimum 3%', () => {
    // Very low BMI and young male → could produce negative/very low value
    const profile: UserProfile = {
      height: 180,
      age: 15,
      gender: 'male',
      isAthlete: true,
    };
    // bmi=14 extremely underweight
    // raw = (1.2 * 14 + 0.23 * 15 - 10.8 * 1 - 5.4) * 0.85 = 3.4425
    // raw = (16.8 + 3.45 - 10.8 - 5.4) * 0.85 = 4.05 * 0.85 = 3.4425
    // Actually still above 3, use bmi=10
    const result = estimateBodyFat(10, profile);
    // raw = (12 + 3.45 - 10.8 - 5.4) * 0.85 = -0.75 * 0.85 = -0.6375 → clamped to 3
    expect(result).toBe(3);
  });

  it('clamps to maximum 60%', () => {
    const profile: UserProfile = {
      height: 150,
      age: 80,
      gender: 'female',
      isAthlete: false,
    };
    // bmi=55, raw = 1.2 * 55 + 0.23 * 80 - 10.8 * 0 - 5.4 = 79 → clamped to 60
    expect(estimateBodyFat(55, profile)).toBe(60);
  });
});

describe('computePhysiqueRating()', () => {
  it('returns 1 — fat>25, muscle<=0.4w', () => {
    expect(computePhysiqueRating(30, 30, 100)).toBe(1); // 30<=0.4*100=40
  });

  it('returns 2 — fat>25, muscle>0.4w', () => {
    expect(computePhysiqueRating(30, 45, 100)).toBe(2); // 45>40
  });

  it('returns 9 — fat<18, muscle>0.45w', () => {
    expect(computePhysiqueRating(15, 50, 100)).toBe(9); // 50>45
  });

  it('returns 8 — fat<18, muscle>0.4w but <=0.45w', () => {
    expect(computePhysiqueRating(15, 42, 100)).toBe(8); // 40<42<=45
  });

  it('returns 7 — fat<18, muscle<=0.4w', () => {
    expect(computePhysiqueRating(15, 35, 100)).toBe(7); // 35<=40
  });

  it('returns 6 — fat 18-25, muscle>0.45w', () => {
    expect(computePhysiqueRating(20, 50, 100)).toBe(6); // 50>45
  });

  it('returns 4 — fat 18-25, muscle<0.38w', () => {
    expect(computePhysiqueRating(20, 35, 100)).toBe(4); // 35<38
  });

  it('returns 5 — fat 18-25, 0.38w<=muscle<=0.45w', () => {
    expect(computePhysiqueRating(20, 40, 100)).toBe(5); // 38<=40<=45
  });
});

describe('computeBiaFat()', () => {
  it('male normal — matches hand-calculated value', () => {
    const p: UserProfile = { height: 183, age: 26, gender: 'male', isAthlete: false };
    const h2r = 183 ** 2 / 500;
    const lbm = 0.503 * h2r + 0.165 * 80 + -0.158 * 26 + 17.8;
    const expected = Math.max(3, Math.min(((80 - lbm) / 80) * 100, 60));
    expect(computeBiaFat(80, 500, p)).toBeCloseTo(expected, 5);
  });

  it('male athlete — uses athlete coefficients', () => {
    const p: UserProfile = { height: 183, age: 26, gender: 'male', isAthlete: true };
    const h2r = 183 ** 2 / 500;
    const lbm = 0.637 * h2r + 0.205 * 80 + -0.18 * 26 + 12.5;
    const expected = Math.max(3, Math.min(((80 - lbm) / 80) * 100, 60));
    expect(computeBiaFat(80, 500, p)).toBeCloseTo(expected, 5);
  });

  it('female normal — uses female coefficients', () => {
    const p: UserProfile = { height: 165, age: 30, gender: 'female', isAthlete: false };
    const h2r = 165 ** 2 / 450;
    const lbm = 0.49 * h2r + 0.15 * 65 + -0.13 * 30 + 11.5;
    const expected = Math.max(3, Math.min(((65 - lbm) / 65) * 100, 60));
    expect(computeBiaFat(65, 450, p)).toBeCloseTo(expected, 5);
  });

  it('female athlete — uses female athlete coefficients', () => {
    const p: UserProfile = { height: 165, age: 30, gender: 'female', isAthlete: true };
    const h2r = 165 ** 2 / 450;
    const lbm = 0.55 * h2r + 0.18 * 65 + -0.15 * 30 + 8.5;
    const expected = Math.max(3, Math.min(((65 - lbm) / 65) * 100, 60));
    expect(computeBiaFat(65, 450, p)).toBeCloseTo(expected, 5);
  });

  it('caps LBM when it exceeds weight', () => {
    // Very low impedance → huge h2r → LBM > weight → cap to 0.96w → fat = 4%
    const p: UserProfile = { height: 170, age: 25, gender: 'male', isAthlete: false };
    const result = computeBiaFat(60, 50, p);
    const lbmCapped = 60 * 0.96;
    const expected = Math.max(3, Math.min(((60 - lbmCapped) / 60) * 100, 60));
    expect(result).toBeCloseTo(expected, 5);
  });

  it('clamps body fat to maximum 60%', () => {
    // Very high impedance → tiny LBM → high fat%
    const p: UserProfile = { height: 150, age: 70, gender: 'female', isAthlete: false };
    expect(computeBiaFat(120, 2000, p)).toBe(60);
  });

  it('clamps body fat to minimum 3%', () => {
    // LBM cap ensures min is 4%, but verify >= 3
    const p: UserProfile = { height: 185, age: 20, gender: 'male', isAthlete: true };
    expect(computeBiaFat(75, 350, p)).toBeGreaterThanOrEqual(3);
  });
});

describe('buildPayload()', () => {
  const profile: UserProfile = {
    height: 183,
    age: 30,
    gender: 'male',
    isAthlete: false,
  };

  it('uses provided comp fields directly', () => {
    const comp = {
      fat: 22,
      water: 55,
      muscle: 42,
      bone: 3.2,
      visceralFat: 8,
    };
    const p = buildPayload(80, 500, comp, profile);

    expect(p.weight).toBe(80);
    expect(p.impedance).toBe(500);
    expect(p.bodyFatPercent).toBe(22); // from comp.fat
    expect(p.waterPercent).toBe(55); // from comp.water
    expect(p.boneMass).toBe(3.2); // from comp.bone
    expect(p.visceralFat).toBe(8); // from comp.visceralFat

    // muscleMass = (comp.muscle / 100) * weight = 0.42 * 80 = 33.6
    expect(p.muscleMass).toBe(r2(0.42 * 80));

    // bmi is always computed
    const heightM = 183 / 100;
    expect(p.bmi).toBe(r2(80 / (heightM * heightM)));
  });

  it('falls back to estimation when no comp fields provided', () => {
    const p = buildPayload(80, 500, {}, profile);

    const heightM = 183 / 100;
    const bmi = 80 / (heightM * heightM);
    const estimatedFat = estimateBodyFat(bmi, profile);

    expect(p.bmi).toBe(r2(bmi));
    expect(p.bodyFatPercent).toBe(r2(estimatedFat));

    // waterPercent is estimated from lbm
    const lbm = 80 * (1 - estimatedFat / 100);
    expect(p.waterPercent).toBe(r2(((lbm * 0.73) / 80) * 100));
    expect(p.boneMass).toBe(r2(lbm * 0.042));
    // #253: muscle mass is fat-free mass minus bone, which is what the vendor
    // apps and Garmin Connect mean by the term. It used to fall back to
    // lbm * 0.54, a skeletal muscle estimate, which under-reported by roughly a
    // third of body weight.
    expect(p.muscleMass).toBe(r2(lbm - lbm * 0.042));
  });

  it('mixes provided and estimated values', () => {
    const comp = { fat: 20 };
    const p = buildPayload(80, 500, comp, profile);

    expect(p.bodyFatPercent).toBe(20); // provided

    // Other fields estimated from provided fat
    const lbm = 80 * (1 - 20 / 100); // = 64
    expect(p.waterPercent).toBe(r2(((lbm * 0.73) / 80) * 100));
    expect(p.boneMass).toBe(r2(lbm * 0.042));
    expect(p.muscleMass).toBe(r2(lbm - lbm * 0.042)); // #253: fat-free mass minus bone
  });

  // #253: two Renpho app sessions posted by the reporter. The app's own numbers
  // are internally consistent with "muscle mass = fat-free mass - bone" and not
  // with the old skeletal-muscle fallback, so reproduce that relationship using
  // the app's own fat and bone figures as inputs.
  it.each([
    { weight: 86.1, fat: 23.9, bone: 3.28, appMuscle: 62.2 },
    { weight: 84.8, fat: 23.3, bone: 3.25, appMuscle: 61.8 },
  ])(
    'matches the Renpho app muscle mass for a $weight kg session (#253)',
    ({ weight, fat, bone, appMuscle }) => {
      const p = buildPayload(weight, 500, { fat, bone }, profile);
      expect(p.muscleMass).toBeCloseTo(appMuscle, 1);
    },
  );

  // The physique rating's thresholds are calibrated against the skeletal muscle
  // estimate, not against fat-free mass minus bone. Feeding it the corrected
  // muscle mass would push essentially everyone into the top branch, so the two
  // must stay decoupled.
  it('does not let the corrected muscle mass inflate the physique rating (#253)', () => {
    // fat 17 % is chosen so the two bases disagree. lbm = 66.4, so the skeletal
    // estimate is 0.54 * 66.4 = 35.86, just under the 0.45 * 80 = 36 threshold
    // for a 9, giving an 8. The corrected muscleMass is 66.4 - bone = 63.6,
    // far above it, so if the rating read that field it would be pinned at 9.
    const p = buildPayload(80, 500, { fat: 17 }, profile);
    expect(p.muscleMass).toBeGreaterThan(80 * 0.45);
    expect(p.physiqueRating).toBe(8);
  });

  it('clamps visceral fat to [1, 59]', () => {
    const comp = { visceralFat: 100 };
    const p = buildPayload(80, 500, comp, profile);
    expect(p.visceralFat).toBe(59);

    const comp2 = { visceralFat: -5 };
    const p2 = buildPayload(80, 500, comp2, profile);
    expect(p2.visceralFat).toBe(1);
  });

  it('computes BMR and metabolic age', () => {
    const p = buildPayload(80, 500, {}, profile);

    const baseBmr = 10 * 80 + 6.25 * 183 - 5 * 30;
    const bmr = baseBmr + 5; // male offset
    expect(p.bmr).toBe(Math.trunc(bmr));

    const idealBmr = 10 * 80 + 6.25 * 183 - 5 * 25 + 5;
    const metabolicAge = 30 + Math.trunc((idealBmr - bmr) / 15);
    expect(p.metabolicAge).toBe(metabolicAge);
  });
});

// #386: computeBiaFat bounds its output but not its input, and both directions
// produce a confident wrong answer. This is the gate the adapters go through.
describe('biaFatIfPlausible', () => {
  const p = defaultProfile();

  it('agrees with computeBiaFat inside the band', () => {
    for (const z of [IMPEDANCE_MIN_OHM, 300, 500, 900, IMPEDANCE_MAX_OHM]) {
      expect(biaFatIfPlausible(80, z, p)).toBe(computeBiaFat(80, z, p));
    }
  });

  it('refuses anything outside the band', () => {
    for (const z of [IMPEDANCE_MIN_OHM - 1, IMPEDANCE_MAX_OHM + 1, 30, 50, 2000, 65535]) {
      expect(biaFatIfPlausible(80, z, p)).toBeUndefined();
    }
  });

  it('refuses a missing measurement, which is the normal case, not an error', () => {
    expect(biaFatIfPlausible(80, 0, p)).toBeUndefined();
    expect(biaFatIfPlausible(80, -1, p)).toBeUndefined();
    expect(biaFatIfPlausible(80, Number.NaN, p)).toBeUndefined();
  });

  it('feeds buildPayload the Deurenberg fallback when it refuses', () => {
    // The whole point of returning undefined rather than 0: the reading lands
    // on exactly the figure these adapters published before.
    const refused = buildPayload(80, 50, { fat: biaFatIfPlausible(80, 50, p) }, p);
    const bmiOnly = buildPayload(80, 50, {}, p);
    expect(refused.bodyFatPercent).toBe(bmiOnly.bodyFatPercent);
  });

  it('catches the failure that actually happens: too LOW, not too high', () => {
    // A tenfold-small impedance drives height^2 / Z up until lean mass exceeds
    // body weight, and computeBiaFat's own cap then pins the 4 % floor. That is
    // a plausible-looking 4 % body fat, not an obvious error.
    expect(computeBiaFat(80, 50, p)).toBeCloseTo(4, 1);
    expect(biaFatIfPlausible(80, 50, p)).toBeUndefined();
  });
});
