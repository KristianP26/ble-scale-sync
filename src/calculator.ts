export type Gender = 'male' | 'female';

export interface RenphoMetrics {
  bmi: number;
  bodyFatPercent: number;
  waterPercent: number;
  boneMass: number;
  muscleMass: number;
  visceralFat: number;
  physiqueRating: number;
  bmr: number;
  metabolicAge: number;
}

export class RenphoCalculator {
  private readonly weight: number;
  private readonly impedance: number;
  private readonly height: number;
  private readonly age: number;
  private readonly gender: Gender;
  private readonly isAthlete: boolean;

  constructor(
    weight: number,
    impedance: number,
    height: number,
    age: number,
    gender: Gender,
    isAthlete: boolean = false,
  ) {
    this.weight = weight;
    this.impedance = impedance;
    this.height = height;
    this.age = age;
    this.gender = gender;
    this.isAthlete = isAthlete;
  }

  calculate(): RenphoMetrics | null {
    if (this.height === 0 || this.weight === 0 || this.impedance === 0) {
      return null;
    }

    let c1: number, c2: number, c3: number, c4: number;

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

    const h2r: number = (this.height ** 2) / this.impedance;
    let lbm: number = (c1 * h2r) + (c2 * this.weight) + (c3 * this.age) + c4;

    if (lbm > this.weight) lbm = this.weight * 0.96;

    const bodyFatKg: number = this.weight - lbm;
    const bodyFatPercent: number = Math.max(3.0, Math.min((bodyFatKg / this.weight) * 100, 60.0));

    const waterCoeff: number = this.isAthlete ? 0.74 : 0.73;
    const waterPercent: number = (lbm * waterCoeff / this.weight) * 100;

    const boneMass: number = lbm * 0.042;

    const smmFactor: number = this.isAthlete ? 0.60 : 0.54;
    const muscleMass: number = lbm * smmFactor;

    let visceralRating: number;
    if (bodyFatPercent > 10) {
      visceralRating = (bodyFatPercent * 0.55) - 4 + (this.age * 0.08);
    } else {
      visceralRating = 1;
    }
    visceralRating = Math.max(1, Math.min(Math.trunc(visceralRating), 59));

    let physiqueRating: number = 5;

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

    const heightM: number = this.height / 100.0;
    const bmi: number = this.weight / (heightM * heightM);

    const baseBmr: number = (10 * this.weight) + (6.25 * this.height) - (5 * this.age);
    const offset: number = this.gender === 'male' ? 5 : -161;
    let bmr: number = baseBmr + offset;
    if (this.isAthlete) bmr *= 1.05;

    const idealBmr: number = (10 * this.weight) + (6.25 * this.height) - (5 * 25) + 5;
    let metabolicAge: number = this.age + Math.trunc((idealBmr - bmr) / 15);
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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
