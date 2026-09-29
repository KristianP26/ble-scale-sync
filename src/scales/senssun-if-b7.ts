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
import type { MatchDescriptor } from './match-descriptor.js';

// ─── Senssun IF_B7 (broadcast-only, 0x0100 manufacturer data) ────────────────

/**
 * Company id in the advertisement's manufacturer data. No other adapter in the
 * registry claims it.
 */
const COMPANY_ID = 0x0100;

/** The unit advertises this name in the advertising PDU itself, not a scan response. */
const ADVERTISED_NAME = 'if_b7';

/**
 * Manufacturer-data layout, 17 bytes after the company id:
 *
 *   [0..2]    02 03 11, constant on every frame seen
 *   [3..8]    the device's own MAC, forward
 *   [9]       unknown (01 on one unit, 02 on another)
 *   [10..11]  weight, uint16 big-endian, kg * 100
 *   [12..13]  uint16 big-endian, 0 while weighing; NOT published, see RAW_FIELD
 *   [14]      status: high nibble is the state, low nibble the display unit
 *   [15]      unknown, varies frame to frame
 *   [16]      checksum: sum of [9..15], low 8 bits
 *
 * Evidence, all byte for byte:
 *   - #423, unit 64:FB:01:2D:92:50 (sold as Grifema GA2001), two frames taken
 *     while weighing: 87.30 kg and 84.20 kg, status 0x01. The reporter's log is
 *     node-ble on BlueZ.
 *   - custom-components/ble_monitor test_senssun_parser.py, a raw HCI advertising
 *     report from a second unit, 18:7A:93:C1:B3:33, reading 67.25 kg with status
 *     0xA1. The report's event type is ADV_NONCONN_IND: the scale is not
 *     connectable and everything it says, it broadcasts.
 *
 * The checksum closes on all three frames. ble_monitor does not check it, nor
 * the header or the MAC, so it is this adapter's own finding.
 */
const PAYLOAD_LEN = 17;
const HEADER = [0x02, 0x03, 0x11] as const;
const MAC_OFFSET = 3;
const INFO_OFFSET = 9;
const WEIGHT_OFFSET = 10;
/**
 * [12..13]. It is 0 on both frames taken while weighing and 180 on the one
 * finished frame, which ble_monitor publishes as impedance in ohm. 180 ohm is
 * at the very bottom of a plausible whole-body range for a 67 kg adult, and no
 * body-fat figure from the vendor app exists for that weigh-in, so the scale
 * is unknown. Publishing an impedance nobody has checked is how Eufy P2 and
 * Silvergear 108 went wrong before; it is logged in debug mode instead, so a
 * user's own log can be paired with the app's body-fat reading later.
 */
const RAW_FIELD_OFFSET = 12;
const STATUS_OFFSET = 14;
const TRAILER_OFFSET = 15;
const CHECKSUM_OFFSET = 16;

/** High nibble of the status byte: the measurement state. */
const STATUS_STATE_MASK = 0xf0;
/** 0x0_: still weighing. The only state seen before the final frame. */
const STATE_WEIGHING = 0x00;
/** 0xA_: measurement finished (ble_monitor capture, and the #423 reporter). */
const STATE_FINISHED = 0xa0;
/** Low nibble of the status byte: the unit the scale is displaying. */
const STATUS_UNIT_MASK = 0x0f;
/**
 * 1 = kg, seen on all three frames. The #423 reporter says 2 = lb, but no lb
 * frame has been captured, so whether [10..11] still carries kg in that mode is
 * unknown. Every other unit is refused rather than guessed.
 */
const UNIT_KG = 0x01;

const WEIGHT_MIN_KG = 2;
const WEIGHT_MAX_KG = 300;

function checksumOk(d: Buffer): boolean {
  let sum = 0;
  for (let i = INFO_OFFSET; i < CHECKSUM_OFFSET; i++) sum += d[i];
  return (sum & 0xff) === d[CHECKSUM_OFFSET];
}

/** Length, fixed header and checksum: the frame grammar, independent of who sent it. */
function isFrame(d: Buffer): boolean {
  if (d.length !== PAYLOAD_LEN) return false;
  if (HEADER.some((b, i) => d[i] !== b)) return false;
  return checksumOk(d);
}

interface Frame {
  state: number;
  unit: number;
  weight: number;
}

function decode(d: Buffer): Frame {
  const status = d[STATUS_OFFSET];
  return {
    state: status & STATUS_STATE_MASK,
    unit: status & STATUS_UNIT_MASK,
    weight: d.readUInt16BE(WEIGHT_OFFSET) / 100,
  };
}

/** The six address bytes, uppercase and colon-free, or null when unknown. */
function macBytes(address: string | undefined): string | null {
  if (!address) return null;
  const clean = address.replace(/[:-]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(clean) ? clean : null;
}

/**
 * Adapter for the Senssun IF_B7 broadcast scale, sold among others as the
 * Grifema GA2001 (#423). Unrelated to the GATT-based "Senssun Fat" adapter.
 *
 * Weight only: the advertisement's one impedance-shaped field is not decoded
 * (see RAW_FIELD_OFFSET), so body composition is estimated from BMI.
 */
export class SenssunIfB7Adapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'Senssun IF_B7';
  /**
   * Custom because the claim is the payload plus the address echo, which a
   * descriptor cannot express. The priority only has to be unique: company id
   * 0x0100 and the name are claimed by nothing else.
   */
  readonly match: MatchDescriptor = {
    priority: 213,
    custom: true,
    names: { exact: [ADVERTISED_NAME] },
    manufacturerId: COMPANY_ID,
  };
  readonly normalizesWeight = true;
  readonly preferPassive = true;

  /**
   * Logging state only. None of it feeds a reading or computeMetrics, so it is
   * safe on a shared singleton across sessions and needs no onSessionStart
   * reset (which the broadcast path would not call anyway).
   */
  private lastSettlingKg: number | null = null;
  private lastFinishedHex: string | null = null;
  private readonly unitsWarned = new Set<number>();

  /**
   * Company id, frame grammar, and then who sent it. When the transport knows
   * the address, the frame must carry that same address at [3..8]: a device
   * that is not this scale will not happen to contain the address it is
   * transmitting from, which makes the claim self-validating (the same idea as
   * the ES-CS20M anonymous revision, #376). Both known units echo it forward.
   * Only when the address is unknown (noble on macOS reports none) does the
   * exact advertised name stand in for it.
   */
  matches(device: BleDeviceInfo): boolean {
    const m = device.manufacturerData;
    if (m?.id !== COMPANY_ID || !isFrame(m.data)) return false;
    const own = macBytes(device.address);
    if (own) {
      return (
        m.data
          .subarray(MAC_OFFSET, MAC_OFFSET + 6)
          .toString('hex')
          .toUpperCase() === own
      );
    }
    return (device.localName ?? '').trim().toLowerCase() === ADVERTISED_NAME;
  }

  parseNotification(): ScaleReading | null {
    return null;
  }

  /**
   * A frame whose weight can be trusted as kilograms, or null. A frame in any
   * other display unit is refused on both channels, with one warning per unit
   * value per process, since what [10..11] holds in that mode is unknown.
   */
  private kgFrame(d: Buffer): Frame | null {
    if (!isFrame(d)) return null;
    const f = decode(d);
    if (f.unit !== UNIT_KG) {
      this.warnUnit(f.unit);
      return null;
    }
    return f;
  }

  private warnUnit(unit: number): void {
    if (this.unitsWarned.has(unit)) return;
    this.unitsWarned.add(unit);
    const shown = unit === 0x02 ? 'lb' : `unknown unit 0x${unit.toString(16)}`;
    bleLog.warn(
      `Senssun IF_B7 is displaying ${shown}. Only kg is decoded, so its readings are ` +
        `ignored. Switch the scale to kg, or report a weigh-in in this unit on #423.`,
    );
  }

  /**
   * The weighing stream, for a display that follows the scale (#356). Only the
   * observed weighing state qualifies: a finished frame belongs to
   * parseBroadcast, and an unseen state could carry something other than a
   * weight in [10..11].
   */
  parseLiveBroadcast(manufacturerData: Buffer): LiveWeight | null {
    const f = this.kgFrame(manufacturerData);
    if (!f || f.state !== STATE_WEIGHING) return null;
    if (f.weight < WEIGHT_MIN_KG || f.weight > WEIGHT_MAX_KG) return null;
    return { weight: f.weight };
  }

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    const f = this.kgFrame(manufacturerData);
    if (!f) return null;

    if (f.state !== STATE_FINISHED) {
      // Log the value, not the poll: node-ble re-reads BlueZ's cached
      // advertisement on a timer, so an unchanged frame arrives many times a
      // second, and one line per value is what tells a live stream from a
      // frozen one (#372).
      if (f.state === STATE_WEIGHING && f.weight !== this.lastSettlingKg) {
        this.lastSettlingKg = f.weight;
        bleLog.debug(`Senssun IF_B7 weighing: ${f.weight.toFixed(2)} kg`);
      }
      return null;
    }
    this.lastSettlingKg = null;
    if (f.weight < WEIGHT_MIN_KG || f.weight > WEIGHT_MAX_KG) return null;

    const hex = manufacturerData.toString('hex');
    if (hex !== this.lastFinishedHex) {
      this.lastFinishedHex = hex;
      bleLog.debug(
        `Senssun IF_B7 finished: ${f.weight.toFixed(2)} kg ` +
          `(undecoded: [9]=0x${manufacturerData[INFO_OFFSET].toString(16)} ` +
          `[12..13]=${manufacturerData.readUInt16BE(RAW_FIELD_OFFSET)} ` +
          `[14]=0x${manufacturerData[STATUS_OFFSET].toString(16)} ` +
          `[15]=0x${manufacturerData[TRAILER_OFFSET].toString(16)}) frame=${hex}`,
      );
    }
    return { weight: f.weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight >= WEIGHT_MIN_KG && reading.weight <= WEIGHT_MAX_KG;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(reading.weight, 0, {}, profile);
  }
}
