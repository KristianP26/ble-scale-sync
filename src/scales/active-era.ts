import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  Unlockable,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import {
  uuid16,
  buildPayload,
  type ScaleBodyComp,
  WEIGHT_ONLY_HOLD_MS,
} from './body-comp-helpers.js';
import {
  nameClaimHits,
  ownAddressBytes,
  uuidClaimHits,
  type MatchDescriptor,
} from './match-descriptor.js';
import { bleLog } from '../ble/types.js';

/**
 * Company id the AC 27 family advertises. It is not assigned by the Bluetooth
 * SIG; it is the frame header `AC 27` read as a little-endian u16, the same
 * pattern as the Lefu `0x02AC` (frames `AC 02`) and the Silvergear `0xA0AC`.
 */
const AC27_COMPANY_ID = 0x27ac;

const FRAME_LEN = 20;
const TYPE_WEIGHT = 0xd5;
const TYPE_RESULT = 0xd6;
const TYPE_BALANCE = 0xd0;
const TYPE_HEART_RATE = 0xd7;
const TYPE_STORED = 0xd8;
/** `[2]` of a D5 frame: the scale locked this weight. */
const FLAG_LOCKED = 0x80;

/**
 * A weight the scale streams unchanged this many times, over at least
 * `PLATEAU_MIN_MS`, completes a weigh-in that never locks (#466).
 *
 * The time is what protects against a weight still on its way: #458 streams
 * ~15 frames a second and has 3-frame runs 40 to 60 g off its final weight,
 * all shorter than a second, while every run of a second or more in the
 * captures sits exactly on the final weight. The ALPHA without a profile
 * (openScale PR #1534 capture 2, 00:09:59) and openScale #1358 both pass on
 * their fifth identical frame, 1.05 s and 1.67 s after the first.
 */
const PLATEAU_MIN_FRAMES = 5;
const PLATEAU_MIN_MS = 1000;

/** 18-bit big-endian weight in grams at `[off..off+2]` (the top 6 bits are flags). */
function weightGrams(d: Buffer, off: number): number {
  return ((d[off] << 16) | (d[off + 1] << 8) | d[off + 2]) & 0x3ffff;
}

/**
 * Whether `d` is a whole AC 27 frame: 20 bytes, header `AC 27`, and the
 * checksum `sum([2..18]) & 0x1F` in the low 5 bits of `[19]`.
 *
 * Only the low 5 bits are compared. Every captured kg unit (ALPHA, #458, #462,
 * #466) has 0 in the top three, but the Taylor 5331891 in openScale's test,
 * whose display was set to lb, carries 0x20 there. The neighbouring Silvergear
 * 108 puts its display unit in exactly those bits, so a strict compare would
 * likely drop every frame of a scale set to lb or st.
 */
export function isAc27Frame(d: Buffer): boolean {
  if (d.length !== FRAME_LEN || d[0] !== 0xac || d[1] !== 0x27) return false;
  let sum = 0;
  for (let i = 2; i <= 18; i++) sum += d[i];
  return (sum & 0x1f) === (d[19] & 0x1f);
}

/**
 * Ohms from the D6 `[4..5]` value.
 *
 * Below 1500 the value is already ohms (ALPHA 469, Femmto BCS13 533, #462).
 * From 1500 up it is a raw reading that needs the weight it was measured at:
 * `(raw - 1000 - 4 * kg) / 6`. Confirmed on #458, where 3960 at 87.62 kg gives
 * 434.92 ohm, and the vendor formula fed that value reproduces the fat, water
 * and bone the scale displayed. Clamped at 0, since just over the gate at a
 * heavy weight the formula goes negative (1500 at 130 kg gives -3.3).
 */
export function ac27ImpedanceOhm(raw: number, weightKg: number): number {
  if (raw < 1500) return raw;
  return Math.max(0, (raw - 1000 + weightKg * 10 * -0.4) / 0.6 / 10);
}

/**
 * Adapter for the AC 27 family: Active Era BS-06, ALPHA Smart Scale PRO 3
 * (FitDays), Runstar FG2431WB (Starfit), Femmto BCS13.
 *
 * Service 0xFFB0, notify 0xFFB2, write 0xFFB1. Every frame is 20 bytes,
 * `AC 27 <body [2..17]> <type [18]> <checksum [19]>` (see `isAc27Frame`):
 *
 *   D5  live weight, 18-bit grams at [3..5]; `[2]` bit 0x80 = locked
 *   D6  result: `[2]` = 01, impedance u16 at [4..5] (`ac27ImpedanceOhm`), and
 *       on the ALPHA the locked weight again at [8..10] when `[7]` has 0x80
 *   D0  balance phase (left foot), D7 heart rate, D8 stored record: logged only
 *
 * The D6 frame carries no weight on #458's unit, so the impedance is paired
 * with this session's weight: the D6's own, else the locked one, else the
 * steady one. Frame layout and evidence: `.claude/docs/PROTOCOLS.md`, section
 * on the AC 27 family.
 *
 * Completion: a locked D5, or a weight that holds still without ever locking
 * (`PLATEAU_MIN_FRAMES`), completes the weigh-in and holds the link for the D6
 * (`WEIGHT_ONLY_HOLD_MS`, extended while a locked or balancing weigh-in still
 * owes one); the D6 is final. A scale that never sends D6 still exports its
 * weight, which used to time out with nothing (#466, D028).
 */
export class ActiveEraAdapter
  implements ScaleAdapterCore, GattWiring, Unlockable, HoldForComposition
{
  /**
   * Kept although the adapter now reads the whole AC 27 family: the name is
   * the key of `ble.force_scale_adapter`, which owners already use (#458).
   */
  readonly name = 'Active Era BS-06';
  /**
   * `custom` because `matches()` needs the company id AND (an echo of the
   * device's own MAC or the advertised FFB0 service), which a descriptor cannot
   * say. Priority 50 puts it above every other FFB0 claimant (Speediance 45,
   * Robi S9 40, Hutbit 35, MGB 30), which `registry-check.ts` pins.
   * `manufacturerId` makes `resolveAfterDiscovery` treat the company id as
   * advertisement evidence, so an AC 27 scale named `icomon` stays here after
   * GATT discovery instead of falling back to MGB.
   */
  readonly match: MatchDescriptor = {
    priority: 50,
    custom: true,
    names: { includes: ['ae bs-06'] },
    serviceUuids: ['ffb0'],
    manufacturerId: AC27_COMPANY_ID,
  };
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);
  readonly normalizesWeight = true;
  /** 20-byte config packet — simplified with zeros for timestamp/user data. */
  readonly unlockCommand = [
    0xac, 0x27, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  readonly unlockIntervalMs = 0;

  readonly completionHoldMs = WEIGHT_ONLY_HOLD_MS;

  /** Kilograms of this session's last locked D5 frame, 0 when none. */
  private lockKg = 0;
  /** The current run of identical unlocked D5 weights. */
  private run = { grams: -1, count: 0, firstAt: 0 };
  /**
   * Heaviest steady weight of a session that never locked, 0 when none. The
   * heaviest, not the latest: a partial weight on the way off the scale would
   * otherwise replace the right one.
   */
  private plateauKg = 0;
  private balanceSeen = false;
  private resultSeen = false;
  private heartSeen = false;
  /** Whether the "D6 without a weight" hint was already logged this session. */
  private noWeightHinted = false;
  /** Streaming weights, shown live but never a weigh-in. */
  private live = new WeakSet<ScaleReading>();
  /** Locked or steady weights: complete, but the D6 may still follow. */
  private held = new WeakSet<ScaleReading>();

  /**
   * The BS-06 name, or the AC 27 advertisement (#458, #462, #466).
   *
   * The ALPHA Smart Scale PRO 3 (openScale PR #1534 capture) advertises FFB0
   * and manufacturer data `0x27AC` whose first six bytes are its own MAC,
   * reversed; the Runstar FG2431WB (#466) reports the same company id and FFB0.
   * The bare company id is not enough on its own (D044): it needs either the
   * MAC echo, which a device that is not this scale will not carry by
   * accident, or the FFB0 service this family is reached through. The echo is
   * what lets node-ble pick the scale before connecting, since that transport
   * does not see advertised services.
   */
  matches(device: BleDeviceInfo): boolean {
    if (nameClaimHits(this.match, device.localName)) return true;
    const m = device.manufacturerData;
    if (m?.id !== AC27_COMPANY_ID) return false;
    const own = ownAddressBytes(device.address);
    if (own && m.data.length >= 6) {
      const echoed = Buffer.from(m.data.subarray(0, 6)).reverse().toString('hex').toUpperCase();
      if (echoed === own) return true;
    }
    return uuidClaimHits(['ffb0'], device.serviceUuids);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (!isAc27Frame(data)) {
      bleLog.debug(`AC 27 frame rejected (length, header or checksum): ${data.toString('hex')}`);
      return null;
    }
    switch (data[18]) {
      case TYPE_WEIGHT:
        return this.onWeight(data);
      case TYPE_RESULT:
        return this.onResult(data);
      case TYPE_BALANCE:
        this.balanceSeen = true;
        bleLog.debug(
          `AC 27 balance: left foot ${(data.readUInt16BE(3) / 100).toFixed(2)} kg` +
            (data[2] === 0x01 ? ' (final)' : ''),
        );
        return null;
      case TYPE_HEART_RATE:
        this.heartSeen = true;
        bleLog.debug(`AC 27 heart rate: ${data[3]} bpm`);
        return null;
      case TYPE_STORED:
        // A weigh-in the scale kept because no app took it (or it locked before
        // the link was up). Not imported and not acknowledged: an ACK would make
        // the scale drop it, and the vendor app would then never get it.
        bleLog.debug(
          `AC 27 stored record: ${(weightGrams(data, 8) / 1000).toFixed(2)} kg, ` +
            `scale clock ${new Date(data.readUInt32BE(3) * 1000).toISOString()} (not imported)`,
        );
        return null;
      default:
        bleLog.debug(`AC 27 frame type 0x${data[18].toString(16)} ignored`);
        return null;
    }
  }

  private onWeight(d: Buffer): ScaleReading | null {
    const grams = weightGrams(d, 3);
    if (grams <= 0) {
      this.run = { grams: -1, count: 0, firstAt: 0 };
      return null;
    }
    const kg = grams / 1000;
    if (d[2] & FLAG_LOCKED) {
      this.lockKg = kg;
      return this.mark(this.held, { weight: kg, impedance: 0 });
    }
    const now = Date.now();
    if (grams === this.run.grams) this.run.count += 1;
    else this.run = { grams, count: 1, firstAt: now };
    if (
      this.lockKg === 0 &&
      this.run.count >= PLATEAU_MIN_FRAMES &&
      now - this.run.firstAt >= PLATEAU_MIN_MS
    ) {
      if (kg > this.plateauKg) {
        this.plateauKg = kg;
        bleLog.debug(
          `AC 27 weight steady at ${kg} kg for ${this.run.count} frames, no lock flag (#466)`,
        );
      }
      return this.mark(this.held, { weight: this.plateauKg, impedance: 0 });
    }
    return this.mark(this.live, { weight: kg, impedance: 0 });
  }

  private mark(set: WeakSet<ScaleReading>, r: ScaleReading): ScaleReading {
    set.add(r);
    return r;
  }

  /**
   * D6, paired with this session's weight.
   *
   * The ALPHA repeats the locked weight in [8..10] (`[7]` 0x80); #458's unit
   * leaves [6..10] zero, so its D6 takes the lock. Pairing it with "the last
   * D5" instead, as this adapter used to, gave whatever the stream showed last,
   * which on a unit that skips D5 entirely (#458, stepped on without waking it)
   * was nothing, or the previous session's weight before #394.
   */
  private onResult(d: Buffer): ScaleReading | null {
    if (d[2] !== 0x01) {
      bleLog.debug(`AC 27 result frame with count ${d[2]} ignored`);
      return null;
    }
    this.resultSeen = true;
    const own = d[7] & FLAG_LOCKED ? weightGrams(d, 8) / 1000 : 0;
    const kg = own || this.lockKg || this.plateauKg;
    const source = own ? 'D6' : this.lockKg ? 'lock' : 'steady weight';
    const raw = d.readUInt16BE(4);
    if (kg <= 0) {
      if (!this.noWeightHinted) {
        this.noWeightHinted = true;
        bleLog.info(
          'AC 27 scale sent its result without a weight: it locked before the link was up. ' +
            'Wake the scale, wait for the Bluetooth icon on its display, then step on (#458).',
        );
      }
      return null;
    }
    const imp = ac27ImpedanceOhm(raw, kg);
    // The raw value is logged next to the corrected one so a debug log alone
    // shows whether the >= 1500 conversion applied (#386).
    bleLog.debug(
      `AC 27 result: raw=${raw}` +
        (raw >= 1500
          ? ` -> corrected ${imp.toFixed(1)} ohm`
          : ' (below the 1500 correction gate)') +
        `, weight ${kg} kg from the ${source} (#386)`,
    );
    return { weight: kg, impedance: imp };
  }

  /**
   * Clear the previous weigh-in (#394). Adapters are shared singletons, so a
   * lock kept from the last session would pair the next D6 with the previous
   * person's weight, and the `>= 1500` conversion multiplies that weight in.
   */
  onSessionStart(): void {
    this.lockKg = 0;
    this.run = { grams: -1, count: 0, firstAt: 0 };
    this.plateauKg = 0;
    this.balanceSeen = false;
    this.resultSeen = false;
    this.heartSeen = false;
    this.noWeightHinted = false;
  }

  /**
   * Any weight but a streaming one. A reading built by a direct caller is
   * complete and final, like the D6.
   */
  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && !this.live.has(reading);
  }

  isFinal(reading: ScaleReading): boolean {
    return !this.held.has(reading);
  }

  /**
   * Whether the D6 is still owed after the hold window: once the scale locked
   * (every captured lock was followed by a D6: ALPHA 9 of 9, #458 2 of 2, but
   * #458's comes 16 to 18 s later, after its balance phase), or while the
   * balance phase runs. A steady weight that never locked is not owed one:
   * #466 and the ALPHA without a profile send none at all.
   *
   * Also why the plateau may come first: the hold timer does not restart on a
   * later lock, so without this a plateau shortly before the lock (ALPHA
   * capture 2, 00:13:58) would cut off the D6.
   */
  isCompositionPending(): boolean {
    return (
      (this.lockKg > 0 || this.plateauKg > 0) &&
      !this.resultSeen &&
      !this.heartSeen &&
      (this.balanceSeen || this.lockKg > 0)
    );
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
