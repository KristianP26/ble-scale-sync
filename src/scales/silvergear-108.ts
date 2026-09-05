import type {
  BleDeviceInfo,
  BodyComposition,
  BroadcastSource,
  LiveWeight,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import { uuidClaimHits, type MatchDescriptor } from './match-descriptor.js';

// ─── Silvergear Smart Scale 108 (broadcast-only, obfuscated 0xA0AC advert) ───

/**
 * Company id in the advertisement's manufacturer data.
 *
 * Not a Bluetooth SIG assignment: the vendor invented it. On air the element
 * reads `ac a0 ...`, and the Lefu FFB0 family's 0x02AC reads `ac 02 ...`, so
 * these are plausibly the same OEM with a different variant byte. That is an
 * observation, not a basis for sharing code: the payloads are unrelated.
 */
const COMPANY_ID = 0xa0ac;

/** Vendor service the unit advertises. Nothing is ever read from it. */
const SVC_FFB0 = 'ffb0';

/**
 * Manufacturer-data layout, 12 bytes after the company id:
 *
 *   [0..5]  the device's own MAC, reversed
 *   [6..11] the payload below
 *
 * Payload, after XOR-ing every byte with 0xA0 except where noted:
 *
 *   d[0]      status flags. bit 7 set = settled reading, clear = still settling
 *   d[1..3]   weight, 24-bit big-endian, in grams, biased by WEIGHT_BIAS
 *   p[4]      frame type, IN CLEAR (not XOR-ed): 0x0D weight, 0x06 body data
 *   p[5]      checksum, IN CLEAR
 *
 * Decoded from two iOS PacketLogger captures with known outcomes, 108.5 kg and
 * 5.6 kg (#297). Both captures contain LE advertising reports only and no ATT
 * traffic at all, which matches the reporter's nRF Connect finding that the
 * device is not connectable: everything this scale says, it broadcasts.
 */
const PAYLOAD_OFFSET = 6;
const PAYLOAD_LEN = 6;
const MFG_LEN = PAYLOAD_OFFSET + PAYLOAD_LEN;
const OBFUSCATION_KEY = 0xa0;

/**
 * Constant subtracted from the 24-bit field to get grams.
 *
 * Fixed empirically: it is the value that makes the idle frame read exactly
 * zero. That frame, payload `a0 2c a0 a0 0d b9`, appears in BOTH captures, so
 * it is a genuine zero-load reading rather than a coincidence of one session.
 */
const WEIGHT_BIAS = 0x8c0000;

/** p[4]: a weight frame. */
const FRAME_TYPE_WEIGHT = 0x0d;

/**
 * p[4]: the post-weigh-in frame. Its d[0..1] big-endian field reads 529 for the
 * 108.5 kg person and 0 for the 5.6 kg object, which is the right shape and
 * magnitude for a whole-body impedance in ohm. One sample is not a decode, so
 * it is logged and not published; a body-fat figure from the vendor app for the
 * same weigh-in is what would settle it.
 */
const FRAME_TYPE_BODY = 0x06;

/** Settled-reading flag in the de-obfuscated status byte. */
const FLAG_SETTLED = 0x80;

/**
 * Plausibility bound on a settled weight. The checksum below is only 5 bits
 * wide, so it alone would accept roughly one malformed frame in 32; this makes
 * the frame gate depend on the payload as well as on its checksum.
 */
const WEIGHT_MIN_KG = 2;
const WEIGHT_MAX_KG = 300;

/**
 * The last payload byte is two fields, not one.
 *
 * Low 5 bits: a checksum over the other five OBFUSCATED bytes. Verified against
 * every advertisement in four captures covering three display units, 200+
 * frames, none failing.
 *
 * High 3 bits: the unit the scale is DISPLAYING. Reading the whole byte as a
 * checksum against a fixed 0xA0 base is what the first version of this adapter
 * did, and it rejected every frame from a scale not set to kilograms (#297).
 *
 * The weight itself does NOT change with the display unit. A capture taken with
 * the scale reading `17 st 2 lb`, and another reading `240.0 lb`, both decode to
 * 108.86 kg from the same 24-bit gram field, and 17 st 2 lb is 108.862 kg. So
 * the unit is presentation only and nothing here converts.
 */
const CHECKSUM_MASK = 0x1f;
const UNIT_MASK = 0xe0;

/** Observed values of the unit field. An unseen value is not a reason to reject. */
const UNIT_NAMES: Record<number, string> = {
  0xa0: 'kg',
  0x80: 'lb',
  0xe0: 'st',
};

function payloadChecksum(p: Buffer): number {
  return (p[0] + p[1] + p[2] + p[3] + p[4]) & CHECKSUM_MASK;
}

/** True when the frame's checksum closes, whatever unit the scale is showing. */
function checksumOk(p: Buffer): boolean {
  return (p[5] & CHECKSUM_MASK) === payloadChecksum(p);
}

/**
 * Adapter for the Silvergear Smart Scale 108 (#297).
 *
 * Broadcast only. The unit advertises ADV_NONCONN_IND, so there is no GATT
 * connection to make and no handshake to replay; a connect attempt is what the
 * reporter's original BlueZ error came from, since BlueZ discards the Device1
 * object for a non-connectable peer the moment discovery stops.
 *
 * Weight only. The advertisement carries no impedance that has been decoded, so
 * body composition is estimated from BMI.
 */
export class Silvergear108Adapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'Silvergear Smart Scale 108';
  /**
   * Above the generic Standard GATT catch-all, and custom because the claim is
   * a payload shape rather than a name: the unit advertises "108", which is far
   * too generic to match on.
   */
  readonly match: MatchDescriptor = {
    priority: 212,
    custom: true,
    serviceUuids: [SVC_FFB0],
    manufacturerId: COMPANY_ID,
  };
  readonly normalizesWeight = true;
  readonly preferPassive = true;

  matches(device: BleDeviceInfo): boolean {
    const m = device.manufacturerData;
    if (m?.id !== COMPANY_ID || m.data.length !== MFG_LEN) return false;
    // The service list is absent on some transports (BlueZ exposes no advertised
    // UUIDs before a connection), so it narrows the claim when present rather
    // than being required. The company id plus the exact 12-byte length plus the
    // checksum below is already a far narrower fingerprint than a name.
    const uuids = device.serviceUuids ?? [];
    if (uuids.length > 0 && !uuidClaimHits([SVC_FFB0], uuids)) return false;
    const p = m.data.subarray(PAYLOAD_OFFSET);
    // Gate on the frame grammar as well as the checksum. The checksum is only
    // five bits wide, so on its own it would accept roughly one unrelated
    // payload in 32; requiring a known frame type costs nothing on real frames
    // and matters because this adapter outranks Robi, Hutbit and MGB, so a
    // same-OEM sibling appearing on 0xA0AC would otherwise be claimed here.
    if (p[4] !== FRAME_TYPE_WEIGHT && p[4] !== FRAME_TYPE_BODY) return false;
    return checksumOk(p);
  }

  parseNotification(): ScaleReading | null {
    return null;
  }

  /**
   * Decode a weight frame into its settled flag and kilograms, or null when the
   * buffer is not one.
   *
   * Shared by `parseBroadcast` and `parseLiveBroadcast` so the two can never
   * disagree about what a frame says: they differ only in which side of the
   * settled flag they answer for (#356).
   */
  private decodeWeightFrame(manufacturerData: Buffer): { settled: boolean; weight: number } | null {
    if (manufacturerData.length !== MFG_LEN) return null;
    const p = manufacturerData.subarray(PAYLOAD_OFFSET);
    if (!checksumOk(p)) return null;
    if (p[4] !== FRAME_TYPE_WEIGHT) return null;

    const flags = p[0] ^ OBFUSCATION_KEY;
    const grams =
      (((p[1] ^ OBFUSCATION_KEY) << 16) |
        ((p[2] ^ OBFUSCATION_KEY) << 8) |
        (p[3] ^ OBFUSCATION_KEY)) -
      WEIGHT_BIAS;
    return { settled: (flags & FLAG_SETTLED) !== 0, weight: grams / 1000 };
  }

  /**
   * The settling stream, for a display that follows the scale (#356).
   *
   * Returns nothing for a settled frame, which `parseBroadcast` owns, so one
   * advertisement is never reported through both channels. The same
   * plausibility bound applies: a garbled frame must not put 6553 kg on
   * somebody's screen just because it is only a display.
   */
  parseLiveBroadcast(manufacturerData: Buffer): LiveWeight | null {
    const frame = this.decodeWeightFrame(manufacturerData);
    if (!frame || frame.settled) return null;
    if (frame.weight < WEIGHT_MIN_KG || frame.weight > WEIGHT_MAX_KG) return null;
    return { weight: frame.weight };
  }

  /** Last settling weight logged, so a re-polled advertisement logs once. */
  private lastSettlingKg: number | null = null;

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    if (manufacturerData.length !== MFG_LEN) return null;
    const p = manufacturerData.subarray(PAYLOAD_OFFSET);
    if (!checksumOk(p)) return null;

    if (p[4] === FRAME_TYPE_BODY) {
      // Not decoded, see FRAME_TYPE_BODY. Logged so the pairing with a vendor-app
      // body-fat figure can be made from a user's own log rather than a capture.
      const d0 = p[0] ^ OBFUSCATION_KEY;
      const d1 = p[1] ^ OBFUSCATION_KEY;
      bleLog.debug(
        `Silvergear body frame (undecoded): ${manufacturerData.toString('hex')} ` +
          `field=${(d0 << 8) | d1}`,
      );
      return null;
    }
    if (p[4] !== FRAME_TYPE_WEIGHT) return null;

    const flags = p[0] ^ OBFUSCATION_KEY;
    const grams =
      (((p[1] ^ OBFUSCATION_KEY) << 16) |
        ((p[2] ^ OBFUSCATION_KEY) << 8) |
        (p[3] ^ OBFUSCATION_KEY)) -
      WEIGHT_BIAS;
    const weight = grams / 1000;

    // Only the settled frame is a reading. The settling stream is the scale
    // converging on a number and swings wildly while someone steps on
    // (the 108.5 kg capture runs 39.60, 55.48, 83.46, 107.03 ... before it
    // settles), so publishing any of it would publish a weight the scale never
    // showed. It is surfaced through `parseLiveBroadcast` instead, whose return
    // type cannot reach an exporter.
    if ((flags & FLAG_SETTLED) === 0) {
      // Log the value, not the poll. The node-ble broadcast path re-reads
      // BlueZ's cached ManufacturerData on a timer as a fallback for
      // PropertiesChanged, so an unchanged advertisement is re-parsed several
      // times a second. Printing each one produced pages of an identical line
      // and made a frozen advertisement indistinguishable from a live settling
      // stream, which is the whole question when a scale never settles (#372).
      if (weight !== this.lastSettlingKg) {
        this.lastSettlingKg = weight;
        bleLog.debug(`Silvergear settling: ${weight.toFixed(3)} kg`);
      }
      return null;
    }
    this.lastSettlingKg = null;
    if (weight < WEIGHT_MIN_KG || weight > WEIGHT_MAX_KG) return null;
    const unit = UNIT_NAMES[p[5] & UNIT_MASK] ?? `0x${(p[5] & UNIT_MASK).toString(16)}`;
    bleLog.debug(`Silvergear settled: ${weight.toFixed(3)} kg (scale is displaying ${unit})`);
    return { weight, impedance: 0 };
  }

  /**
   * Every reading that reaches here is already a settled frame, since
   * `parseBroadcast` drops the settling stream. The bound is re-stated rather
   * than assumed so a future caller cannot complete on a zero weight.
   */
  isComplete(reading: ScaleReading): boolean {
    return reading.weight >= WEIGHT_MIN_KG && reading.weight <= WEIGHT_MAX_KG;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(reading.weight, 0, {}, profile);
  }
}
