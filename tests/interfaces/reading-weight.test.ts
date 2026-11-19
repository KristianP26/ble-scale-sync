import { describe, it, expect } from 'vitest';
import {
  PLAUSIBLE_WEIGHT_MAX_KG,
  PLAUSIBLE_WEIGHT_MIN_KG,
  isPlausibleWeight,
} from '../../src/interfaces/reading-weight.js';

describe('isPlausibleWeight', () => {
  it('exposes the band the docs state', () => {
    expect(PLAUSIBLE_WEIGHT_MIN_KG).toBe(0.5);
    expect(PLAUSIBLE_WEIGHT_MAX_KG).toBe(700);
  });

  it.each([
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
    [-1, false],
    [0, false],
    [0.49, false],
    [0.5, true],
    [7.4, true],
    [82.4, true],
    [300, true],
    [700, true],
    [700.01, false],
    [1.6777215e134, false],
  ])('%s -> %s', (kg, expected) => {
    expect(isPlausibleWeight(kg)).toBe(expected);
  });
});
