import type { WeightUnit } from '../config/schema.js';

export const KG_TO_LBS = 2.20462;

export function fmtWeight(kg: number, unit: WeightUnit): string {
  if (unit === 'lbs') return `${(kg * KG_TO_LBS).toFixed(2)} lbs`;
  return `${kg.toFixed(2)} kg`;
}
