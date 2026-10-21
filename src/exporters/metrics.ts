import type { BodyComposition } from '../interfaces/scale-adapter.js';

/**
 * Every BodyComposition field, in the order the CSV, JSONL, InfluxDB and the
 * reading log use, with its CSV column and the decimals a float metric is
 * written with (an integer metric has none). A Record, so a field added to
 * BodyComposition does not compile until it is listed here.
 */
export const METRICS: Record<keyof BodyComposition, { column: string; decimals?: number }> = {
  weight: { column: 'weight', decimals: 2 },
  impedance: { column: 'impedance' },
  bmi: { column: 'bmi', decimals: 1 },
  bodyFatPercent: { column: 'body_fat_percent', decimals: 1 },
  waterPercent: { column: 'water_percent', decimals: 1 },
  boneMass: { column: 'bone_mass', decimals: 1 },
  muscleMass: { column: 'muscle_mass', decimals: 1 },
  visceralFat: { column: 'visceral_fat' },
  physiqueRating: { column: 'physique_rating' },
  bmr: { column: 'bmr' },
  metabolicAge: { column: 'metabolic_age' },
};

export const METRIC_KEYS = Object.keys(METRICS) as ReadonlyArray<keyof BodyComposition>;
