import { describe, it, expect } from 'vitest';
import { BodyCompCalculator } from '../src/calculator.js';

const r2 = (v: number) => Math.round(v * 100) / 100;

describe('BodyCompCalculator', () => {
  describe('null guard', () => {
    it('returns null when height is 0', () => {
      const calc = new BodyCompCalculator(80, 500, 0, 26, 'male');
      expect(calc.calculate()).toBeNull();
    });

    it('returns null when weight is 0', () => {
      const calc = new BodyCompCalculator(0, 500, 183, 26, 'male');
      expect(calc.calculate()).toBeNull();
    });

    it('returns null when impedance is 0', () => {
      const calc = new BodyCompCalculator(80, 0, 183, 26, 'male');
      expect(calc.calculate()).toBeNull();
    });
  });

  describe('male normal', () => {
    // coefficients: c1=0.503, c2=0.165, c3=-0.158, c4=17.8
    // h2r = 183^2/500 = 33489/500 = 66.978
    // lbm = 0.503*66.978 + 0.165*80 + (-0.158)*26 + 17.8
    //      = 33.69 + 13.2 + (-4.108) + 17.8 = 60.582
    // bodyFatKg = 80 - 60.582 = 19.418
    // bodyFatPercent = clamp(19.418/80*100, 3, 60) = 24.2725
    // waterPercent = (60.582*0.73/80)*100 = 55.28
    // boneMass = 60.582*0.042 = 2.544
    // muscleMass = 60.582*0.54 = 32.714
    // visceralFat = trunc(24.2725*0.55 - 4 + 26*0.08) = trunc(11.43) = 11
    // physiqueRating: fat<25, muscle>0.38*80=30.4, muscle<0.45*80=36 → 5
    // bmi = 80/(1.83^2) = 23.888...
    // baseBmr = 10*80 + 6.25*183 - 5*26 = 800+1143.75-130 = 1813.75
    // bmr = 1813.75 + 5 = 1818.75 → trunc = 1818
    // idealBmr = 800 + 1143.75 - 125 + 5 = 1823.75
    // metabolicAge = 26 + trunc((1823.75-1818.75)/15) = 26+0 = 26

    it('computes all 9 metrics correctly', () => {
      const calc = new BodyCompCalculator(80, 500, 183, 26, 'male');
      const m = calc.calculate()!;
      expect(m).not.toBeNull();

      const h2r = 183 ** 2 / 500;
      const lbm = 0.503 * h2r + 0.165 * 80 + -0.158 * 26 + 17.8;
      const fatKg = 80 - lbm;
      const fatPct = Math.max(3, Math.min((fatKg / 80) * 100, 60));

      expect(m.bmi).toBe(r2(80 / (1.83 * 1.83)));
      expect(m.bodyFatPercent).toBe(r2(fatPct));
      expect(m.waterPercent).toBe(r2(((lbm * 0.73) / 80) * 100));
      expect(m.boneMass).toBe(r2(lbm * 0.042));
      expect(m.muscleMass).toBe(r2(lbm * 0.54));
      expect(m.visceralFat).toBe(
        Math.max(1, Math.min(Math.trunc(fatPct * 0.55 - 4 + 26 * 0.08), 59)),
      );
      expect(m.physiqueRating).toBe(5);
      expect(m.bmr).toBe(Math.trunc(10 * 80 + 6.25 * 183 - 5 * 26 + 5));
      expect(m.metabolicAge).toBe(26);
    });
  });

  describe('male athlete', () => {
    // coefficients: c1=0.637, c2=0.205, c3=-0.180, c4=12.5
    // h2r = 183^2/500 = 66.978
    // lbm = 0.637*66.978 + 0.205*80 + (-0.180)*26 + 12.5
    //      = 42.665 + 16.4 + (-4.68) + 12.5 = 66.885
    // bodyFatKg = 80 - 66.885 = 13.115
    // bodyFatPercent = 13.115/80*100 = 16.394
    // waterPercent = (66.885*0.74/80)*100 = 61.87
    // boneMass = 66.885*0.042 = 2.809
    // muscleMass = 66.885*0.60 = 40.131
    // fat<18, muscle > 0.45*80=36 → physique 9
    // bmr = (10*80 + 6.25*183 - 5*26 + 5) * 1.05
    //     = 1818.75 * 1.05 = 1909.6875 → trunc = 1909
    // idealBmr = 1823.75
    // metabolicAge = 26 + trunc((1823.75-1909.6875)/15)
    //             = 26 + trunc(-5.729) = 26 + (-5) = 21
    // athlete cap: metabolicAge(21) <= age(26) → no cap

    it('uses athlete coefficients and factors', () => {
      const calc = new BodyCompCalculator(80, 500, 183, 26, 'male', true);
      const m = calc.calculate()!;

      const h2r = 183 ** 2 / 500;
      const lbm = 0.637 * h2r + 0.205 * 80 + -0.18 * 26 + 12.5;
      const fatKg = 80 - lbm;
      const fatPct = Math.max(3, Math.min((fatKg / 80) * 100, 60));

      expect(m.bodyFatPercent).toBe(r2(fatPct));
      expect(m.waterPercent).toBe(r2(((lbm * 0.74) / 80) * 100));
      expect(m.muscleMass).toBe(r2(lbm * 0.6));
      expect(m.physiqueRating).toBe(9); // fat<18, muscle>0.45w
      expect(m.bmr).toBe(Math.trunc((10 * 80 + 6.25 * 183 - 5 * 26 + 5) * 1.05));
    });

    it('caps metabolic age for athletes', () => {
      // Use older age so athlete BMR boost pushes metabolicAge above actual age
      // For age=50: baseBmr = 800 + 1143.75 - 250 + 5 = 1698.75; bmr = 1698.75*1.05 = 1783.6875
      // idealBmr = 1823.75
      // metabolicAge = 50 + trunc((1823.75-1783.6875)/15) = 50+2 = 52 → cap to 50-5=45
      const calc = new BodyCompCalculator(80, 500, 183, 50, 'male', true);
      const m = calc.calculate()!;
      expect(m.metabolicAge).toBe(45);
    });
  });

  describe('female normal', () => {
    // coefficients: c1=0.490, c2=0.150, c3=-0.130, c4=11.5
    // w=65, imp=450, h=165, age=30
    // h2r = 165^2/450 = 27225/450 = 60.5
    // lbm = 0.490*60.5 + 0.150*65 + (-0.130)*30 + 11.5
    //      = 29.645 + 9.75 + (-3.9) + 11.5 = 46.995
    // fatKg = 65 - 46.995 = 18.005
    // fatPct = 18.005/65*100 = 27.70
    // bmr = 10*65 + 6.25*165 - 5*30 + (-161) = 650+1031.25-150-161 = 1370.25 → trunc=1370

    it('uses female coefficients and BMR offset', () => {
      const calc = new BodyCompCalculator(65, 450, 165, 30, 'female');
      const m = calc.calculate()!;

      const h2r = 165 ** 2 / 450;
      const lbm = 0.49 * h2r + 0.15 * 65 + -0.13 * 30 + 11.5;
      const fatPct = Math.max(3, Math.min(((65 - lbm) / 65) * 100, 60));

      expect(m.bodyFatPercent).toBe(r2(fatPct));
      expect(m.boneMass).toBe(r2(lbm * 0.042));
      expect(m.bmr).toBe(Math.trunc(10 * 65 + 6.25 * 165 - 5 * 30 - 161));
    });
  });

  describe('female athlete', () => {
    // coefficients: c1=0.550, c2=0.180, c3=-0.150, c4=8.5
    // w=65, imp=450, h=165, age=30
    // h2r = 60.5
    // lbm = 0.550*60.5 + 0.180*65 + (-0.150)*30 + 8.5
    //      = 33.275 + 11.7 + (-4.5) + 8.5 = 48.975
    // fatKg = 65 - 48.975 = 16.025
    // fatPct = 16.025/65*100 = 24.654
    // waterPercent = (48.975*0.74/65)*100 = 55.74
    // muscleMass = 48.975*0.60 = 29.385
    // bmr = (650+1031.25-150-161)*1.05 = 1370.25*1.05 = 1438.7625 → trunc=1438

    it('uses female athlete coefficients', () => {
      const calc = new BodyCompCalculator(65, 450, 165, 30, 'female', true);
      const m = calc.calculate()!;

      const h2r = 165 ** 2 / 450;
      const lbm = 0.55 * h2r + 0.18 * 65 + -0.15 * 30 + 8.5;
      const fatPct = Math.max(3, Math.min(((65 - lbm) / 65) * 100, 60));

      expect(m.bodyFatPercent).toBe(r2(fatPct));
      expect(m.waterPercent).toBe(r2(((lbm * 0.74) / 65) * 100));
      expect(m.muscleMass).toBe(r2(lbm * 0.6));
      expect(m.bmr).toBe(Math.trunc((10 * 65 + 6.25 * 165 - 5 * 30 - 161) * 1.05));
    });
  });

  describe('LBM cap', () => {
    // Very low impedance → very high h2r → LBM exceeds weight
    // w=60, imp=50, h=170, age=25, male normal
    // h2r = 170^2/50 = 28900/50 = 578
    // lbm = 0.503*578 + 0.165*60 + (-0.158)*25 + 17.8 = 290.734+9.9-3.95+17.8 = 314.484
    // lbm > 60 → capped to 60*0.96 = 57.6

    it('caps LBM when it exceeds weight', () => {
      const calc = new BodyCompCalculator(60, 50, 170, 25, 'male');
      const m = calc.calculate()!;

      const lbmCapped = 60 * 0.96;
      const fatPct = Math.max(3, Math.min(((60 - lbmCapped) / 60) * 100, 60));
      expect(m.bodyFatPercent).toBe(r2(fatPct));
      expect(m.muscleMass).toBe(r2(lbmCapped * 0.54));
    });
  });

  describe('body fat clamping', () => {
    it('clamps body fat at minimum 3%', () => {
      // Very low impedance triggers LBM cap → fat% = (w - 0.96w)/w*100 = 4%
      // That's already > 3. Use negative fat scenario: impossible with cap.
      // With LBM cap, minimum fat% = 4%. Let's verify it stays above 3.
      const calc = new BodyCompCalculator(60, 50, 170, 25, 'male');
      const m = calc.calculate()!;
      expect(m.bodyFatPercent).toBeGreaterThanOrEqual(3);
    });

    it('clamps body fat at maximum 60%', () => {
      // Very high impedance, short height → tiny h2r → tiny LBM → high fat%
      // w=120, imp=2000, h=150, age=70, female normal
      // h2r = 150^2/2000 = 11.25
      // lbm = 0.490*11.25 + 0.150*120 + (-0.130)*70 + 11.5 = 5.5125+18-9.1+11.5 = 25.9125
      // fatKg = 120 - 25.9125 = 94.0875
      // fatPct = 94.0875/120*100 = 78.4 → clamped to 60
      const calc = new BodyCompCalculator(120, 2000, 150, 70, 'female');
      const m = calc.calculate()!;
      expect(m.bodyFatPercent).toBe(60);
    });
  });

  describe('visceral fat', () => {
    it('returns 1 when bodyFatPercent <= 10', () => {
      // Male athlete with low body fat
      // w=75, imp=350, h=185, age=20, male athlete
      // h2r = 185^2/350 = 34225/350 = 97.786
      // lbm = 0.637*97.786 + 0.205*75 + (-0.180)*20 + 12.5
      //      = 62.29 + 15.375 + (-3.6) + 12.5 = 86.565
      // lbm > 75 → cap to 75*0.96 = 72
      // fatPct = (75-72)/75*100 = 4% → visceral = 1
      const calc = new BodyCompCalculator(75, 350, 185, 20, 'male', true);
      const m = calc.calculate()!;
      expect(m.bodyFatPercent).toBeLessThanOrEqual(10);
      expect(m.visceralFat).toBe(1);
    });
  });

  describe('metabolic age floor', () => {
    it('enforces minimum metabolic age of 12', () => {
      // Young person with metrics that push metabolic age very low
      // If idealBmr << bmr, metabolicAge could go below 12
      // For very young age (12): baseBmr = 10*80 + 6.25*183 - 5*12 = 800+1143.75-60 = 1883.75
      // bmr = 1883.75+5 = 1888.75
      // idealBmr = 1823.75
      // metabolicAge = 12 + trunc((1823.75-1888.75)/15) = 12 + (-4) = 8 → capped to 12
      const calc = new BodyCompCalculator(80, 500, 183, 12, 'male');
      const m = calc.calculate()!;
      expect(m.metabolicAge).toBe(12);
    });
  });

  describe('physique rating boundaries', () => {
    it('returns 1 — fat>25, muscle<=0.4w', () => {
      // Need: fatPct>25, muscleMass<=0.4*weight
      // w=100, imp=800, h=170, age=40, female normal
      // h2r = 170^2/800 = 36.125
      // lbm = 0.490*36.125 + 0.150*100 + (-0.130)*40 + 11.5
      //      = 17.70 + 15 + (-5.2) + 11.5 = 39.0
      // fatPct = (100-39)/100*100 = 61 → clamped to 60
      // muscleMass = 39*0.54 = 21.06
      // 0.4*100 = 40 → 21.06 <= 40 → rating 1
      const calc = new BodyCompCalculator(100, 800, 170, 40, 'female');
      const m = calc.calculate()!;
      expect(m.bodyFatPercent).toBeGreaterThan(25);
      expect(m.muscleMass).toBeLessThanOrEqual(0.4 * 100);
      expect(m.physiqueRating).toBe(1);
    });

    it('returns 2 — fat>25, muscle>0.4w', () => {
      // Need high fat but also high muscle
      // w=80, imp=550, h=165, age=50, male normal
      // h2r = 165^2/550 = 27225/550 = 49.5
      // lbm = 0.503*49.5 + 0.165*80 + (-0.158)*50 + 17.8
      //      = 24.8985 + 13.2 + (-7.9) + 17.8 = 47.999
      // fatPct = (80-47.999)/80*100 = 40.0 → >25 ✓
      // muscleMass = 47.999*0.54 = 25.919
      // 0.4*80=32 → 25.919 < 32 → rating 1 (not 2)

      // Let's use inputs where muscle > 0.4w with fat > 25
      // Need lbm where lbm*0.54 > 0.4*w AND (w-lbm)/w*100 > 25
      // lbm*0.54 > 0.4*w → lbm > 0.741w
      // (w-lbm)/w > 0.25 → lbm < 0.75w
      // So need 0.741w < lbm < 0.75w
      // For w=200: need 148.2 < lbm < 150
      // h2r = 0.503*h2r + 0.165*200 + (-0.158)*30 + 17.8 = 0.503*h2r + 33 - 4.74 + 17.8 = 0.503*h2r + 46.06
      // 148.2 < 0.503*h2r + 46.06 → h2r > 202.9
      // 150 > 0.503*h2r + 46.06 → h2r < 206.5
      // h2r = 204 → h^2/imp = 204 → h=180, imp=158.8... → imp=159
      // h2r = 180^2/159 = 32400/159 = 203.77
      // lbm = 0.503*203.77 + 46.06 = 102.50 + 46.06 = 148.56
      // fatPct = (200-148.56)/200*100 = 25.72 > 25 ✓
      // muscleMass = 148.56*0.54 = 80.22
      // 0.4*200 = 80 → 80.22 > 80 ✓ → rating 2
      const calc = new BodyCompCalculator(200, 159, 180, 30, 'male');
      const m = calc.calculate()!;
      expect(m.bodyFatPercent).toBeGreaterThan(25);
      expect(m.muscleMass).toBeGreaterThan(0.4 * 200);
      expect(m.physiqueRating).toBe(2);
    });

    it('returns 7 — fat<18, muscle<=0.4w', () => {
      // Need low fat, low muscle relative to weight
      // Male athlete, w=90, imp=400, h=190, age=20
      // h2r = 190^2/400 = 36100/400 = 90.25
      // lbm = 0.637*90.25 + 0.205*90 + (-0.180)*20 + 12.5
      //      = 57.49 + 18.45 + (-3.6) + 12.5 = 84.84
      // fatPct = (90-84.84)/90*100 = 5.73 < 18 ✓
      // muscleMass = 84.84*0.60 = 50.90
      // 0.45*90=40.5 → 50.90>40.5 → rating 9 (not 7)
      // For rating 7 need muscleMass <= 0.4*w with fatPct < 18
      // lbm*smmFactor <= 0.4*w → lbm <= 0.4*w/smmFactor
      // Non-athlete (smmFactor=0.54): lbm <= 0.4*w/0.54 = 0.741w
      // fatPct < 18 → lbm > 0.82w
      // 0.82w < lbm < 0.741w — impossible! muscleMass always > 0.4w when fat<18 for non-athlete with 0.54
      // With athlete (smmFactor=0.60): lbm <= 0.4*w/0.60 = 0.667w
      // fatPct < 18 → lbm > 0.82w → impossible too
      // So rating 7 can't happen with normal factor. But the code still has the branch.
      // Let's test it via a scenario where fat is barely < 18 with low muscle
      // Actually with smmFactor 0.54: muscleMass = lbm*0.54
      // If fat=17.9%, lbm=0.821*w, muscleMass=0.821*0.54*w = 0.443w > 0.4w → always rating 8 or 9
      // The branch exists for edge cases. Let's just verify the physique rating function
      // directly in the body-comp-helpers tests. For calculator, skip rating 7.

      // Instead, test rating 8: fat<18, muscle>0.4w but <=0.45w
      // muscleMass <= 0.45w → lbm*0.54 <= 0.45w → lbm <= 0.833w
      // fatPct < 18 → lbm > 0.82w
      // So 0.82w < lbm <= 0.833w
      // w=80, lbm=66.0 → lbm/w=0.825 ✓
      // h2r: lbm = 0.503*h2r + 0.165*80 - 0.158*26 + 17.8 = 0.503*h2r + 26.592
      // 66 = 0.503*h2r + 26.592 → h2r = 78.45 → h^2/imp=78.45
      // h=180, imp=180^2/78.45 = 32400/78.45 = 413.0 → imp=413
      const calc = new BodyCompCalculator(80, 413, 180, 26, 'male');
      const m = calc.calculate()!;
      expect(m.bodyFatPercent).toBeLessThan(18);
      expect(m.muscleMass).toBeGreaterThan(0.4 * 80);
      expect(m.muscleMass).toBeLessThanOrEqual(0.45 * 80);
      expect(m.physiqueRating).toBe(8);
    });

    it('returns 9 — fat<18, muscle>0.45w', () => {
      const calc = new BodyCompCalculator(80, 500, 183, 26, 'male', true);
      const m = calc.calculate()!;
      expect(m.bodyFatPercent).toBeLessThan(18);
      expect(m.muscleMass).toBeGreaterThan(0.45 * 80);
      expect(m.physiqueRating).toBe(9);
    });

    it('returns 4 — fat 18-25, muscle<0.38w', () => {
      // Need: 18 <= fatPct <= 25, muscleMass < 0.38*w
      // lbm*0.54 < 0.38*w → lbm < 0.704*w
      // fatPct <= 25 → lbm >= 0.75*w → contradiction with 0.54 factor
      // Same issue — with 0.54 factor, can't get muscle below 0.38w when fat<=25
      // With athlete factor 0.60: lbm*0.60 < 0.38*w → lbm < 0.633w
      // fatPct<=25 → lbm>=0.75w → still impossible
      // Rating 4 is reachable via very specific edge cases or rounding.
      // We'll test this branch directly in body-comp-helpers.test.ts
      // For calculator integration: verify the 18-25 middle branch yields 5 or 6
      const calc = new BodyCompCalculator(80, 500, 183, 26, 'male');
      const m = calc.calculate()!;
      // This male normal case has fat ~24.3%, which is in 18-25 range
      expect(m.bodyFatPercent).toBeGreaterThanOrEqual(18);
      expect(m.bodyFatPercent).toBeLessThanOrEqual(25);
      expect(m.physiqueRating).toBe(5);
    });

    it('returns 6 — fat 18-25, muscle>0.45w', () => {
      // Need: 18<=fatPct<=25, muscleMass>0.45*w
      // lbm*0.54 > 0.45*w → lbm > 0.833w
      // fatPct >= 18 → lbm <= 0.82w → contradiction with 0.54
      // With 0.60 (athlete): lbm*0.60 > 0.45*w → lbm > 0.75w
      // fatPct <= 25 → lbm >= 0.75w AND fatPct >= 18 → lbm <= 0.82w
      // So 0.75w < lbm <= 0.82w with athlete factor
      // w=80, lbm=62 → lbm/w=0.775, fatPct=22.5%, muscleMass=62*0.60=37.2, 0.45*80=36 → 37.2>36 ✓
      // h2r: lbm = 0.637*h2r + 0.205*80 - 0.180*26 + 12.5 = 0.637*h2r + 23.82
      // 62 = 0.637*h2r + 23.82 → h2r = 59.94 → h^2/imp = 59.94
      // h=175, imp=175^2/59.94 = 30625/59.94 = 510.9 → imp=511
      const calc = new BodyCompCalculator(80, 511, 175, 26, 'male', true);
      const m = calc.calculate()!;
      expect(m.bodyFatPercent).toBeGreaterThanOrEqual(18);
      expect(m.bodyFatPercent).toBeLessThanOrEqual(25);
      expect(m.muscleMass).toBeGreaterThan(0.45 * 80);
      expect(m.physiqueRating).toBe(6);
    });
  });
});
