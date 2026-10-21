import type {
  BleDeviceInfo,
  BodyComposition,
  BroadcastSource,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';

// ─── PICOOC Mini Lite (PICOOC-L, broadcast-only) ────────────────────────────
//
// The frame layout was first published by openScale's PicoocBroadcastHandler
// (GPL-3.0, dnsfdv), which recovered it from the PICOOC app. It was re-checked
// against the advertisement log the same owner shared in oliexdev/openScale#1512,
// cited with the other fixtures in tests/scales/picooc-mini-lite.test.ts. No
// code was copied. Where the log and that project disagree, the log wins.

/** The advertised name, in every advertisement logged. Matched exactly. */
const NAME = 'picooc-l';

/**
 * Manufacturer-data layout, 14 bytes after the company id. The company id is
 * not an assigned one: it is the first two bytes of the unit's own address
 * (0x49D0 for D0:49:..), so it differs between units.
 *
 *   [0..3]    the rest of the unit's own address, forward
 *   [4]       0x39 on every frame seen. The PICOOC app knows other, longer
 *             broadcast formats under the same name that put another value
 *             here, so only 0x39 is read
 *   [5]       0x1F on every frame seen, meaning unknown
 *   [6..7]    weight, twentieths of a kg, uint16 big-endian
 *   [8..9]    uint16 big-endian / 10, 0xFFFF when not measured: looks like an
 *             impedance in ohm; NOT published, see the class comment
 *   [10..11]  weight again, tenths of a pound, uint16 big-endian with bit 15
 *             set on every frame seen (its meaning unknown, so it is masked)
 *   [12]      display unit, 0x00 (kg) on every frame seen
 *   [13]      checksum: all 16 bytes including the company id sum to 0xFF.
 *             The company id never reaches parseBroadcast, so it is not checked
 *             here; the two weight fields must agree instead
 *
 * Each result repeats unchanged for about seven seconds, then the scale goes
 * quiet. There are no settling frames, no counter and no clock in the frame.
 */
const FRAME_LEN = 14;
const KEY_LEN = 4;
const TYPE_OFFSET = 4;
const TYPE_RESULT = 0x39;
const FIXED_OFFSET = 5;
const FIXED = 0x1f;
const WEIGHT_OFFSET = 6;
const IMPEDANCE_OFFSET = 8;
const POUND_OFFSET = 10;
const UNIT_OFFSET = 12;
const CHECKSUM_OFFSET = 13;

const IMPEDANCE_NONE = 0xffff;
const POUND_MASK = 0x7fff;
const LB_PER_KG = 2.20462;

/**
 * How far the pound field may be from the kg field before the frame is
 * refused. Captured frames agree within 0.05 kg (quantisation of both fields).
 * 1 % with a floor of 0.2 kg leaves room for another conversion factor and
 * still catches any wrong unit or divisor, which is off by 100 % or more.
 */
const AGREEMENT_FLOOR_KG = 0.2;
const AGREEMENT_SHARE = 0.01;

/** Plausible human weight, kg, as for the Etekcity scales. */
const WEIGHT_MIN_KG = 2;
const WEIGHT_MAX_KG = 250;

/**
 * How long a weight already handed out is held back while the unit keeps
 * sending it, measured from the last time it was seen. The result repeats for
 * about seven seconds; a poll transport (node-ble, noble) starts a new scan
 * runtime.scan_cooldown after an export (5 s at the least, 30 s by default),
 * and node-ble can read the last frame from BlueZ's cache after the scale has
 * gone quiet. Since the window slides, a cached frame read every 30 s is never
 * handed out again. The cost: weighing again within a minute at the same
 * weight (to 50 g) counts as the same weigh-in, which the frame cannot tell
 * apart anyway (two weigh-ins can send identical frames).
 */
const REPEAT_WINDOW_MS = 60_000;

/** Units tracked at once, oldest out. A household has one; this is a leak bound. */
const MAX_UNITS = 8;

/** See SenssunIfB7Adapter: same expiry, same reason. */
const LOG_KEY_TTL_MS = 3_000;

interface Exported {
  weightRaw: number;
  /** When this weight was last seen from the unit, monotonic ms. */
  seenAt: number;
}

/** One logging key: the last payload logged, and when it was last seen. */
interface LogKey {
  key: string | null;
  seenAt: number;
}

function inRange(kg: number): boolean {
  return kg >= WEIGHT_MIN_KG && kg <= WEIGHT_MAX_KG;
}

function hex2(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

/**
 * Adapter for the PICOOC Mini Lite (#408), which sends each finished weigh-in
 * in its advertisement and does not accept a connection.
 *
 * Weight only. [8..9] / 10 looks like an impedance in ohm (492 to 505 on five
 * frames of one unit) and lies inside the band the processor would accept, but
 * the PICOOC app computes body fat from it with a calibration it learns per
 * person, and nobody has compared our formula with the app on enough
 * weigh-ins. It is logged in debug mode, so a user's own log can be paired with
 * the app's figure later.
 */
export class PicoocMiniLiteAdapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'PICOOC Mini Lite';
  /**
   * Not custom: the claim is the exact name, which the descriptor says in full.
   * No manufacturerId: the company id is the unit's own address, so node-ble's
   * broadcast poll would read only the one declared entry. No serviceUuids:
   * the scale advertises none.
   */
  readonly match: MatchDescriptor = {
    priority: 217,
    names: { exact: [NAME] },
  };
  readonly preferPassive = true;

  /** Last weight handed out per unit, keyed by [0..3]; see REPEAT_WINDOW_MS. */
  private readonly units = new Map<string, Exported>();
  /** Logging state only; nothing below feeds a reading. */
  private readonly lastResult: LogKey = { key: null, seenAt: -Infinity };
  /** Values already warned about, as `field:value`. */
  private readonly warned = new Set<string>();

  /**
   * @param now clock, injectable so the window can be tested. Monotonic by
   *   default, like Etekcity Fit 8S: a Raspberry Pi has no RTC, and a wall
   *   clock step when NTP first syncs would bend it.
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * The exact name, which is in every advertisement logged. A record with the
   * name and no manufacturer data is claimed too; parseBroadcast decides.
   */
  matches(device: BleDeviceInfo): boolean {
    return (device.localName || '').toLowerCase() === NAME;
  }

  parseNotification(): ScaleReading | null {
    return null;
  }

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    const d = manufacturerData;
    if (d.length !== FRAME_LEN) {
      this.warnOnce(
        `len:${d.length}`,
        `PICOOC Mini Lite sent a ${d.length}-byte frame, which is not decoded, so it is ` +
          `ignored. Please report a weigh-in on #408.`,
      );
      return null;
    }
    if (d[TYPE_OFFSET] !== TYPE_RESULT) {
      this.warnOnce(
        `type:${d[TYPE_OFFSET]}`,
        `PICOOC Mini Lite sent frame type ${hex2(d[TYPE_OFFSET])}, which is not decoded, ` +
          `so such frames are ignored. Please report a weigh-in on #408.`,
      );
      return null;
    }
    if (d[FIXED_OFFSET] !== FIXED) {
      this.warnOnce(
        `fixed:${d[FIXED_OFFSET]}`,
        `PICOOC Mini Lite sent ${hex2(d[FIXED_OFFSET])} at byte 5, where every frame seen ` +
          `had 0x1f, so such frames are ignored. Please report a weigh-in on #408.`,
      );
      return null;
    }

    const weightRaw = d.readUInt16BE(WEIGHT_OFFSET);
    const kg = weightRaw / 20;
    const unit = d[UNIT_OFFSET];
    const lb = (d.readUInt16BE(POUND_OFFSET) & POUND_MASK) / 10;
    const tolerance = Math.max(AGREEMENT_FLOOR_KG, kg * AGREEMENT_SHARE);
    // Agreement before range: it is what tells another format from this one,
    // and a field misread from another format mostly lands outside the range,
    // where a range check made first would drop the frame without a word.
    if (Math.abs(lb / LB_PER_KG - kg) > tolerance) {
      // The likeliest cause is a display unit no frame has been seen in, which
      // may change what the second field holds, so the unit goes in the warning.
      this.warnOnce(
        'disagree',
        `PICOOC Mini Lite sent weight fields that disagree (${kg.toFixed(2)} kg, ` +
          `${lb.toFixed(1)} lb, display unit ${hex2(unit)}), so the weigh-in is ignored. ` +
          `Please report it on #408 with what the display showed: frame=${d.toString('hex')}`,
      );
      return null;
    }
    if (!inRange(kg)) return null;

    const unitKey = d.subarray(0, KEY_LEN).toString('hex');
    const t = this.now();
    const last = this.units.get(unitKey);
    const repeat =
      last !== undefined && last.weightRaw === weightRaw && t - last.seenAt <= REPEAT_WINDOW_MS;
    this.logResult(d, kg, lb, t, repeat);
    if (repeat) {
      last.seenAt = t;
      return null;
    }

    if (unit !== 0) {
      this.warnOnce(
        `unit:${unit}`,
        `PICOOC Mini Lite is displaying unit ${hex2(unit)}; its weight is read from the kg ` +
          `field, which agreed with the pound field. Please report a weigh-in in this unit ` +
          `on #408.`,
      );
    }
    this.remember(unitKey, { weightRaw, seenAt: t });
    return { weight: kg, impedance: 0 };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    bleLog.warn(message);
  }

  private remember(unitKey: string, exported: Exported): void {
    if (!this.units.has(unitKey) && this.units.size >= MAX_UNITS) {
      const oldest = this.units.keys().next().value;
      if (oldest !== undefined) this.units.delete(oldest);
    }
    this.units.delete(unitKey);
    this.units.set(unitKey, exported);
  }

  /**
   * One debug line per payload, not per advert (#372), including a repeat: a
   * new value in [8..9] at the same weight is worth a line of its own.
   */
  private logResult(d: Buffer, kg: number, lb: number, at: number, repeat: boolean): void {
    const hex = d.toString('hex');
    const first = hex !== this.lastResult.key || at - this.lastResult.seenAt > LOG_KEY_TTL_MS;
    this.lastResult.key = hex;
    this.lastResult.seenAt = at;
    if (!first) return;

    const zRaw = d.readUInt16BE(IMPEDANCE_OFFSET);
    const z = zRaw === IMPEDANCE_NONE ? 'none' : (zRaw / 10).toFixed(1);
    const bit15 = (d[POUND_OFFSET] & 0x80) !== 0 ? 1 : 0;
    bleLog.debug(
      `PICOOC Mini Lite result: ${kg.toFixed(2)} kg (${lb.toFixed(1)} lb) ` +
        `unit=${hex2(d[UNIT_OFFSET])} (undecoded: z=${z} lb bit 15=${bit15} ` +
        `checksum=${hex2(d[CHECKSUM_OFFSET])}, unchecked) frame=${hex}` +
        (repeat ? ', already reported' : ''),
    );
  }

  isComplete(reading: ScaleReading): boolean {
    return inRange(reading.weight);
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(reading.weight, 0, {}, profile);
  }
}
