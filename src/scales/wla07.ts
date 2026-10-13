/*
 * Body composition by the vendor's "WLA07" algorithm, for AC 27 scales that
 * report algorithm 0x07 or 0x24 in their D6 result frame.
 *
 * Ported from openScale (https://github.com/oliexdev/openScale), class
 * `LibICBIACalculatorWLA07` in
 * android_app/app/src/main/java/com/health/openscale/core/bluetooth/scales/ActiveEraBF06Handler.kt
 * at commit 9fea9c8 (added in openScale PR #1464), which openScale
 * reverse-engineered from the vendor's libICBodyFatAlgorithms.so.
 * Copyright (C) 2025 olie.xdev and the openScale contributors, licensed
 * GPL-3.0-or-later; this project is GPL-3.0. Only the regression table rows
 * and the arithmetic for body fat, muscle, bone and water are taken over; the
 * rest of that class (visceral fat, BMR, protein, skeletal muscle, physical
 * age) is not, since none of it has been compared with a vendor value here.
 *
 * Checked against the vendor's own numbers on two scales (#458 display, and
 * FitDays for the ALPHA Smart Scale PRO 3 in openScale PR #1534).
 */

interface Row {
  height: number;
  weight: number;
  age: number;
  impedance: number;
  constant: number;
}

const ROWS: Record<'fat' | 'muscle' | 'water', readonly [female: Row, male: Row]> = {
  fat: [
    { height: -3332, weight: 7509, age: 196, impedance: 72, constant: 227193 },
    { height: -3315, weight: 6216, age: 183, impedance: 85, constant: 225540 },
  ],
  muscle: [
    { height: 31860, weight: 19340, age: -2060, impedance: -1320, constant: -1645560 },
    { height: 28670, weight: 38940, age: -4080, impedance: -1235, constant: -1576650 },
  ],
  water: [
    { height: 87700, weight: 297300, age: 12800, impedance: -6030, constant: 517500 },
    { height: 93900, weight: 375800, age: -3200, impedance: -6925, constant: 97000 },
  ],
};

export interface Wla07Input {
  weightKg: number;
  /** Whole centimetres, as the vendor library takes it. */
  heightCm: number;
  impedanceOhm: number;
  age: number;
  isMale: boolean;
}

export interface Wla07Result {
  /** % */
  fat: number;
  /** % of body weight (fat-free mass minus bone, as the vendor counts it) */
  muscle: number;
  /** kg */
  bone: number;
  /** % */
  water: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** The vendor's rounding to one decimal: up only when the next digit's remainder is above .5. */
function round1(value: number): number {
  let tenth = (value % 1) * 10;
  tenth = tenth % 1 > 0.5 ? Math.ceil(tenth) : Math.floor(tenth);
  return Math.trunc(value) + tenth / 10;
}

export function wla07(input: Wla07Input): Wla07Result {
  const { weightKg: w, impedanceOhm: z, age, isMale } = input;
  const h = Math.trunc(input.heightCm);
  const regress = (row: keyof typeof ROWS): number => {
    const c = ROWS[row][isMale ? 1 : 0];
    return (h * c.height + w * c.weight + age * c.age + z * c.impedance + c.constant) / 10000;
  };

  const fatRaw = clamp((regress('fat') / w) * 100, 5, 45);

  const muscleRegression = regress('muscle') / 10;
  const ffmResidual = w * (1 - fatRaw / 100) - muscleRegression;
  let muscleKg: number;
  if (ffmResidual >= 4) muscleKg = muscleRegression + ffmResidual - 4;
  else if (ffmResidual > 1) muscleKg = muscleRegression;
  else muscleKg = muscleRegression + ffmResidual - 1;
  const musclePct = (muscleKg / w) * 100;

  const bone = round1(clamp(w - (fatRaw * w) / 100 - muscleKg, 1, 4));

  const waterRaw = regress('water') / w;
  const residual = musclePct - waterRaw;
  let water: number;
  if (residual >= 32) water = musclePct - 32;
  else if (residual > 5) water = waterRaw;
  else water = musclePct - 5;

  return {
    fat: round1(fatRaw),
    muscle: round1(musclePct),
    bone,
    water: round1(clamp(water, 20, 85)),
  };
}
