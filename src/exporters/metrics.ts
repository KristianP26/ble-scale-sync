import type { BodyComposition } from '../interfaces/scale-adapter.js';

export interface MetricDef {
  /** The CSV column, also for a metric that is never written to the CSV. */
  column: string;
  /** Decimals a float metric is written with; an integer metric has none. */
  decimals?: number;
  /**
   * Only some weigh-ins carry it (#497): absent from the payload otherwise, and
   * never a CSV column, because the CSV header is written once, when the file
   * is created, and a column that comes and goes would shift every later one.
   */
  optional?: true;
}

/**
 * Every BodyComposition field, in the order the CSV, JSONL, InfluxDB and the
 * reading log use, with its CSV column and the decimals a float metric is
 * written with (an integer metric has none). A Record, so a field added to
 * BodyComposition does not compile until it is listed here.
 */
export const METRICS: Record<keyof BodyComposition, MetricDef> = {
  weight: { column: 'weight', decimals: 2 },
  impedance: { column: 'impedance' },
  bmi: { column: 'bmi', decimals: 1 },
  bodyFatPercent: { column: 'body_fat_percent', decimals: 1 },
  waterPercent: { column: 'water_percent', decimals: 1 },
  boneMass: { column: 'bone_mass', decimals: 1 },
  muscleMass: { column: 'muscle_mass', decimals: 1 },
  skeletalMusclePercent: { column: 'skeletal_muscle_percent', decimals: 1, optional: true },
  visceralFat: { column: 'visceral_fat' },
  physiqueRating: { column: 'physique_rating' },
  bmr: { column: 'bmr' },
  metabolicAge: { column: 'metabolic_age' },
};

export const METRIC_KEYS = Object.keys(METRICS) as ReadonlyArray<keyof BodyComposition>;

/** The fields every payload carries, by the type: the ones that are not optional. */
export type CoreMetricKey = {
  [K in keyof BodyComposition]-?: undefined extends BodyComposition[K] ? never : K;
}[keyof BodyComposition];

/** The CSV columns: the metrics every payload carries, in METRICS order. */
export const CSV_METRIC_KEYS: ReadonlyArray<CoreMetricKey> = METRIC_KEYS.filter(
  (k): k is CoreMetricKey => !METRICS[k].optional,
);
