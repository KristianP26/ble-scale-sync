import type { Gender, GarminPayload, UserProfile } from './interfaces/scale-adapter.js';
import { computeBiaFat, buildPayload } from './scales/body-comp-helpers.js';

export type { Gender };

export type BodyCompMetrics = Omit<GarminPayload, 'weight' | 'impedance'>;

export class BodyCompCalculator {
  private readonly weight: number;
  private readonly impedance: number;
  private readonly profile: UserProfile;

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
    this.profile = { height, age, gender, isAthlete };
  }

  calculate(): BodyCompMetrics | null {
    if (this.profile.height === 0 || this.weight === 0 || this.impedance === 0) {
      return null;
    }

    const fat = computeBiaFat(this.weight, this.impedance, this.profile);
    const payload = buildPayload(this.weight, this.impedance, { fat }, this.profile);

    const { weight: _w, impedance: _i, ...metrics } = payload;
    return metrics;
  }
}
