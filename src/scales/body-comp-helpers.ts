/**
 * Shared body-composition helpers used by multiple scale adapters.
 *
 * Most consumer scales provide body-fat / water / muscle / bone directly
 * in their BLE frames.  The helpers here fill in the remaining BodyComposition
 * fields (BMI, BMR, metabolic age, physique rating) that are always
 * calculated from the user profile rather than measured by the scale.
 */

import type { UserProfile, BodyComposition } from '../interfaces/scale-adapter.js';
import { createLogger } from '../logger.js';

const biaLog = createLogger('BIA');

export interface ScaleBodyComp {
  fat?: number; // %
  water?: number; // %
  muscle?: number; // %
  bone?: number; // kg
  visceralFat?: number;
}

/**
 * BIA impedance-based body fat estimation (BIA coefficients).
 * Used by scales that report raw impedance instead of pre-computed body fat.
 */
export function computeBiaFat(weight: number, impedance: number, p: UserProfile): number {
  let c1: number, c2: number, c3: number, c4: number;

  if (p.gender === 'male') {
    if (p.isAthlete) {
      [c1, c2, c3, c4] = [0.637, 0.205, -0.18, 12.5];
    } else {
      [c1, c2, c3, c4] = [0.503, 0.165, -0.158, 17.8];
    }
  } else {
    if (p.isAthlete) {
      [c1, c2, c3, c4] = [0.55, 0.18, -0.15, 8.5];
    } else {
      [c1, c2, c3, c4] = [0.49, 0.15, -0.13, 11.5];
    }
  }

  const h2r = p.height ** 2 / impedance;
  let lbm = c1 * h2r + c2 * weight + c3 * p.age + c4;

  if (lbm > weight) lbm = weight * 0.96;

  const bodyFatKg = weight - lbm;
  return Math.max(3, Math.min((bodyFatKg / weight) * 100, 60));
}

/**
 * Impedance band a whole-body foot-to-foot reading has to fall in before it is
 * allowed to drive the BIA equation.
 *
 * Established by the Hutbit adapter in #322 after a unit started publishing
 * nonsense, and re-used by Speediance. Adult foot-to-foot BIA on this class of
 * scale sits between roughly 300 and 900 ohm; the wider bound here rejects a
 * mis-framed notification without second-guessing an unusual body. Every
 * capture-backed impedance in this project is comfortably inside it: 437 ohm on
 * a Beurer (#211), 677 ohm on a Eufy P2, 529 ohm on a Silvergear.
 */
export const IMPEDANCE_MIN_OHM = 150;
export const IMPEDANCE_MAX_OHM = 1200;

/**
 * BIA body fat, or `undefined` when the number is not a body.
 *
 * `undefined` is exactly what `buildPayload`'s `comp.fat ?? estimateBodyFat()`
 * needs to fall back to the Deurenberg estimate, so a rejected impedance lands
 * on the same figure the adapter published before rather than somewhere new.
 *
 * Rejecting matters more than it looks. `computeBiaFat` bounds its OUTPUT but
 * not its input, and both directions produce a confident wrong answer rather
 * than an obvious one: a value far too high pins the 60 % ceiling, and a value
 * far too low drives `height^2 / Z` up until lean mass exceeds body weight, at
 * which point the cap inside `computeBiaFat` pins the 4 % floor. That second
 * one is the realistic failure here, because the fields at issue are vendor
 * scalings nobody has verified against a capture: a `* 0.1` that should not be
 * there, or a correction branch that divides by 6.
 */
export function biaFatIfPlausible(
  weight: number,
  impedance: number,
  p: UserProfile,
): number | undefined {
  if (!(impedance > 0)) return undefined;
  if (impedance < IMPEDANCE_MIN_OHM || impedance > IMPEDANCE_MAX_OHM) {
    biaLog.debug(
      `Impedance ${impedance} ohm is outside ${IMPEDANCE_MIN_OHM}-${IMPEDANCE_MAX_OHM}, ` +
        `so body composition falls back to the BMI estimate rather than being computed ` +
        `from it (#386).`,
    );
    return undefined;
  }
  return computeBiaFat(weight, impedance, p);
}

/** Build a full BodyComposition from scale-provided body-comp values + user profile. */
export function buildPayload(
  weight: number,
  impedance: number,
  comp: ScaleBodyComp,
  p: UserProfile,
): BodyComposition {
  const heightM = p.height / 100;
  const bmi = weight / (heightM * heightM);

  const bodyFatPercent = comp.fat ?? estimateBodyFat(bmi, p);
  const lbm = weight * (1 - bodyFatPercent / 100);

  const waterPercent = comp.water ?? ((lbm * (p.isAthlete ? 0.74 : 0.73)) / weight) * 100;

  const boneMass = comp.bone ?? lbm * 0.042;

  // Skeletal muscle estimate: roughly the portion of lean mass that is skeletal
  // muscle. This is NOT what the muscleMass field means (see below), but the
  // physique rating's thresholds are calibrated against it, so it is kept as
  // that heuristic's input rather than silently re-scaled.
  const skeletalMuscleEstimate = lbm * (p.isAthlete ? 0.6 : 0.54);

  // Muscle mass is fat-free mass minus bone, which is what both the vendor apps
  // and Garmin Connect mean by the term. This used to fall back to the skeletal
  // muscle estimate above, which under-reports by roughly a third of body weight
  // on every impedance-only scale (#253).
  //
  // Verified against two Renpho app sessions posted in #253, where the app's own
  // numbers are internally consistent with this definition and not with the old
  // one: 65.50 kg fat-free mass - 3.28 kg bone = 62.22 vs the app's 62.20 muscle
  // mass, and 65.00 - 3.25 = 61.75 vs the app's 61.80.
  const muscleMass = comp.muscle != null ? (comp.muscle / 100) * weight : lbm - boneMass;

  let visceralFat: number;
  if (comp.visceralFat != null) {
    visceralFat = Math.max(1, Math.min(Math.trunc(comp.visceralFat), 59));
  } else if (bodyFatPercent > 10) {
    visceralFat = Math.max(1, Math.min(Math.trunc(bodyFatPercent * 0.55 - 4 + p.age * 0.08), 59));
  } else {
    visceralFat = 1;
  }

  const physiqueRating = computePhysiqueRating(
    bodyFatPercent,
    comp.muscle != null ? (comp.muscle / 100) * weight : skeletalMuscleEstimate,
    weight,
  );

  const baseBmr = 10 * weight + 6.25 * p.height - 5 * p.age;
  let bmr = baseBmr + (p.gender === 'male' ? 5 : -161);
  if (p.isAthlete) bmr *= 1.05;

  const idealBmr = 10 * weight + 6.25 * p.height - 5 * 25 + 5;
  let metabolicAge = p.age + Math.trunc((idealBmr - bmr) / 15);
  if (metabolicAge < 12) metabolicAge = 12;
  if (p.isAthlete && metabolicAge > p.age) metabolicAge = p.age - 5;

  return {
    weight: r2(weight),
    impedance: r2(impedance),
    bmi: r2(bmi),
    bodyFatPercent: r2(bodyFatPercent),
    waterPercent: r2(waterPercent),
    boneMass: r2(boneMass),
    muscleMass: r2(muscleMass),
    visceralFat,
    physiqueRating,
    bmr: Math.trunc(bmr),
    metabolicAge,
  };
}

/** Deurenberg formula — fallback when no scale body-fat is available. */
export function estimateBodyFat(bmi: number, p: UserProfile): number {
  const sexFactor = p.gender === 'male' ? 1 : 0;
  let bf = 1.2 * bmi + 0.23 * p.age - 10.8 * sexFactor - 5.4;
  if (p.isAthlete) bf *= 0.85;
  return Math.max(3, Math.min(bf, 60));
}

/**
 * 1 to 9 physique rating.
 *
 * The `skeletalMuscleMass` argument is the SKELETAL muscle estimate, not the
 * `muscleMass` field that buildPayload() exports. The thresholds below (0.38 to
 * 0.45 of body weight) are calibrated against that quantity; fat-free mass minus
 * bone runs well above them for almost everyone, so passing it here would pin
 * nearly every user to the top branch (#253).
 */
export function computePhysiqueRating(
  bodyFatPercent: number,
  skeletalMuscleMass: number,
  weight: number,
): number {
  const muscleMass = skeletalMuscleMass;
  if (bodyFatPercent > 25) return muscleMass > weight * 0.4 ? 2 : 1;
  if (bodyFatPercent < 18) {
    if (muscleMass > weight * 0.45) return 9;
    if (muscleMass > weight * 0.4) return 8;
    return 7;
  }
  if (muscleMass > weight * 0.45) return 6;
  if (muscleMass < weight * 0.38) return 4;
  return 5;
}

/** Expand a 16-bit UUID to the full 128-bit BLE string. */
export function uuid16(code: number): string {
  return `0000${code.toString(16).padStart(4, '0')}00001000800000805f9b34fb`;
}

/**
 * Normalize a service UUID to the 32-char, no-dash form.
 *
 * Handlers pass UUIDs in short ('181b'), dashed, or already-normalized form,
 * so short 16- and 32-bit UUIDs are expanded against the Bluetooth base UUID
 * before they are compared.
 */
export function normalizeServiceUuid(uuid: string): string {
  const stripped = uuid.toLowerCase().replace(/[-{}]/g, '');
  if (stripped.length === 4) return uuid16(Number.parseInt(stripped, 16));
  if (stripped.length === 8) return `${stripped}00001000800000805f9b34fb`;
  return stripped;
}

export function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** XOR checksum over a range of buffer bytes. */
export function xorChecksum(buf: Buffer | number[], start: number, end: number): number {
  let xor = 0;
  for (let i = start; i < end; i++) xor ^= buf[i] & 0xff;
  return xor & 0xff;
}
