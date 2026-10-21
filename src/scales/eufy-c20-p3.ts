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
import { LogKey, UnitMap } from './device-state.js';
import { ownAddressBytes, type MatchDescriptor } from './match-descriptor.js';

// ─── Eufy Smart Scale C20 (T9130) / P3 (T9150), broadcast ───────────────────
//
// The weight offset, the locked-weight status and the names were first
// published by bdr99/eufylife-ble-client (MIT). openScale's EufyC20Handler
// (GPL-3.0, cvoinf) and two pull requests to that library (bichlesi #9,
// cubinet-code #11) read more fields. Everything below was re-checked against
// the Home Assistant debug logs owners posted in bdr99/eufylife-ble-client#3
// and #5, cited with the fixtures in tests/scales/eufy-c20-p3.test.ts. No code
// was copied from either project. Where a log and either project disagree, the
// log wins: the company id is not fixed, and the weight is final from status
// 0x05 on, not only at 0x05.

/**
 * Names the scales advertise, in the scan response only: the 31-byte
 * advertisement is full with the flags and the manufacturer data, so a passive
 * scan never sees them.
 */
const NAME_PREFIXES = ['eufy t9130', 'eufy t9150'] as const;

/**
 * Manufacturer data after the company id, 18 bytes (C20 before the impedance),
 * 24 bytes (C20 after it) or 23 bytes (P3, always).
 *
 *   company id  high byte: the first byte of the unit's own address. Low byte:
 *               0x64 on three C20 units; on P3 units it changed while
 *               weighing (0x4E -> 0x4D, 0x53 -> 0x5D). Meaning unknown, so
 *               nothing gates on it
 *   [0..4]      the rest of the unit's own address, forward
 *   [5]         0x00 on every frame seen
 *   [6..9]      the scale's clock, Unix seconds, uint32 little-endian. Within
 *               a few seconds of the host on six units, never set on one
 *   [10]        status, see the constants below
 *   [11]        0x80 on the last frame of a weigh-in, 0x40 when switching off
 *   [12..13]    weight, hundredths of a kg, uint16 little-endian
 *   [14]        0x00, or 0x01 on every frame of one unit; perhaps the display
 *               unit, but its weight was still kg
 *   [15]        heart rate in bpm once status 0xA5 is reached, 0 before
 *   [17..18]    uint16 little-endian / 10, from status 0x25 on: looks like an
 *               impedance in ohm; NOT published, see the class comment
 *   [19..21]    differs on every weigh-in, meaning unknown
 */
const MIN_LEN = 18;
const ADDRESS_LEN = 5;
const ZERO_OFFSET = 5;
const CLOCK_OFFSET = 6;
const STATUS_OFFSET = 10;
const END_OFFSET = 11;
const WEIGHT_OFFSET = 12;
const UNIT_OFFSET = 14;
const HEART_RATE_OFFSET = 15;
const IMPEDANCE_OFFSET = 17;
const TAIL_OFFSET = 19;

/**
 * Statuses in the order one weigh-in sends them: idle 0x00 or 0x0D (always
 * 0 kg), live 0x01, then the locked weight 0x05, and 0x15, 0x25, 0x65, 0xA5
 * while the scale measures impedance and heart rate. The weight does not change
 * from 0x05 on. 0x0D with [11] = 0x40 is the scale switching off.
 */
const STATUS_LIVE = 0x01;
const FINAL_STATUSES: ReadonlySet<number> = new Set([0x05, 0x15, 0x25, 0x65, 0xa5]);
const QUIET_STATUSES: ReadonlySet<number> = new Set([0x00, 0x0d]);

/** Plausible human weight, kg, as for the Etekcity scales. */
const WEIGHT_MIN_KG = 2;
const WEIGHT_MAX_KG = 250;

/**
 * How far the scale's clock may be from the host's for it to date the reading.
 * Every unit with a set clock was within seconds; the Eufy app sets the clock
 * on every connection. A clock never set (2022 on one unit) or drifted further
 * would make a live weigh-in look like history, so then the receipt time is
 * used. Well inside HISTORY_WINDOW_MS, so a kept stamp never turns a live
 * weigh-in into history.
 */
const CLOCK_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * How long, on the scale's own clock, a locked weight counts as the weigh-in
 * already handed out. Every final frame of one weigh-in lies within 20 s of
 * the first, and the last one repeats unchanged (same clock) for half a minute,
 * so a poll transport's next scan would otherwise export it again. Measured
 * from the last final frame held back, not the first exported, so a longer
 * impedance phase does not slip through. The scale's clock runs while it
 * sleeps, so a new weigh-in of the same weight a minute later is exported.
 */
const REPEAT_WINDOW_S = 60;

interface Exported {
  weightRaw: number;
  /** Scale clock, seconds, of the last final frame of this weigh-in. */
  clock: number;
}

function inRange(kg: number): boolean {
  return kg >= WEIGHT_MIN_KG && kg <= WEIGHT_MAX_KG;
}

function hasShape(d: Buffer): boolean {
  return d.length >= MIN_LEN && d[ZERO_OFFSET] === 0x00;
}

function hex2(n: number): string {
  return `0x${n.toString(16).padStart(2, '0')}`;
}

/**
 * Adapter for the Eufy Smart Scale C20 (T9130) and P3 (T9150) (#408). Both
 * send their weigh-in in a connectable advertisement; it is read from there,
 * without connecting.
 *
 * Weight only. From status 0x25 on, [17..18] / 10 looks like an impedance in
 * ohm (433 to 533 on five weigh-ins) and [15] carries a heart rate, but nobody
 * has compared either with the Eufy app for the same weigh-in. Both are logged
 * in debug mode, so a user's own log can be paired with the app's figures
 * later.
 */
export class EufyC20P3Adapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'Eufy Smart Scale C20/P3';
  /**
   * Custom because the nameless claim is the address echo, which a descriptor
   * cannot express. No manufacturerId: the low byte of the company id changes,
   * and node-ble's broadcast poll would then read only the one declared entry.
   * Priority 275, above Eufy P2 (270): a P3 whose address began 0xFF and whose
   * id low byte was 0x48 would otherwise be claimed by the P2 adapter, which
   * would read the clock as a weight.
   */
  readonly match: MatchDescriptor = {
    priority: 275,
    custom: true,
    names: { startsWith: [...NAME_PREFIXES] },
  };
  readonly preferPassive = true;

  /** Last weigh-in handed out per unit, keyed by [0..4]; see REPEAT_WINDOW_S. */
  private readonly units = new UnitMap<Exported>();
  /** Logging state only; nothing below feeds a reading. */
  private lastLiveRaw: number | null = null;
  private readonly lastFinal = new LogKey();
  /** Units whose clock was already reported as off. */
  private readonly clockReported = new Set<string>();
  /** Status values already warned about. */
  private readonly warned = new Set<number>();

  /**
   * @param wallNow wall clock, compared with the scale's clock.
   * @param now monotonic clock for the logging expiry, like Etekcity Fit 8S: a
   *   wall clock step when NTP first syncs would bend it.
   */
  constructor(
    private readonly wallNow: () => number = () => Date.now(),
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * The advertised name, or, when the name is missing (it comes only in the
   * scan response), the address echo: the high byte of the company id followed
   * by [0..4] spells the unit's own address. A device that is not this scale
   * will not happen to carry the address it is transmitting from. Without a
   * name and without an address (macOS without the scan response) there is
   * nothing safe to claim on.
   */
  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName ?? '').trim().toLowerCase();
    if (NAME_PREFIXES.some((p) => name.startsWith(p))) return true;

    const m = device.manufacturerData;
    if (!m || !hasShape(m.data)) return false;
    const own = ownAddressBytes(device.address);
    if (own === null) return false;
    const echoed =
      ((m.id >> 8) & 0xff).toString(16).padStart(2, '0') +
      m.data.subarray(0, ADDRESS_LEN).toString('hex');
    return echoed.toUpperCase() === own;
  }

  parseNotification(): ScaleReading | null {
    return null;
  }

  /** The live weight while the scale settles, for a display that follows it (#356). */
  parseLiveBroadcast(manufacturerData: Buffer): LiveWeight | null {
    const d = manufacturerData;
    if (!hasShape(d) || d[STATUS_OFFSET] !== STATUS_LIVE) return null;
    const kg = d.readUInt16LE(WEIGHT_OFFSET) / 100;
    return inRange(kg) ? { weight: kg } : null;
  }

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    const d = manufacturerData;
    if (!hasShape(d)) return null;
    const status = d[STATUS_OFFSET];
    const weightRaw = d.readUInt16LE(WEIGHT_OFFSET);
    const clock = d.readUInt32LE(CLOCK_OFFSET);
    const unitKey = d.subarray(0, ADDRESS_LEN).toString('hex');

    if (!FINAL_STATUSES.has(status)) {
      if (status === STATUS_LIVE) {
        // One line per value, not per advert (#372).
        if (weightRaw !== this.lastLiveRaw) {
          this.lastLiveRaw = weightRaw;
          bleLog.debug(`Eufy C20/P3 live: ${(weightRaw / 100).toFixed(2)} kg`);
        }
      } else if (!QUIET_STATUSES.has(status)) {
        this.unknownStatus(status, unitKey, weightRaw, clock, d);
      }
      return null;
    }
    this.lastLiveRaw = null;

    const kg = weightRaw / 100;
    if (!inRange(kg)) return null;

    const last = this.units.get(unitKey);
    const repeat = last !== undefined && this.isRepeat(last, weightRaw, clock);
    this.logFinal(d, kg, status, clock, repeat);
    if (repeat) {
      last.clock = Math.max(last.clock, clock);
      return null;
    }
    this.units.put(unitKey, { weightRaw, clock });

    const reading: ScaleReading = { weight: kg, impedance: 0 };
    const stampMs = clock * 1000;
    if (Math.abs(stampMs - this.wallNow()) <= CLOCK_TOLERANCE_MS) {
      reading.timestamp = new Date(stampMs);
    } else if (!this.clockReported.has(unitKey)) {
      this.clockReported.add(unitKey);
      bleLog.debug(
        `Eufy C20/P3 clock reads ${new Date(stampMs).toISOString()}, ` +
          `${Math.round((stampMs - this.wallNow()) / 1000)} s from this host; ` +
          `its weigh-ins are dated by their receipt time`,
      );
    }
    return reading;
  }

  /** Same weight, and the scale's clock within the window of the last final frame. */
  private isRepeat(last: Exported, weightRaw: number, clock: number): boolean {
    return last.weightRaw === weightRaw && Math.abs(clock - last.clock) <= REPEAT_WINDOW_S;
  }

  /**
   * A status outside the captured set. Warned about once per value, unless the
   * frame belongs to a weigh-in already handed out: a status sent after 0xA5
   * would otherwise ask for a report on every start, although the weigh-in it
   * ends went out from 0x05.
   */
  private unknownStatus(
    status: number,
    unitKey: string,
    weightRaw: number,
    clock: number,
    d: Buffer,
  ): void {
    const last = this.units.get(unitKey);
    if (last !== undefined && this.isRepeat(last, weightRaw, clock)) {
      bleLog.debug(
        `Eufy C20/P3 status ${hex2(status)} after a reported weigh-in, ignored: ` +
          `frame=${d.toString('hex')}`,
      );
      return;
    }
    if (this.warned.has(status)) return;
    this.warned.add(status);
    bleLog.warn(
      `Eufy C20/P3 sent status ${hex2(status)}, which is not decoded, so such frames ` +
        `are ignored. Please report a weigh-in on #408.`,
    );
  }

  /**
   * One debug line per final payload. The key leaves out the clock, which
   * ticks every second: with it, a watcher transport would log every frame of
   * the impedance phase (#372).
   */
  private logFinal(d: Buffer, kg: number, status: number, clock: number, repeat: boolean): void {
    const key = Buffer.concat([d.subarray(0, CLOCK_OFFSET), d.subarray(STATUS_OFFSET)]).toString(
      'hex',
    );
    if (!this.lastFinal.first(key, this.now())) return;

    const z =
      d.length >= IMPEDANCE_OFFSET + 2
        ? (d.readUInt16LE(IMPEDANCE_OFFSET) / 10).toFixed(1)
        : 'none';
    const tail =
      d.length >= TAIL_OFFSET + 3 ? d.subarray(TAIL_OFFSET, TAIL_OFFSET + 3).toString('hex') : '-';
    const offset = Math.round((clock * 1000 - this.wallNow()) / 1000);
    bleLog.debug(
      `Eufy C20/P3 final: ${kg.toFixed(2)} kg status=${hex2(status)} ` +
        `end=${hex2(d[END_OFFSET])} (undecoded: [14]=${hex2(d[UNIT_OFFSET])} ` +
        `hr=${d[HEART_RATE_OFFSET]} z=${z} [19..21]=${tail}) ` +
        `scale clock ${new Date(clock * 1000).toISOString()} (${offset} s from host) ` +
        `frame=${d.toString('hex')}` +
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
