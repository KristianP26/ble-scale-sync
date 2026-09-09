import type { ScaleReading } from '../interfaces/scale-adapter.js';

/**
 * Decoder for the Bluetooth SIG Body Composition Measurement characteristic
 * (0x2A9C), shared by every adapter that speaks it.
 *
 * It existed three times over before this: `standard-gatt.ts`,
 * `sanitas-sbf72.ts` and `beurer-bf720.ts` each walked the same flags and the
 * same offsets, and only the Beurer copy rejected the sentinels. The other two
 * exported a fabricated body composition from a frame that says it has none
 * (#405). `renpho.ts` has a fourth walk over the same characteristic and is
 * deliberately NOT folded in: it keeps the first impedance across a split
 * indication and ignores the fat outright, so its rules genuinely differ.
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
    offset += 7;
  }
  if (flags & FLAG_USER_ID) offset += 1;
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
