import type { ScaleReading } from '../interfaces/scale-adapter.js';
import { isHistoricalReading } from '../interfaces/reading-time.js';
import { ReadingComposition } from './body-comp-helpers.js';
import { parseSigDateTime, parseSigWeightMeasurement, trustedScaleTime } from './sig-wss.js';

/**
 * Decoder for the Bluetooth SIG Body Composition Measurement characteristic
 * (0x2A9C), shared by every adapter that speaks it.
 *
 * It existed three times over before this: `standard-gatt.ts`,
 * `sanitas-sbf72.ts` and `beurer-bf720.ts` each walked the same flags and the
 * same offsets, and only the Beurer copy rejected the sentinels. The other two
 * exported a fabricated body composition from a frame that says it has none
 * (#405), and those two now decode through this module. `beurer-bf720.ts`
 * still has its own walk (it caches fields across frames and has its own
 * zeroed-stub rules); `tests/scales/sig-bcs.test.ts` cross-checks the two on
 * the #229 captures. `SigMeasurementPairing` at the bottom pairs this
 * characteristic with 0x2A9D for the two adapters that speak plain SIG.
 * `renpho.ts` has a fourth walk over the same characteristic
 * and is deliberately NOT folded in: it keeps the first impedance across a
 * split indication and ignores the fat outright, so its rules genuinely differ.
 *
 * Layout, per the SIG specification:
 *   Bytes 0-1 : Flags (uint16 LE)
 *   Bytes 2-3 : Body Fat Percentage (uint16 LE, resolution 0.1 %) - mandatory
 *   then the optional fields, in flag-bit order.
 */

/** Flag bits, in the order the optional fields appear. */
const FLAG_IMPERIAL = 0x0001;
const FLAG_TIMESTAMP = 0x0002;
const FLAG_USER_ID = 0x0004;
const FLAG_BMR = 0x0008;
const FLAG_MUSCLE_PCT = 0x0010;
const FLAG_MUSCLE_MASS = 0x0020;
const FLAG_FAT_FREE_MASS = 0x0040;
const FLAG_SOFT_LEAN_MASS = 0x0080;
const FLAG_WATER_MASS = 0x0100;
const FLAG_IMPEDANCE = 0x0200;
const FLAG_WEIGHT = 0x0400;
const FLAG_HEIGHT = 0x0800;

/**
 * "Measurement unsuccessful / unavailable" in every 16-bit field of this
 * characteristic. Left unguarded it decodes as 6553.5 %, which drives lean mass
 * negative and exports a negative bone mass and water percentage.
 */
const SIG_UNAVAILABLE = 0xffff;

/** User ID the SIG specification reserves for "unknown user". */
const SIG_UNKNOWN_USER = 0xff;

/**
 * A scale-reported percentage, or undefined when the scale reported nothing.
 * The mass fields below apply the same rule inline.
 *
 * Zero is not a measurement (the #386 rule, and `beurer-sanitas.ts` has said so
 * in its own `measured()` since): 35 of the 36 body-composition frames in the
 * #229 BF788 capture were zeroed stubs, and a zero muscle percentage passes
 * `comp.muscle != null` in buildPayload and exports 0 kg of muscle plus a
 * physique rating computed from it.
 */
function measuredPct(raw: number): number | undefined {
  if (raw === 0 || raw === SIG_UNAVAILABLE) return undefined;
  return raw * 0.1;
}

export interface SigBodyComposition {
  /** Kilograms, or undefined when the frame carries no weight field. */
  weightKg?: number;
  /** Ohms, or undefined when the frame carries no impedance field. */
  impedanceOhm?: number;
  /** Percent, or undefined when absent or reported as a sentinel. */
  bodyFatPercent?: number;
  /** Percent, or undefined when absent or reported as a sentinel. */
  musclePct?: number;
  /** Kilograms of body water, or undefined when absent. */
  waterMassKg?: number;
  /** Kilograms of soft lean mass, or undefined when absent. */
  softLeanKg?: number;
  /** Offset of the 7-byte timestamp field, for adapters that decode it. */
  timestampOffset?: number;
  /** Measurement time, when the frame carries a usable Date Time (C-02). */
  timestamp?: Date;
  /** The scale's user slot, when the frame carries a User ID other than 0xFF. */
  userIndex?: number;
}

/**
 * Decode one 0x2A9C frame. Returns null for a frame too short to carry even the
 * mandatory field.
 *
 * Truncation is tolerated the way the callers always tolerated it: a field
 * whose bytes are not there is simply left undefined rather than failing the
 * whole frame, because a scale that sets a flag it then does not fill is a
 * real thing and the weight is usually still usable.
 */
export function parseSigBodyComposition(data: Buffer): SigBodyComposition | null {
  if (data.length < 4) return null;

  let offset = 0;
  const flags = data.readUInt16LE(offset);
  offset += 2;

  const isKg = (flags & FLAG_IMPERIAL) === 0;
  // Mass fields: 0.005 kg per unit, 0.01 lb per unit.
  const massMultiplier = isKg ? 0.005 : 0.01;
  const toKg = (raw: number): number => (isKg ? raw : raw * 0.453592);

  const result: SigBodyComposition = {};

  result.bodyFatPercent = measuredPct(data.readUInt16LE(offset));
  offset += 2;

  if (flags & FLAG_TIMESTAMP) {
    result.timestampOffset = offset;
    const ts = parseSigDateTime(data, offset);
    if (ts) result.timestamp = ts;
    offset += 7;
  }
  if (flags & FLAG_USER_ID) {
    if (offset < data.length && data[offset] !== SIG_UNKNOWN_USER) result.userIndex = data[offset];
    offset += 1;
  }
  if (flags & FLAG_BMR) offset += 2;

  if (flags & FLAG_MUSCLE_PCT && offset + 2 <= data.length) {
    result.musclePct = measuredPct(data.readUInt16LE(offset));
    offset += 2;
  }
  if (flags & FLAG_MUSCLE_MASS && offset + 2 <= data.length) offset += 2;
  if (flags & FLAG_FAT_FREE_MASS && offset + 2 <= data.length) offset += 2;

  if (flags & FLAG_SOFT_LEAN_MASS && offset + 2 <= data.length) {
    const raw = data.readUInt16LE(offset);
    offset += 2;
    // Same rule as the percentages: a zero here is a stub, not a person with no
    // soft lean mass, and a caller deriving bone as lean - softLean would
    // report the whole lean mass as bone.
    if (raw !== 0 && raw !== SIG_UNAVAILABLE) result.softLeanKg = toKg(raw * massMultiplier);
  }

  if (flags & FLAG_WATER_MASS && offset + 2 <= data.length) {
    const raw = data.readUInt16LE(offset);
    offset += 2;
    if (raw !== 0 && raw !== SIG_UNAVAILABLE) result.waterMassKg = toKg(raw * massMultiplier);
  }

  if (flags & FLAG_IMPEDANCE && offset + 2 <= data.length) {
    const raw = data.readUInt16LE(offset);
    offset += 2;
    // Resolution 0.1 ohm. A sentinel here is not turned into an impedance,
    // which is what the plausibility guard in body-comp-helpers would reject
    // anyway - this just stops it being exported as a raw number too.
    if (raw !== SIG_UNAVAILABLE) result.impedanceOhm = raw * 0.1;
  }

  if (flags & FLAG_WEIGHT && offset + 2 <= data.length) {
    const raw = data.readUInt16LE(offset);
    offset += 2;
    if (raw !== SIG_UNAVAILABLE) result.weightKg = toKg(raw * massMultiplier);
  }

  if (flags & FLAG_HEIGHT && offset + 2 <= data.length) offset += 2;

  return result;
}

/**
 * The `ScaleReading` shape the callers build from a decoded frame: absent
 * fields become 0, which is what every caller's `isComplete` already expects.
 */
export function toScaleReading(decoded: SigBodyComposition): ScaleReading {
  return { weight: decoded.weightKg ?? 0, impedance: decoded.impedanceOhm ?? 0 };
}

/** Body composition a SIG scale measured itself, carried to `computeMetrics`. */
export interface SigMeasuredComp {
  bodyFatPercent?: number;
  musclePct?: number;
  waterMassKg?: number;
}

/**
 * One SIG weigh-in assembled from its 0x2A9D Weight Measurement and the 0x2A9C
 * Body Composition Measurement that follows it, for the adapters that speak
 * both without a vendor layer of their own (`standard-gatt`, `sanitas-sbf72`).
 *
 * Those adapters used to subscribe 0x2A9C alone (review C-02, C-05). Weight is
 * an optional field there (flag bit 10) and mandatory only in 0x2A9D, so a
 * scale with the Weight Scale service alone never completed, a scale that puts
 * the weight in 0x2A9D and only the fat in 0x2A9C never completed either, and
 * the SIG Time Stamp was dropped from both, so a stored record replayed after
 * the consent was exported as today's weigh-in (ADR D027).
 *
 * The rules, per frame:
 *
 * - 0x2A9D opens a weigh-in. Its reading carries the weight, the frame's time
 *   and its user slot, and no composition. The session holds it
 *   (`completionHoldMs`) rather than ending on it, because a 0x2A9C may follow.
 * - 0x2A9C closes the weigh-in the last 0x2A9D opened, unless it is stamped
 *   with a different time. Its reading takes the weight from its own field when
 *   present and from the 0x2A9D otherwise, and is final.
 * - When that 0x2A9D was a stored record, it is already in the session's
 *   history buffer by the time its 0x2A9C arrives, so a second reading would
 *   export the record twice. Its composition is attached to the buffered
 *   reading instead and the 0x2A9C produces no reading of its own.
 */
export class SigMeasurementPairing {
  /** Composition pinned per reading (#394); null pinned on a weight-only one. */
  private readonly comp = new ReadingComposition<SigMeasuredComp | null>();
  /** The reading of the 0x2A9D that no 0x2A9C has closed yet. */
  private open: ScaleReading | null = null;
  /** Composition of the newest 0x2A9C, for a reading nothing was pinned to. */
  private latest: SigMeasuredComp | null = null;

  /** Forget the previous weigh-in (call from `onSessionStart`). */
  reset(): void {
    this.open = null;
    this.latest = null;
  }

  /** A 0x2A9D Weight Measurement frame. */
  onWeight(data: Buffer): ScaleReading | null {
    const m = parseSigWeightMeasurement(data);
    const kg = m.weightKg;
    // A zero weight is a stub, not a measurement, and 0xFFFF is the spec's
    // "measurement unsuccessful" (PHD Transcoding WP 3.5.4.1).
    if (kg === undefined || !(kg > 0) || !Number.isFinite(kg) || data.readUInt16LE(1) === 0xffff) {
      return null;
    }
    const reading: ScaleReading = { weight: kg, impedance: 0 };
    const ts = trustedScaleTime(m.timestamp);
    if (ts) reading.timestamp = ts;
    if (m.userIndex !== undefined) reading.userIndex = m.userIndex;
    this.comp.pin(reading, null);
    this.open = reading;
    return reading;
  }

  /** A 0x2A9C Body Composition Measurement frame. */
  onBodyComposition(data: Buffer): ScaleReading | null {
    const d = parseSigBodyComposition(data);
    if (!d) return null;
    const measured: SigMeasuredComp = {
      bodyFatPercent: d.bodyFatPercent,
      musclePct: d.musclePct,
      waterMassKg: d.waterMassKg,
    };
    this.latest = measured;

    const ts = trustedScaleTime(d.timestamp);
    const open = this.open;
    const sameWeighIn =
      open !== null && (!ts || !open.timestamp || ts.getTime() === open.timestamp.getTime());
    this.open = null;

    if (open && sameWeighIn && isHistoricalReading(open)) {
      open.impedance = d.impedanceOhm ?? 0;
      this.comp.pin(open, measured);
      return null;
    }

    const base = sameWeighIn ? open : null;
    const reading: ScaleReading = {
      weight: d.weightKg !== undefined && d.weightKg > 0 ? d.weightKg : (base?.weight ?? 0),
      impedance: d.impedanceOhm ?? 0,
    };
    const time = ts ?? base?.timestamp;
    if (time) reading.timestamp = time;
    const user = d.userIndex ?? base?.userIndex;
    if (user !== undefined) reading.userIndex = user;
    this.comp.pin(reading, measured);
    return reading;
  }

  /** True for a reading a 0x2A9C produced, which no later frame can enrich. */
  isFinal(reading: ScaleReading): boolean {
    return this.comp.of(reading, null) !== null;
  }

  /** The scale's own composition for `reading`, or null when it has none. */
  compositionOf(reading: ScaleReading): SigMeasuredComp | null {
    return this.comp.of(reading, this.latest);
  }
}
