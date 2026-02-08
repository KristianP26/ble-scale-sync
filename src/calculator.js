/**
 * RenphoCalculator — Body composition calculator.
 *
 * Ported 1:1 from scale_sync.py. All formulas, constants, and clamp
 * ranges are identical to the Python implementation.
 */

export class RenphoCalculator {
  /**
   * @param {number} weight     - Weight in kg
   * @param {number} impedance  - BIA impedance in Ohm
   * @param {number} height     - Height in cm
   * @param {number} age        - Age in years
   * @param {string} gender     - 'male' or 'female'
   * @param {boolean} isAthlete - Athlete mode flag
   */
  constructor(weight, impedance, height, age, gender, isAthlete = false) {
    this.weight = weight;
    this.impedance = impedance;
    this.height = height;
    this.age = age;
    this.gender = gender;
    this.isAthlete = isAthlete;
  }

  calculate() {
    if (this.height === 0 || this.weight === 0 || this.impedance === 0) {
      return null;
    }

    // --- 1. LBM (Lean Body Mass) ---
    let c1, c2, c3, c4;

    if (this.gender === 'male') {
      if (this.isAthlete) {
        [c1, c2, c3, c4] = [0.637, 0.205, -0.180, 12.5];
      } else {
        [c1, c2, c3, c4] = [0.503, 0.165, -0.158, 17.8];
      }
    } else {
      if (this.isAthlete) {
        [c1, c2, c3, c4] = [0.550, 0.180, -0.150, 8.5];
      } else {
        [c1, c2, c3, c4] = [0.490, 0.150, -0.130, 11.5];
      }
    }

    const h2r = (this.height ** 2) / this.impedance;
    let lbm = (c1 * h2r) + (c2 * this.weight) + (c3 * this.age) + c4;

    if (lbm > this.weight) lbm = this.weight * 0.96;

    // --- 2. Core metrics ---
    const bodyFatKg = this.weight - lbm;
    const bodyFatPercent = Math.max(3.0, Math.min((bodyFatKg / this.weight) * 100, 60.0));

    const waterCoeff = this.isAthlete ? 0.74 : 0.73;
    const waterPercent = (lbm * waterCoeff / this.weight) * 100;

    const boneMass = lbm * 0.042;

    // --- 3. Skeletal Muscle Mass ---
    const smmFactor = this.isAthlete ? 0.60 : 0.54;
    const muscleMass = lbm * smmFactor;

    // --- 4. Visceral Fat Rating (1-59) ---
    let visceralRating;
    if (bodyFatPercent > 10) {
      visceralRating = (bodyFatPercent * 0.55) - 4 + (this.age * 0.08);
    } else {
      visceralRating = 1;
    }
    visceralRating = Math.max(1, Math.min(Math.trunc(visceralRating), 59));

    // --- 5. Physique Rating (1-9) ---
    let physiqueRating = 5;

    if (bodyFatPercent > 25) {
      physiqueRating = muscleMass > (this.weight * 0.4) ? 2 : 1;
    } else if (bodyFatPercent < 18) {
      if (muscleMass > (this.weight * 0.45)) {
        physiqueRating = 9;
      } else if (muscleMass > (this.weight * 0.4)) {
        physiqueRating = 8;
      } else {
        physiqueRating = 7;
      }
    } else {
      if (muscleMass > (this.weight * 0.45)) {
        physiqueRating = 6;
      } else if (muscleMass < (this.weight * 0.38)) {
        physiqueRating = 4;
      } else {
        physiqueRating = 5;
      }
    }

    // --- 6. BMI & BMR (Mifflin-St Jeor) ---
    const heightM = this.height / 100.0;
    const bmi = this.weight / (heightM * heightM);

    const baseBmr = (10 * this.weight) + (6.25 * this.height) - (5 * this.age);
    const offset = this.gender === 'male' ? 5 : -161;
    let bmr = baseBmr + offset;
    if (this.isAthlete) bmr *= 1.05;

    // --- 7. Metabolic Age ---
    const idealBmr = (10 * this.weight) + (6.25 * this.height) - (5 * 25) + 5;
    let metabolicAge = this.age + Math.trunc((idealBmr - bmr) / 15);
    if (metabolicAge < 12) metabolicAge = 12;
    if (this.isAthlete && metabolicAge > this.age) metabolicAge = this.age - 5;

    return {
      bmi:             round2(bmi),
      bodyFatPercent:  round2(bodyFatPercent),
      waterPercent:    round2(waterPercent),
      boneMass:        round2(boneMass),
      muscleMass:      round2(muscleMass),
      visceralFat:     visceralRating,
      physiqueRating:  physiqueRating,
      bmr:             Math.trunc(bmr),
      metabolicAge:    metabolicAge,
    };
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
