import { bleLog } from '../../ble/types.js';
import type { BodyComposition, ScaleReading, UserProfile } from '../../interfaces/scale-adapter.js';
import {
  buildPayload,
  compositionRejection,
  isPlausibleBmr,
  isPlausibleImpedance,
  isPlausibleMetabolicAge,
  noEstimateNote,
  type ScaleBodyComp,
} from '../body-comp-helpers.js';
import { BMI_MATCH_TOLERANCE, LIVE_MATCH_WEIGHT_KG } from './constants.js';
import { buildUserProfileFrame, type EightResult, type VaComposition } from './frames.js';

/*
 * The scale's own body composition, pinned to the reading it belongs to, and
 * the gate that decides whether it is this user's (#331). Shared by the
 * dialects whose scales send one.
 */

/** Milliseconds as seconds with one decimal for the log, or "unknown". */
export const seconds = (ms: number | null): string =>
  ms === null ? 'unknown' : `${(ms / 1000).toFixed(1)} s`;

/**
 * The scale's own results for one weigh-in (the 19-byte result block of the
 * 19-byte dialect and the CS10K, #530, or the 20-byte dialect's one-part
 * 0xB1), and what this session sent it and heard back, pinned to the reading
 * they belong to (#331).
 */
export interface ScaleCompositionPin {
  result: EightResult;
  composition: VaComposition;
  /** The profile frame this session sent and its user slot; null if none. */
  visit: { slot: number; frame: readonly number[]; algorithmFromOption?: true } | null;
  /** The scale's answer to it: `a1 <len> 02 <slot> <1 accepted | 0> .. <cs>`. */
  reply: { slot: number; ok: boolean } | null;
  /** Bit 0 of the ready frame's [3]: 1 when muscle and bone are percentages. */
  valueType: number | null;
  measuredAfterVisit: boolean;
  /**
   * Milliseconds from the scale accepting the profile to its first answer to
   * the 0x22; null without an accepted profile or without an answer. Absent on
   * the 20-byte dialect, whose result is not an answer to the 0x22.
   */
  answerAfterVisitMs?: number | null;
  a4PreludeSent: boolean;
  /**
   * The 20-byte dialect's pin (#331, D096): used only when the profile frame
   * carried `ble.qn_algorithm`, and only when its lean mass and body fat add up
   * to 100 %, the check that the 0xB1 layout was read right. Absent on the
   * 19-byte dialect.
   */
  requiresAlgorithmOption?: true;
  /**
   * The 20-byte dialect's last live weight after the acceptance (null without
   * one), which the 0xB1's weight must match to LIVE_MATCH_WEIGHT_KG: a 0xB1
   * the scale replays after a reconnect is a weigh-in from before (#331).
   * Absent on the 19-byte dialect.
   */
  liveWeightAfterVisit?: number | null;
  /**
   * The 20-byte dialect's pin (#331): the 0xB1's skeletal muscle percentage
   * ([70..71]) goes out with an accepted set, and only inside the band
   * buildPayload keeps it to (#497). On one CS10E it matched the vendor app.
   * Absent on the 19-byte dialect, whose value nobody has compared with the app.
   */
  exportsSkeletalMuscle?: true;
}

/** How far the 0xB1's lean mass and body fat may sum from 100 % (two 0.1 roundings). */
const LEAN_FAT_SUM_TOLERANCE = 0.2 + 1e-9;

/**
 * Why the scale's own composition pinned to a reading does not belong to the
 * user it was matched to, or null when it does (#331).
 *
 * The scale computes it for the profile in the visit frame we sent (age,
 * height in mm, sex; its BMI in 0x15 fits the height we sent, not the app's),
 * and for nothing else we can check. So it is used only when the scale
 * accepted that profile and measured after accepting it (a live frame after
 * the acceptance, or its first answer to the 0x22 at least
 * MEASURED_ANSWER_MIN_MS after it: the scale sends nothing during its BIA,
 * so a weight that settled just before the acceptance has only that answer
 * to show for it), the weigh-in is on that slot, the matched user has
 * exactly that profile, and the scale's BMI fits the height to within its
 * 0.1 rounding: one centimetre already moves it by more than that. A
 * session that sent the `qn_a4_prelude` frames overwrote the slot's stored
 * segment values with someone else's, which the scale corrects its channels
 * with, so it is never used there. On the 20-byte dialect also see
 * `requiresAlgorithmOption`.
 */
function scaleCompositionRejection(pin: ScaleCompositionPin, profile: UserProfile): string | null {
  const { visit, reply, result, composition } = pin;
  if (!visit) return 'this session sent the scale no profile of a configured user';
  if (pin.requiresAlgorithmOption && !visit.algorithmFromOption) {
    return 'the profile frame went out without ble.qn_algorithm, which the 20-byte dialect needs';
  }
  if (!reply) return 'the scale did not answer the profile frame';
  if (!reply.ok || reply.slot !== visit.slot) return 'the scale did not accept the profile';
  if (!pin.measuredAfterVisit) {
    const answerMs = pin.answerAfterVisitMs ?? null;
    return answerMs === null
      ? 'the scale sent no live weight after it accepted the profile'
      : `the scale answered ${seconds(answerMs)} after it accepted the ` +
          'profile, with no live weight in between, so it most likely measured before that';
  }
  if (pin.requiresAlgorithmOption) {
    // The scale streams its stable live frame just before the 0xB1, so a
    // result of this weigh-in carries that frame's weight; a 0xB1 replayed
    // after a reconnect follows the live frames of another weigh-in, or none.
    const live = pin.liveWeightAfterVisit ?? null;
    if (live === null || Math.abs(live - result.weight) > LIVE_MATCH_WEIGHT_KG + 1e-9) {
      return "the result's weight is not the one the scale streamed after it accepted the profile";
    }
  }
  if (pin.a4PreludeSent) {
    return "ble.qn_a4_prelude overwrote the scale's segment values in this session";
  }
  if (result.slot !== visit.slot) return 'the weigh-in is on another user slot of the scale';
  if (pin.valueType !== 1) return 'the scale did not report its results as percentages';
  if (
    pin.requiresAlgorithmOption &&
    Math.abs(composition.lbm + result.fatPercent - 100) > LEAN_FAT_SUM_TOLERANCE
  ) {
    return "the scale's lean mass and body fat do not add up to 100 %";
  }
  const expected = buildUserProfileFrame(profile.age, profile.height, profile.gender);
  if (expected.slice(6, 10).some((b, i) => b !== visit.frame[6 + i])) {
    return "the matched user's age, height or sex is not the profile sent to the scale";
  }
  const heightM = ((visit.frame[8] << 8) | visit.frame[9]) / 1000;
  if (Math.abs(composition.bmi - result.weight / (heightM * heightM)) > BMI_MATCH_TOLERANCE) {
    return "the scale's BMI does not fit the height sent to it";
  }
  return null;
}

/**
 * The scale's own body fat, water, muscle, bone and visceral fat, as one set
 * that stands or falls as a whole, or null with the reason logged when they
 * are not this user's or not plausible (#331). With an accepted set the
 * scale's BMR and body age (0x15 `[11..12]`, `[10]`) replace the formula BMR
 * and metabolic age, each only inside its band (D078). Athlete mode: the scale
 * has none for these scales in the vendor's published SDK, so an athlete gets
 * its values with a note rather than the BMI estimate, which is the worst one
 * for a muscular body. On the 20-byte dialect the set also carries the scale's
 * skeletal muscle percentage (`exportsSkeletalMuscle`).
 */
export function scaleCompositionPayload(
  pin: ScaleCompositionPin,
  reading: ScaleReading,
  profile: UserProfile,
): BodyComposition | null {
  const why = scaleCompositionRejection(pin, profile);
  const w = reading.weight;
  const set: ScaleBodyComp = {
    fat: pin.result.fatPercent,
    water: pin.composition.water,
    muscle: pin.composition.muscle,
    bone: (pin.composition.bone * w) / 100,
  };
  const implausible = why === null ? compositionRejection(set) : null;
  if (why !== null || implausible !== null) {
    // With a usable impedance the caller still computes body fat from it, so
    // only without one does the estimate setting decide (#497).
    const instead =
      (isPlausibleImpedance(reading.impedance) ? null : noEstimateNote(profile)) ??
      'estimating instead';
    bleLog.info(
      `QN: the scale's own body composition is not used for this weigh-in: ` +
        `${why ?? `its values are not plausible (${implausible})`}; ${instead} (#331)`,
    );
    return null;
  }
  const visceral = pin.composition.visceral;
  if (visceral >= 1 && visceral <= 59) set.visceralFat = visceral;
  // Each on its own: one outside its band falls back to the formula alone
  // (D078). They are only reached here, past both rejections above, because
  // the scale computed them from the same measurement and profile.
  const { bmr, bodyAge } = pin.composition;
  if (isPlausibleBmr(bmr)) set.bmr = bmr;
  if (isPlausibleMetabolicAge(bodyAge)) set.metabolicAge = bodyAge;
  // buildPayload exports it only next to the accepted body fat and inside its
  // band, and never estimates it (#497).
  if (pin.exportsSkeletalMuscle) set.skeletalMuscle = pin.composition.skeletalMuscle;
  bleLog.info("QN: using the scale's own body composition for this weigh-in (#331)");
  bleLog.debug(
    'QN: ' +
      (set.bmr !== undefined
        ? `BMR ${bmr} kcal from the scale`
        : `BMR calculated (the scale sent ${bmr} kcal)`) +
      ', ' +
      (set.metabolicAge !== undefined
        ? `metabolic age ${bodyAge} from the scale's body age`
        : `metabolic age calculated (the scale sent a body age of ${bodyAge})`) +
      ' (#331)',
  );
  if (profile.isAthlete) {
    bleLog.info('QN: the scale computed it without an athlete mode (#331)');
  }
  return buildPayload(w, reading.impedance, set, profile);
}
