import type {
  AckProtocol,
  AdapterRuntimeConfig,
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  Gender,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import type { ScaleDisplayUnit } from '../config/schema.js';
import {
  uuid16,
  buildPayload,
  isPlausibleImpedance,
  ReadingComposition,
  WEIGHT_ONLY_HOLD_MS,
} from './body-comp-helpers.js';
import { wla07 } from './wla07.js';
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

/**
 * `[17]` values whose body composition is the vendor's WLA07 formula. 0x07 is
 * #458's unit, whose display it reproduces (fat 26.9 %, water 52.8 %, bone
 * 2.9 kg); 0x24 is the ALPHA, where it reproduces FitDays (fat 43.0 %, water
 * 44.0 %, bone 3.9 kg). The 0x02 (#466) and 0x03 (#462) units have no vendor
 * value to compare with yet, so they keep the BMI estimate.
 */
const WLA07_ALGORITHMS = new Set([0x07, 0x24]);

/** `[19]` of a frame the phone writes: `sum([2..18]) & 0xFF` (the scale uses 5 bits). */
function withPhoneChecksum(f: Buffer): Buffer {
  let sum = 0;
  for (let i = 2; i <= 18; i++) sum += f[i];
  f[19] = sum & 0xff;
  return f;
}

/** D0 `[7]` per openScale's ActiveEraBF06Handler: 0 kg, 1 lb, 2 st. */
const DISPLAY_UNIT_BYTE: Record<ScaleDisplayUnit, number> = { kg: 0, lbs: 1, st: 2 };

/**
 * The height in whole centimetres, as the D0 frame carries it and as WLA07 is
 * fed. Both must agree: the scale computes what it displays from the D0 height,
 * and a height configured in inches is fractional in cm (70 in = 177.8 cm).
 * Rounding one and truncating the other put the exported body fat a few tenths
 * of a percent off the display (0.4 % per centimetre at 88 kg).
 */
function wholeCm(heightCm: number): number {
  return Math.min(0xff, Math.max(0, Math.round(heightCm)));
}

/**
 * The D0 profile frame FitDays writes after subscribing (openScale PR #1534
 * captures): `AC 27 <unix time u32 BE> 08 <unit> <slot 00> <height cm>
 * 00 00 <age> <sex 1/2> 00 00 03 00 D0 <checksum>`.
 *
 * Every byte but `[7]` is as captured; the two `00 00` pairs are weights the
 * app leaves at 0 for its main user. `[7]` is 00 in the captures, which were
 * made on kg, and openScale's ALPHA handler always sends 00. Its BS-06 handler
 * puts the display unit there, in a config frame with the same field layout,
 * so a hard 00 would likely switch a scale set to lb back to kg on every
 * connect. That `[7]` is the unit on the FitDays frame is not yet confirmed.
 */
export function buildAc27Profile(
  unixSec: number,
  heightCm: number,
  age: number,
  gender: Gender,
  unit: ScaleDisplayUnit = 'kg',
): Buffer {
  const f = Buffer.alloc(FRAME_LEN);
  f[0] = 0xac;
  f[1] = 0x27;
  f.writeUInt32BE(unixSec >>> 0, 2);
  f[6] = 0x08;
  f[7] = DISPLAY_UNIT_BYTE[unit];
  f[8] = 0x00;
  f[9] = wholeCm(heightCm);
  f[12] = Math.min(0xff, Math.max(0, Math.trunc(age)));
  f[13] = gender === 'male' ? 0x01 : 0x02;
  f[16] = 0x03;
  f[18] = TYPE_BALANCE;
  return withPhoneChecksum(f);
}

/** `AC 27 01 00.. DF E0`: written once between the two D0 frames, meaning unknown. */
export const AC27_DF01 = Buffer.from('ac2701' + '00'.repeat(15) + 'dfe0', 'hex');

/** FitDays' acknowledgement of a D6: `AC 27 04 D6 00.. DF B9`. */
const AC27_ACK_D6 = Buffer.from('ac2704d6' + '00'.repeat(14) + 'dfb9', 'hex');

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

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class ActiveEraSession {
  /** Kilograms of this session's last locked D5 frame, 0 when none. */
  lockKg = 0;
  /** The current run of identical unlocked D5 weights. */
  run = { grams: -1, count: 0, firstAt: 0 };
  /**
   * Heaviest steady weight of a session that never locked, 0 when none. The
   * heaviest, not the latest: a partial weight on the way off the scale would
   * otherwise replace the right one.
   */
  plateauKg = 0;
  balanceSeen = false;
  resultSeen = false;
  heartSeen = false;
  /** Whether the "D6 without a weight" hint was already logged this session. */
  noWeightHinted = false;
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
 * steady one. Evidence: the frames in #458, #462 and #466 and the two FitDays
 * captures attached to openScale PR #1534.
 *
 * Handshake (FitDays, openScale PR #1534): after subscribing, the D0 profile,
 * `DF 01`, the D0 profile again, as Write Requests; a D6 is acknowledged. The
 * same ALPHA locks and sends D6 in every captured session with the profile and
 * in none without it (#466 and openScale #1358 look the same).
 *
 * Completion: a locked D5, or a weight that holds still without ever locking
 * (`PLATEAU_MIN_FRAMES`), completes the weigh-in and holds the link for the D6
 * (`WEIGHT_ONLY_HOLD_MS`, extended while a locked or balancing weigh-in still
 * owes one); the D6 is final. A scale that never sends D6 still exports its
 * weight, which used to time out with nothing (#466, D028).
 */
export class ActiveEraAdapter
  implements ScaleAdapterCore, GattWiring, HoldForComposition, AckProtocol
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
  /**
   * Declared so the handler subscribes BEFORE `onConnected` writes the
   * profile, the order FitDays uses (CCCD, then D0).
   */
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: uuid16(0xffb1), type: 'write' },
    { uuid: uuid16(0xffb2), type: 'notify' },
  ];
  /** FFB1 is Write only (properties 0x08 in the ALPHA capture), so with response. */
  readonly ackWithResponse = true;

  /** `scale.display_unit`, echoed in D0 `[7]` so a connect does not flip the display. */
  private displayUnit: ScaleDisplayUnit = 'kg';

  readonly completionHoldMs = WEIGHT_ONLY_HOLD_MS;

  private s = new ActiveEraSession();
  /** Streaming weights, shown live but never a weigh-in. */
  private live = new WeakSet<ScaleReading>();
  /** Locked or steady weights: complete, but the D6 may still follow. */
  private held = new WeakSet<ScaleReading>();
  /**
   * The D6 `[17]` byte (body composition algorithm), pinned to the reading it
   * came with, not kept as live state (#394).
   */
  private readonly algorithm = new ReadingComposition<number | undefined>();

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

  configure(opts: AdapterRuntimeConfig): void {
    if (opts.displayUnit) this.displayUnit = opts.displayUnit;
  }

  /**
   * D0 profile, `DF 01`, D0 profile, from the configured user. A write the
   * scale refuses is logged and skipped rather than failing the session: the
   * weight still completes on its own (plateau), as it did before.
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    const { profile } = ctx;
    const d0 = buildAc27Profile(
      Math.floor(Date.now() / 1000),
      profile.height,
      profile.age,
      profile.gender,
      this.displayUnit,
    );
    for (const frame of [d0, AC27_DF01, d0]) {
      try {
        await ctx.write(this.charWriteUuid, frame, true);
      } catch (e: unknown) {
        bleLog.warn(
          `AC 27 profile write refused (${e instanceof Error ? e.message : String(e)}); ` +
            'continuing without it, the scale may not lock or send its impedance.',
        );
        return;
      }
    }
  }

  /** ACK the D6 the way FitDays does. A D8 is not acknowledged (see parseNotification). */
  buildAck(data: Buffer): Buffer | null {
    return isAc27Frame(data) && data[18] === TYPE_RESULT ? AC27_ACK_D6 : null;
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
        this.s.balanceSeen = true;
        bleLog.debug(
          `AC 27 balance: left foot ${(data.readUInt16BE(3) / 100).toFixed(2)} kg` +
            (data[2] === 0x01 ? ' (final)' : ''),
        );
        return null;
      case TYPE_HEART_RATE:
        this.s.heartSeen = true;
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
      this.s.run = { grams: -1, count: 0, firstAt: 0 };
      return null;
    }
    const kg = grams / 1000;
    if (d[2] & FLAG_LOCKED) {
      this.s.lockKg = kg;
      return this.mark(this.held, { weight: kg, impedance: 0 });
    }
    const now = Date.now();
    if (grams === this.s.run.grams) this.s.run.count += 1;
    else this.s.run = { grams, count: 1, firstAt: now };
    if (
      this.s.lockKg === 0 &&
      this.s.run.count >= PLATEAU_MIN_FRAMES &&
      now - this.s.run.firstAt >= PLATEAU_MIN_MS
    ) {
      if (kg > this.s.plateauKg) {
        this.s.plateauKg = kg;
        bleLog.debug(
          `AC 27 weight steady at ${kg} kg for ${this.s.run.count} frames, no lock flag (#466)`,
        );
      }
      return this.mark(this.held, { weight: this.s.plateauKg, impedance: 0 });
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
    this.s.resultSeen = true;
    const own = d[7] & FLAG_LOCKED ? weightGrams(d, 8) / 1000 : 0;
    const kg = own || this.s.lockKg || this.s.plateauKg;
    const source = own ? 'D6' : this.s.lockKg ? 'lock' : 'steady weight';
    const raw = d.readUInt16BE(4);
    if (kg <= 0) {
      if (!this.s.noWeightHinted) {
        this.s.noWeightHinted = true;
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
    const reading: ScaleReading = { weight: kg, impedance: imp };
    this.algorithm.pin(reading, d[17]);
    return reading;
  }

  onSessionStart(): void {
    this.s = new ActiveEraSession();
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
      (this.s.lockKg > 0 || this.s.plateauKg > 0) &&
      !this.s.resultSeen &&
      !this.s.heartSeen &&
      (this.s.balanceSeen || this.s.lockKg > 0)
    );
  }

  /**
   * The vendor's WLA07 formula for a unit that names it in `[17]`, the BMI
   * estimate otherwise, the shared BIA never: on #458 it lands at 31.6 % body
   * fat against the display's 26.9 %, further off than the estimate's 29.4 %.
   * WLA07 needs a usable impedance; the processor has already set one outside
   * the plausible band to 0 (D028), and 0 falls back to the estimate.
   */
  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const alg = this.algorithm.of(reading, undefined);
    if (alg !== undefined && WLA07_ALGORITHMS.has(alg) && isPlausibleImpedance(reading.impedance)) {
      const c = wla07({
        weightKg: reading.weight,
        heightCm: wholeCm(profile.height),
        impedanceOhm: reading.impedance,
        age: profile.age,
        isMale: profile.gender === 'male',
      });
      return buildPayload(
        reading.weight,
        reading.impedance,
        { fat: c.fat, water: c.water, bone: c.bone, muscle: c.muscle },
        profile,
      );
    }
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
