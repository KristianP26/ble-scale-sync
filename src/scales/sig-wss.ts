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

/** SIG Date Time field bounds. 0 means "unknown" for year, month and day. */
const YEAR_MIN = 1582;
const YEAR_MAX = 9999;

/**
 * Decode a 7-byte SIG Date Time at `offset`.
 *
 * Every field is range-checked against the specification rather than handed to
 * `Date`, because `Date` does not reject the out-of-range values, it ROLLS
 * them, and each roll produces a plausible-looking timestamp that is wrong:
 *
 * - month 0 ("unknown" in the spec) becomes December of the previous year;
 * - day 0 becomes the last day of the previous month;
 * - a two-digit year, which is how a scale with a byte-sized year field
 *   reports 2026, becomes 1926, because `Date` maps 0-99 onto 1900+n.
 *
 * The last one is not cosmetic. `beurer-bf720.ts` treats any timestamp older
 * than a few minutes as a stored history record rather than a live weigh-in,
 * so a rolled-back date silently converts the reading somebody is standing on
 * into an old one.
 *
 * A field the spec cannot express is therefore no timestamp at all, which the
 * callers already handle: it is the same outcome as the flag being clear.
 */
export function parseSigDateTime(data: Buffer, offset: number): Date | undefined {
  if (offset + DATE_TIME_LEN > data.length) return undefined;

  const year = data.readUInt16LE(offset);
  const month = data[offset + 2];
  const day = data[offset + 3];
  const hours = data[offset + 4];
  const minutes = data[offset + 5];
  const seconds = data[offset + 6];

  // Years the spec does not allow but Date accepts unchanged, so the round-trip
  // below cannot see them.
  if (year < YEAR_MIN || year > YEAR_MAX) return undefined;
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;

  const d = new Date(year, month - 1, day, hours, minutes, seconds);
  // This is what rejects the rolling values, and it is deliberately the only
  // check on month and day: an explicit `month < 1 || month > 12` cannot fail
  // here, because anything the spec forbids also fails the round trip. Month 0
  // comes back as December, day 0 as the previous month's last day, 31 April as
  // 1 May, and a two-digit year as 19xx - each one differs from what went in.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return undefined;
  }
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
