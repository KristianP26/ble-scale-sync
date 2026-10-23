import { describe, it, expect } from 'vitest';
import {
  CSV_METRIC_KEYS,
  LOG_METRIC_KEYS,
  METRICS,
  METRIC_KEYS,
} from '../../src/exporters/metrics.js';

const SEGMENT_KEYS: string[] = [
  'impedanceTrunk20kHz',
  'impedanceTrunk100kHz',
  'impedanceLeftArm20kHz',
  'impedanceLeftArm100kHz',
  'impedanceRightArm20kHz',
  'impedanceRightArm100kHz',
  'impedanceLeftLeg20kHz',
  'impedanceLeftLeg100kHz',
  'impedanceRightLeg20kHz',
  'impedanceRightLeg100kHz',
];

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
    expect(METRIC_KEYS.filter((k) => METRICS[k].optional)).toEqual([
      'skeletalMusclePercent',
      ...SEGMENT_KEYS,
    ]);
  });

  // Diagnostics stay out of the reading log (#497).
  it('keeps the segment impedances, and only those, out of the reading log', () => {
    expect(METRIC_KEYS.filter((k) => METRICS[k].diagnostic)).toEqual(SEGMENT_KEYS);
    expect(LOG_METRIC_KEYS).toEqual(METRIC_KEYS.filter((k) => !SEGMENT_KEYS.includes(k)));
  });
});
