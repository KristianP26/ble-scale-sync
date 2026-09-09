import { LBS_TO_KG } from '../ble/types.js';

/**
 * Decoder for the Bluetooth SIG Weight Measurement characteristic (0x2A9D) of
 * the Weight Scale Service (0x181D), and for the SIG Date Time field that both
 * this characteristic and Body Composition Measurement (0x2A9C) embed.
 *
 * The sibling `sig-bcs.ts` decodes 0x2A9C. It deliberately returns only
 * `timestampOffset` rather than a Date, so the Date Time decoder lives here,
 * with the first characteristic in the project that actually decodes it.
 *
 * `renpho.ts` also subscribes 0x2A9D and is deliberately NOT folded in: it uses
 * 0.05 kg per unit, ten times the SIG resolution, which is a vendor deviation
 * rather than this layout. Same reason `sig-bcs.ts` keeps Renpho out of the
 * 0x2A9C decoder.
 *
 * Layout, per the SIG specification:
 *   Byte  0    : Flags (uint8) - bit 0 imperial, bit 1 timestamp present
 *   Bytes 1-2  : Weight (uint16 LE, 0.005 kg or 0.01 lb per unit)
 *   Bytes 3-9  : Date Time, when flags bit 1 is set
 */

/** Flags bit 0: set means pounds, clear means kilograms. */
const FLAG_IMPERIAL = 0x01;
/** Flags bit 1: a 7-byte Date Time follows the weight. */
const FLAG_TIMESTAMP = 0x02;

/** Byte length of the SIG Date Time structure. */
const DATE_TIME_LEN = 7;

/**
 * Decode a 7-byte SIG Date Time at `offset`.
 *
 * Returns undefined for a truncated field, for the "unknown" year 0, and for
 * any combination that does not form a real date, so a caller can treat the
 * absence of a timestamp and an unusable one identically.
 */
export function parseSigDateTime(data: Buffer, offset: number): Date | undefined {
  if (offset + DATE_TIME_LEN > data.length) return undefined;
  const year = data.readUInt16LE(offset);
  if (year === 0) return undefined;
  const d = new Date(
    year,
    data[offset + 2] - 1,
    data[offset + 3],
    data[offset + 4],
    data[offset + 5],
    data[offset + 6],
  );
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export interface SigWeightMeasurement {
  /**
   * Kilograms. Always kilograms: a pounds frame is converted here, so an
   * adapter that sets `normalizesWeight = true` (which tells the shared layer
   * to skip its own conversion) cannot export pounds as kilograms, a 2.2x
   * error.
   *
   * Undefined only when the frame is too short to carry the field. A zero is
   * returned as zero rather than swallowed: whether a zero weight is a stub or
   * a measurement is the caller's rule, not this decoder's.
   */
  weightKg?: number;
  /** Measurement time, when the frame carries a usable Date Time. */
  timestamp?: Date;
}

/**
 * Decode one 0x2A9D frame. A frame too short for the mandatory weight yields an
 * empty result rather than throwing, matching how `sig-bcs.ts` tolerates
 * truncation.
 */
export function parseSigWeightMeasurement(data: Buffer): SigWeightMeasurement {
  if (data.length < 3) return {};

  const flags = data[0];
  const isKg = (flags & FLAG_IMPERIAL) === 0;
  const result: SigWeightMeasurement = {
    weightKg: data.readUInt16LE(1) * (isKg ? 0.005 : 0.01 * LBS_TO_KG),
  };

  if (flags & FLAG_TIMESTAMP) {
    const ts = parseSigDateTime(data, 3);
    if (ts) result.timestamp = ts;
  }

  return result;
}
