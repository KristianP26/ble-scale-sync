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
import { ownAddressBytes, uuidClaimHits, type MatchDescriptor } from './match-descriptor.js';

// ─── Etekcity Fit 8S (broadcast-only, nameless, 0x06D0 manufacturer data) ────
//
// The frame layout was first published by ronnnnnnnnnnnnn/etekcity_esf551_ble
// (MIT, FIT-8S support by Flautz); openScale's EtekcityFit8SHandler (GPL-3.0,
// basjam) is based on it. The layout and the address echo below were re-checked
// against basjam's public captures (oliexdev/openScale#1472), cited with the
// other fixtures in tests/scales/etekcity-fit8s.test.ts. No code was copied from
// either project. Where a capture and either project disagree, the capture wins.

/**
 * Etekcity's company id. It is not this scale's alone: it is the id of the
 * VeSync platform, sent by the ESF-551 (a 9-byte payload, #385), by other
 * Etekcity scales and by VeSync devices that are not scales at all, such as a
 * Levoit air purifier (12 bytes). What sets the Fit 8S apart is the 20-byte
 * frame carrying the scale's own address, plus service 0xFFD0 when the
 * transport reports services.
 */
const COMPANY_ID = 0x06d0;

/** The service the scale advertises next to the frame, on every captured advert. */
const SVC_FFD0 = 'ffd0';

/**
 * Manufacturer-data layout, 20 bytes after the company id. The scale sends it
 * as ADV_NONCONN_IND without a name or a scan response.
 *
 *   [0]       0x01 on both units seen; anything else is refused with a warning
 *   [1..6]    the unit's own address, reversed
 *   [7..9]    c0 a8 01 and c0 a9 01 on the two units; [8] equals the first
 *             address byte on both. Meaning unknown, so nothing gates on it
 *   [10..12]  weight in grams, uint24 little-endian
 *   [13..14]  uint16 little-endian, 0 until the scale has measured impedance;
 *             NOT published, see the class comment
 *   [15]      0x00 while settling (and when idle at 0 kg), 0x01 stable result
 *   [16]      display unit: 0x00 kg, 0x01 lb, 0x02 st
 *   [17..19]  02 03 00 on both units, meaning unknown
 *
 * The stable frame does not change while it repeats (no counter, no clock), so
 * the whole frame identifies one result. The first stable frame arrived 2.2 to
 * 2.3 s after the weight stopped changing, carrying the impedance with it, in
 * both captured weigh-ins (72.27 and 72.55 kg).
 *
 * The weight is grams whatever the display shows: the owner who contributed
 * the second unit's frames checked it in lb and st, and the author of the
 * captures says the same. Every captured frame is in kg, though, so the lb and
 * st case rests on their word.
 */
const FRAME_LEN = 20;
const FORMAT_OFFSET = 0;
const FORMAT = 0x01;
const MAC_OFFSET = 1;
const WEIGHT_OFFSET = 10;
const IMPEDANCE_OFFSET = 13;
const STATE_OFFSET = 15;
const UNIT_OFFSET = 16;

const STATE_SETTLING = 0x00;
const STATE_STABLE = 0x01;

/** Display units as reported; the weight field is grams in each of them. */
const UNIT_NAMES: Readonly<Record<number, string>> = { 0: 'kg', 1: 'lb', 2: 'st' };

/** Plausible human weight, kg, as for the ESF-551. The scale itself goes to 180 kg. */
const WEIGHT_MIN_KG = 2;
const WEIGHT_MAX_KG = 250;

/** See SenssunIfB7Adapter: same expiry, same reason. */
const LOG_KEY_TTL_MS = 3_000;

/**
 * How long an exported stable frame is held back when it shows up again
 * without a settling frame in between. A poll transport (node-ble, noble)
 * starts a new scan runtime.scan_cooldown after an export (5 s at the least),
 * and the stable phase lasted at least 12 s in one capture; the maker states
 * the scale switches off after 30 s. Without this the next scan would read the
 * same result again and export the weigh-in twice. Every captured weigh-in
 * begins with settling frames, which end the hold at once; the time limit only
 * bounds it for a weigh-in whose settling frames were missed.
 */
const REPEAT_HOLD_MS = 60_000;

/** Units tracked at once, oldest out. A household has one; this is a leak bound. */
const MAX_UNITS = 8;

interface Frame {
  state: number;
  unit: number;
  weight: number;
  /** [1..6] as hex: the unit this frame came from. */
  unitKey: string;
}

interface UnitState {
  /** The stable frame last handed out as a reading, as hex, until a settling frame. */
  exported: string | null;
  exportedAt: number;
}

/** One logging key: the last payload logged, and when it was last seen. */
interface LogKey {
  key: string | null;
  seenAt: number;
}

function inRange(kg: number): boolean {
  return kg >= WEIGHT_MIN_KG && kg <= WEIGHT_MAX_KG;
}

/**
 * Adapter for the Etekcity Fit 8S (#408), a broadcast-only scale that sends
 * its weigh-in without a name and without accepting a connection.
 *
 * Weight only. [13..14] behaves like a whole-body impedance in ohm (0 until the
 * scale has measured; 526 and 524 on two weigh-ins of one unit, 537 on another)
 * and lies inside the band the processor would accept, but nobody has compared
 * it with the body fat the VeSync app shows for the same weigh-in. It is logged
 * in debug mode, so a user's own log can be paired with the app's figure later.
 */
export class EtekcityFit8sAdapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'Etekcity Fit 8S';
  /**
   * Custom because the claim is the address echo, which a descriptor cannot
   * express. The company id is fixed, so node-ble's broadcast poll can safely
   * read only the 0x06D0 entry.
   */
  readonly match: MatchDescriptor = {
    priority: 216,
    custom: true,
    manufacturerId: COMPANY_ID,
    serviceUuids: [SVC_FFD0],
  };
  readonly preferPassive = true;

  /** Per-unit repeat hold, keyed by [1..6]; see REPEAT_HOLD_MS. */
  private readonly units = new Map<string, UnitState>();
  /** Logging state only; nothing below feeds a reading. */
  private lastSettlingKg: number | null = null;
  private readonly lastStable: LogKey = { key: null, seenAt: -Infinity };
  /** Values already warned about, as `field:value`. */
  private readonly warned = new Set<string>();

  /**
   * @param now clock, injectable so the expiries can be tested. Monotonic by
   *   default, like Silvergear 108: a Raspberry Pi has no RTC, and a wall
   *   clock step when NTP first syncs would bend them.
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * Company id and the 20-byte length, then who sent it. When the services are
   * known they must include 0xFFD0. When the address is known, the frame must
   * carry it reversed at [1..6]: a device that is not this scale will not
   * happen to contain the address it is transmitting from. Without an address
   * (noble on macOS) 0xFFD0 must be advertised and the frame must have the
   * captured shape at [0], [15] and [16].
   */
  matches(device: BleDeviceInfo): boolean {
    const m = device.manufacturerData;
    if (m?.id !== COMPANY_ID || m.data.length !== FRAME_LEN) return false;
    const uuids = device.serviceUuids ?? [];
    const ffd0 = uuidClaimHits([SVC_FFD0], uuids);
    if (uuids.length > 0 && !ffd0) return false;

    const own = ownAddressBytes(device.address);
    if (own !== null) {
      const echoed = Buffer.from(m.data.subarray(MAC_OFFSET, MAC_OFFSET + 6))
        .reverse()
        .toString('hex')
        .toUpperCase();
      return echoed === own;
    }
    const d = m.data;
    return (
      ffd0 &&
      d[FORMAT_OFFSET] === FORMAT &&
      (d[STATE_OFFSET] === STATE_SETTLING || d[STATE_OFFSET] === STATE_STABLE) &&
      UNIT_NAMES[d[UNIT_OFFSET]] !== undefined
    );
  }

  parseNotification(): ScaleReading | null {
    return null;
  }

  /**
   * A 20-byte frame in the known format and state, or null. An unknown format
   * or state byte is refused with one warning per value; an unknown display
   * unit is not, since the weight is grams in every unit known.
   */
  private frame(d: Buffer): Frame | null {
    if (d.length !== FRAME_LEN) return null;
    if (d[FORMAT_OFFSET] !== FORMAT) {
      this.warnOnce(
        `format:${d[FORMAT_OFFSET]}`,
        `Etekcity Fit 8S sent frame format 0x${d[FORMAT_OFFSET].toString(16)}, which is not ` +
          `decoded, so its frames are ignored. Please report a weigh-in on #408.`,
      );
      return null;
    }
    const state = d[STATE_OFFSET];
    if (state !== STATE_SETTLING && state !== STATE_STABLE) {
      this.warnOnce(
        `state:${state}`,
        `Etekcity Fit 8S sent state 0x${state.toString(16)}, which is not decoded, so such ` +
          `frames are ignored. Please report a weigh-in on #408.`,
      );
      return null;
    }
    const unit = d[UNIT_OFFSET];
    if (UNIT_NAMES[unit] === undefined) {
      this.warnOnce(
        `unit:${unit}`,
        `Etekcity Fit 8S is displaying unknown unit 0x${unit.toString(16)}; its weight is ` +
          `read as grams, as in kg, lb and st. Please report a weigh-in in this unit on #408.`,
      );
    }
    return {
      state,
      unit,
      weight: d.readUIntLE(WEIGHT_OFFSET, 3) / 1000,
      unitKey: d.subarray(MAC_OFFSET, MAC_OFFSET + 6).toString('hex'),
    };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    bleLog.warn(message);
  }

  /** True when this frame's payload should be logged (see SenssunIfB7Adapter). */
  private firstSighting(slot: LogKey, key: string): boolean {
    const at = this.now();
    const first = key !== slot.key || at - slot.seenAt > LOG_KEY_TTL_MS;
    slot.key = key;
    slot.seenAt = at;
    return first;
  }

  private unitState(key: string): UnitState {
    let state = this.units.get(key);
    if (state) return state;
    if (this.units.size >= MAX_UNITS) {
      const oldest = this.units.keys().next().value;
      if (oldest !== undefined) this.units.delete(oldest);
    }
    state = { exported: null, exportedAt: -Infinity };
    this.units.set(key, state);
    return state;
  }

  /**
   * The settling stream, for a display that follows the scale (#356). The
   * idle frame carries 0 kg and gives nothing.
   */
  parseLiveBroadcast(manufacturerData: Buffer): LiveWeight | null {
    const f = this.frame(manufacturerData);
    if (!f || f.state !== STATE_SETTLING || !inRange(f.weight)) return null;
    return { weight: f.weight };
  }

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    const f = this.frame(manufacturerData);
    if (!f) return null;

    if (f.state === STATE_SETTLING) {
      // Every weigh-in starts here, so the last result of this unit may be
      // handed out again, and a new weigh-in may end on the same payload as the
      // last one, so its logging key must not outlive it either.
      const unit = this.units.get(f.unitKey);
      if (unit) unit.exported = null;
      this.lastStable.key = null;
      // One line per value, not per advert (#372).
      if (f.weight !== this.lastSettlingKg) {
        this.lastSettlingKg = f.weight;
        bleLog.debug(`Etekcity Fit 8S settling: ${f.weight.toFixed(2)} kg`);
      }
      return null;
    }
    this.lastSettlingKg = null;
    if (!inRange(f.weight)) return null;

    const hex = manufacturerData.toString('hex');
    const t = this.now();
    const unit = this.unitState(f.unitKey);
    const repeat = unit.exported === hex && t - unit.exportedAt <= REPEAT_HOLD_MS;

    // Once per payload, not per advert: the stable frame repeats unchanged for
    // as long as the scale shows the result.
    if (this.firstSighting(this.lastStable, hex)) {
      const d = manufacturerData;
      bleLog.debug(
        `Etekcity Fit 8S stable: ${f.weight.toFixed(2)} kg (undecoded: ` +
          `impedance=${d.readUInt16LE(IMPEDANCE_OFFSET)} ` +
          `unit=${UNIT_NAMES[f.unit] ?? `0x${f.unit.toString(16)}`} ` +
          `[7..9]=${d.subarray(7, 10).toString('hex')} ` +
          `[17..19]=${d.subarray(17, 20).toString('hex')}) frame=${hex}` +
          (repeat ? ', already reported, held back until the next weigh-in' : ''),
      );
    }
    if (repeat) return null;
    unit.exported = hex;
    unit.exportedAt = t;
    return { weight: f.weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return inRange(reading.weight);
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(reading.weight, 0, {}, profile);
  }
}
