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
import { LogKey } from './device-state.js';
import { ownAddressBytes, type MatchDescriptor } from './match-descriptor.js';

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
 *   [9]       unknown (01 on the #423 unit in both display units, 02 on the
 *             ble_monitor unit)
 *   [10..11]  weight, uint16 big-endian, kg * 100 in both display units
 *   [12..13]  uint16 big-endian, 0 while weighing and for the first ~1.3-1.5 s
 *             of the finished state on the #423 unit; NOT published, see
 *             RAW_FIELD_OFFSET
 *   [14]      status: high nibble is the state, low nibble the display unit
 *             (1 = kg, 2 = lb)
 *   [15]      rolling counter, +1..3 between consecutive captured adverts, wraps;
 *             it makes every advert unique, so it is left out of the logging
 *             keys below
 *   [16]      checksum: sum of [9..15], low 8 bits
 *
 * Evidence, all byte for byte:
 *   - #423, unit 64:FB:01:2D:92:50 (sold as Grifema GA2001), two frames taken
 *     while weighing: 87.30 kg and 84.20 kg, status 0x01. The reporter's log is
 *     node-ble on BlueZ.
 *   - #423, the same unit, 122 frames from the reporter's own ESPHome export,
 *     two weigh-ins: one with the display in kg, finishing on 88.10 kg (status
 *     0xA1), which is the 88.1 kg the vendor app showed; one with the display in
 *     lb (status 0x02 while weighing, 0xA2 finished) and [10..11] = 8760.
 *   - custom-components/ble_monitor test_senssun_parser.py, a raw HCI advertising
 *     report from a second unit, 18:7A:93:C1:B3:33, reading 67.25 kg with status
 *     0xA1. The report's event type is ADV_NONCONN_IND: the scale is not
 *     connectable and everything it says, it broadcasts.
 *
 * The checksum closes on every one of these frames (125 of 125). ble_monitor
 * does not check it, nor the header or the MAC, so it is this adapter's own
 * finding.
 *
 * A second variant, header 01 03 28, from a unit also sold as Grifema GA2001
 * (64:FB:01:45:98:B6). Same length, same MAC echo at [3..8], same field
 * positions, but:
 *   [9]       0x21 on the weight frames, 0x01 on one frame sent right after the
 *             finished weight frame; meaning unknown, not checked
 *   [10..11]  weight, uint16 big-endian, kg * 10 (0x043B = 108.3 kg, matched
 *             the display and the vendor app on the same weigh-in; 0x043D =
 *             108.5 kg on two more weigh-ins)
 *   [12..13]  on the 0x21 frames a copy of [10..11] in kg, or the weight in
 *             lb * 10 with the display in lb; on the 0x01 frame a number
 *             (217 to 1163 so far), possibly impedance, not published
 *   [14]      high nibble 0x0 while weighing, 0x8 once finished; low nibble 1
 *             with the display in kg, 2 in lb ([10..11] stays kg * 10)
 *   [16]      checksum: sum of [9..15] plus 0x20, low 8 bits (4 of 4 frames)
 */
const PAYLOAD_LEN = 17;

/** What differs between the two frame variants; every offset is shared. */
interface Variant {
  /** [0..2]. */
  header: readonly [number, number, number];
  /** Added to the sum of [9..15] before taking the low 8 bits. */
  checksumOffset: number;
  /** [10..11] divided by this is kilograms. */
  weightDivisor: number;
  /** High nibble of [14] on the finished frame. */
  finishedState: number;
  /** Low nibbles of [14] whose [10..11] is known to be kg. */
  units: ReadonlySet<number>;
  /** For the unknown-unit warning. */
  unitNames: string;
}

/** 02 03 11: #423 and ble_monitor. */
const VARIANT_0211: Variant = {
  header: [0x02, 0x03, 0x11],
  checksumOffset: 0,
  weightDivisor: 100,
  finishedState: 0xa0,
  units: new Set([0x01, 0x02]),
  unitNames: 'kg and lb',
};

/**
 * 01 03 28: the second Grifema GA2001 unit. As on 02 03 11, [10..11] stays in
 * kg * 10 with the display in lb (low nibble 2); [12..13] then carries lb * 10
 * on the [9] = 0x21 frames, within 0.1 lb of the kg field on 19 of 19 frames.
 */
const VARIANT_0128: Variant = {
  header: [0x01, 0x03, 0x28],
  checksumOffset: 0x20,
  weightDivisor: 10,
  finishedState: 0x80,
  units: new Set([0x01, 0x02]),
  unitNames: 'kg and lb',
};

const VARIANTS: readonly Variant[] = [VARIANT_0211, VARIANT_0128];
const MAC_OFFSET = 3;
const INFO_OFFSET = 9;
const WEIGHT_OFFSET = 10;
/**
 * [12..13]. It is 0 on every frame taken while weighing. On the ble_monitor
 * unit it is 180 on the one finished frame, which ble_monitor publishes as
 * impedance in ohm; 180 ohm is at the very bottom of a plausible whole-body
 * range for a 67 kg adult. On the #423 unit it stays 0 for the first 5 (kg) or
 * 6 (lb) adverts of the finished state, then reads 137 in the kg weigh-in and
 * 202 in the lb weigh-in 18 minutes later, probably the same person: a ratio of
 * 1.47 that no plain scale factor explains, and 137 is below the 150 ohm floor
 * of a plausible range. The vendor app showed 28.5 % body fat for the 137
 * weigh-in, but whether the app derives that from this field at all is not
 * known, so the scale is unknown. Publishing an impedance nobody has checked is
 * how Eufy P2 went wrong before; it is logged in debug mode instead, so a
 * user's own log can be paired with the app's body-fat reading later.
 *
 * The reading closes on the first finished frame, where this unit still sends
 * 0, so [12..13]=0 in a poll transport's (node-ble, noble) debug log does not
 * mean the scale sends no value.
 */
const RAW_FIELD_OFFSET = 12;
const STATUS_OFFSET = 14;
const TRAILER_OFFSET = 15;
const CHECKSUM_OFFSET = 16;

/** High nibble of the status byte: the measurement state. */
const STATUS_STATE_MASK = 0xf0;
/** 0x0_: still weighing. The only state seen before the final frame. */
const STATE_WEIGHING = 0x00;
/** Low nibble of the status byte: the unit the scale is displaying. */
const STATUS_UNIT_MASK = 0x0f;
/*
 * 02 03 11 units: 1 = kg and 2 = lb, and in both [10..11] carries kg * 100. kg is captured on
 * both units, and 88.10 kg matched the vendor app. lb is captured once (#423):
 * 87.60 as kg, 18 minutes after an 88.10 kg weigh-in, where lb * 100 would be
 * 39.73 kg and lb * 10 would be 397 kg, neither possible if the same person
 * stood on it (likely, not confirmed). What the display showed in lb was not
 * reported. Every other unit is refused rather than guessed (see Variant.units).
 */

const WEIGHT_MIN_KG = 2;
const WEIGHT_MAX_KG = 300;

function checksumOk(d: Buffer, v: Variant): boolean {
  let sum = v.checksumOffset;
  for (let i = INFO_OFFSET; i < CHECKSUM_OFFSET; i++) sum += d[i];
  return (sum & 0xff) === d[CHECKSUM_OFFSET];
}

/**
 * Length, fixed header and checksum: the frame grammar, independent of who sent
 * it. Returns the variant whose grammar the frame satisfies, or null.
 */
function variantOf(d: Buffer): Variant | null {
  if (d.length !== PAYLOAD_LEN) return null;
  for (const v of VARIANTS) {
    if (v.header.every((b, i) => d[i] === b) && checksumOk(d, v)) return v;
  }
  return null;
}

interface Frame {
  variant: Variant;
  state: number;
  unit: number;
  weight: number;
}

function decode(d: Buffer, variant: Variant): Frame {
  const status = d[STATUS_OFFSET];
  return {
    variant,
    state: status & STATUS_STATE_MASK,
    unit: status & STATUS_UNIT_MASK,
    weight: d.readUInt16BE(WEIGHT_OFFSET) / variant.weightDivisor,
  };
}

/**
 * [9..14]: everything the scale says except the rolling counter at [15] and
 * the checksum that follows it. Two adverts with the same key carry the same
 * information.
 */
function payloadKey(d: Buffer): string {
  return d.subarray(INFO_OFFSET, TRAILER_OFFSET).toString('hex');
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
  readonly preferPassive = true;

  /**
   * Logging state only. None of it feeds a reading or computeMetrics, so it is
   * safe on a shared singleton across sessions and needs no onSessionStart
   * reset (which the broadcast path would not call anyway).
   */
  private lastSettlingKg: number | null = null;
  /** [9..14] of the last finished frame logged, see payloadKey. */
  private readonly lastFinished = new LogKey();
  /** The same for a frame with an unknown status state. */
  private readonly lastUnknown = new LogKey();
  /** Header and unit, e.g. '020311:3', so each variant warns on its own. */
  private readonly unitsWarned = new Set<string>();

  /**
   * @param now clock, injectable so the key expiry can be tested. Monotonic by
   *   default, like Silvergear 108: a Raspberry Pi has no RTC, and a wall
   *   clock step when NTP first syncs would bend the expiry.
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

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
    if (m?.id !== COMPANY_ID || !variantOf(m.data)) return false;
    const own = ownAddressBytes(device.address);
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
   * A frame whose weight can be trusted as kilograms, or null. That holds for
   * the kg and the lb display; a frame in any other display unit is refused on
   * both channels, with one warning per unit value per process, since what
   * [10..11] holds in that mode is unknown.
   */
  private weightFrame(d: Buffer): Frame | null {
    const v = variantOf(d);
    if (!v) return null;
    const f = decode(d, v);
    if (!v.units.has(f.unit)) {
      this.warnUnit(d, f);
      return null;
    }
    return f;
  }

  private warnUnit(d: Buffer, f: Frame): void {
    const header = d.subarray(0, 3).toString('hex');
    const key = `${header}:${f.unit}`;
    if (this.unitsWarned.has(key)) return;
    this.unitsWarned.add(key);
    const names = f.variant.unitNames;
    bleLog.warn(
      `Senssun IF_B7 (frame ${header}) is displaying unknown unit 0x${f.unit.toString(16)}. ` +
        `Only ${names} ${names.includes(' and ') ? 'are' : 'is'} decoded, so its readings are ignored. Switch the scale to ` +
        `${names.replace(' and ', ' or ')}, or report a weigh-in in this unit on #423.`,
    );
  }

  /**
   * The weighing stream, for a display that follows the scale (#356). Only the
   * observed weighing state qualifies: a finished frame belongs to
   * parseBroadcast, and an unseen state could carry something other than a
   * weight in [10..11].
   */
  parseLiveBroadcast(manufacturerData: Buffer): LiveWeight | null {
    const f = this.weightFrame(manufacturerData);
    if (!f || f.state !== STATE_WEIGHING) return null;
    if (f.weight < WEIGHT_MIN_KG || f.weight > WEIGHT_MAX_KG) return null;
    return { weight: f.weight };
  }

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    const f = this.weightFrame(manufacturerData);
    if (!f) return null;

    if (f.state !== f.variant.finishedState) {
      // Log the value, not the advert: node-ble re-reads BlueZ's cached
      // advertisement on a timer, and a watcher sees every advert, so the same
      // value arrives many times a second, and one line per value is what tells
      // a live stream from a frozen one (#372).
      if (f.state === STATE_WEIGHING) {
        // A new weigh-in may end on the same payload as the last one, so the
        // keys of the other two states must not outlive it.
        this.lastFinished.key = null;
        this.lastUnknown.key = null;
        if (f.weight !== this.lastSettlingKg) {
          this.lastSettlingKg = f.weight;
          bleLog.debug(`Senssun IF_B7 weighing: ${f.weight.toFixed(2)} kg`);
        }
      } else {
        // A state nobody has captured yet. Say so once per payload: if this
        // unit ends a weigh-in on something other than the variant's finished
        // state, this line is the
        // only thing in a DEBUG log that explains the timeout.
        if (this.lastUnknown.first(payloadKey(manufacturerData), this.now())) {
          bleLog.debug(
            `Senssun IF_B7: status 0x${manufacturerData[STATUS_OFFSET].toString(16)} is not a ` +
              `known state, frame ignored: ${manufacturerData.toString('hex')}`,
          );
        }
      }
      return null;
    }
    this.lastSettlingKg = null;
    if (f.weight < WEIGHT_MIN_KG || f.weight > WEIGHT_MAX_KG) return null;

    // Once per payload, not per advert: the counter at [15] differs on every
    // advert of the finished state, which lasts for seconds.
    if (this.lastFinished.first(payloadKey(manufacturerData), this.now())) {
      const hex = manufacturerData.toString('hex');
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
