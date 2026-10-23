import { describe, it, expect } from 'vitest';
import { CSV_METRIC_KEYS, METRICS, METRIC_KEYS } from '../../src/exporters/metrics.js';

describe('METRICS', () => {
  // The CSV header is written once, when the file is created, so these are
  // the columns of every CSV this project ever wrote (#497).
  it('keeps the CSV columns to the eleven fields every payload carries', () => {
    expect(CSV_METRIC_KEYS).toEqual([
      'weight',
      'impedance',
      'bmi',
      'bodyFatPercent',
      'waterPercent',
      'boneMass',
      'muscleMass',
      'visceralFat',
      'physiqueRating',
      'bmr',
      'metabolicAge',
    ]);
  });

  // CSV_METRIC_KEYS narrows by the flag, so a field that is optional in
  // BodyComposition but not flagged here would reach the CSV as "undefined".
  it('flags exactly the metrics only some weigh-ins carry', () => {
    expect(METRIC_KEYS.filter((k) => METRICS[k].optional)).toEqual(['skeletalMusclePercent']);
  });
});
