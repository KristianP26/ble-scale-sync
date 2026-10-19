import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  HoldForComposition,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import {
  buildPayload,
  compositionRejection,
  estimateBodyFat,
  uuid16,
  ReadingComposition,
} from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog } from '../ble/types.js';

// Yunmai GATT service / characteristic UUIDs
const CHR_MEAS = uuid16(0xffe4); // notify — measurement data
const CHR_CMD = uuid16(0xffe9); // write  — commands

// Response-type markers in data[3]
const RESP_MEASURED = 0x02;

// [2] is the frame's total length, start byte and XOR included (openScale's
// YunmaiHandler and the protocol notes it cites say so). 18 bytes carry weight
// and resistance (protocol 0x13), 20 add the body fat the scale computed (0x1E
// and later). Every Yunmai final frame on record (11 frames, 6 sources) keeps
// [2] equal to its length; the SE is reported to send the same layout with
// both fields zero (openScale #71).
const LEN_WITH_RESISTANCE = 18;
const LEN_WITH_FAT = 20;
const PROTO_WITH_FAT = 0x1e;
const COMPOSITION_HOLD_MS = 4000;

/**
 * Adapter for Yunmai scales (Signal, Mini, Mini 2, SE).
 *
 * Protocol ported from openScale's YunmaiHandler:
 *   - Measurement service 0xFFE0, char 0xFFE4 (notify)
 *   - Command service 0xFFE5, char 0xFFE9 (write)
 *   - Final frame identified by data[3] === 0x02
 *   - Weight at bytes [13-14] big-endian / 100  (kg)
 *   - Resistance at bytes [15-16] big-endian     (frames of 18+ bytes)
 *   - Fat at bytes [17-18] big-endian / 100      (20-byte frames, protocol >= 0x1E)
 *
 * Which fields a frame carries is read from the frame, not from the advertised
 * name (#474, ADR D061). openScale counts SIGNAL, ISM, ISC2P and Scale-3 as
 * Minis that send the resistance, and a forced or nameless unit has no name
 * to go by at all.
 *
 * Body-composition formulas ported from openScale's YunmaiLib.
 */
export class YunmaiScaleAdapter
  implements ScaleAdapterCore, GattWiring, Unlockable, HoldForComposition
{
  readonly name = 'Yunmai';
  readonly match: MatchDescriptor = {
    priority: 190,
    names: { includes: ['yunmai'] },
  };
  readonly charNotifyUuid = CHR_MEAS;
  readonly charWriteUuid = CHR_CMD;
  readonly normalizesWeight = true;
  /** GET_PROTOCOL_VERSION — initiates measurement on connect. */
  readonly unlockCommand = [0x0d, 0x05, 0x13, 0x00, 0x16];
  readonly unlockIntervalMs = 5000;

  /**
   * Whether the frame parsed last has a resistance field. Per frame, not per
   * device: the session reads `completionHoldMs` when the hold arms, right
   * after the parse of the frame that armed it.
   */
  private frameHasResistance = false;

  /** Cached fat percentage from protocol >= 0x1E embedded in the frame. */
  private embeddedFatPercent: number | null = null;
  /**
   * The embedded fat percentage as it stood when each reading was emitted
   * (#394): this adapter is a shared singleton and `computeMetrics()` runs
   * later than the parse, so on the watcher transports the live field can
   * already belong to the next weigh-in. See ReadingComposition.
   */
  private readonly comp = new ReadingComposition<number | null>();

  matches(device: BleDeviceInfo): boolean {
    // The name only claims the device; what the frame carries is read from the
    // frame. openScale reads the resistance for SIGNAL as well as ISM, and a
    // forced or nameless unit has no name to go by (#474).
    return matchesDescriptor(device, this.match);
  }

  /**
   * Parse a Yunmai final-measurement frame.
   *
   * Layout (18 or 20 bytes):
   *   [0]      0x0D start byte
   *   [1]      protocol version (0x13 and 0x1F seen; openScale and the
   *            protocol notes also name 0x1E)
   *   [2]      total frame length, [0] and the XOR included
   *   [3]      response type (0x01 = measuring, 0x02 = final)
   *   [4]      0x00 on every frame seen ("historical info" in the notes; not read)
   *   [5-8]    scale clock, big-endian uint32 (often never set; not read)
   *   [9-12]   user the scale recognised, big-endian uint32 (0 = nobody)
   *   [13-14]  Weight in 0.01 kg, big-endian uint16
   *   [15-16]  Resistance, big-endian uint16       (18+ bytes)
   *   [17-18]  Fat % x 100, big-endian uint16      (20 bytes, protocol >= 0x1E)
   *   [n-1]    XOR of [1..n-2]
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 15) return null;

    // Only process final (measured) frames
    if (data[3] !== RESP_MEASURED) return null;

    const weightRaw = data.readUInt16BE(13);
    const weight = weightRaw / 100;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    // A buffer whose [2] disagrees with its length is not a frame anyone has
    // seen, so its trailing bytes are not trusted as fields.
    const declared = data[2] === data.length;
    this.frameHasResistance = declared && data.length >= LEN_WITH_RESISTANCE;
    const impedance = this.frameHasResistance ? data.readUInt16BE(15) : 0;
    this.embeddedFatPercent =
      declared && data.length >= LEN_WITH_FAT && data[1] >= PROTO_WITH_FAT
        ? data.readUInt16BE(17) / 100
        : null;
    if (!this.frameHasResistance) {
      bleLog.debug(
        `Yunmai: ${data.length}-byte final frame declares ${data[2]}; no resistance field`,
      );
    }

    const reading: ScaleReading = { weight, impedance };
    this.comp.pin(reading, this.embeddedFatPercent);
    return reading;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  /**
   * A frame with a resistance field carries the impedance in the same final
   * frame as the weight, so a complete reading either already has it or never
   * will. Hold the link briefly after a final frame whose field is 0 to prefer
   * one that carries it, then resolve weight-only rather than hanging until the
   * overall read timeout. Some SE units (e.g. YUNMAI-ISSE) have no working
   * bioimpedance sensor and stream weight forever with impedance 0 (#257). A
   * frame without the field sets no hold and resolves immediately.
   */
  get completionHoldMs(): number | undefined {
    return this.frameHasResistance ? COMPOSITION_HOLD_MS : undefined;
  }

  /**
   * A reading carrying impedance is the rich/final one, so resolve without waiting
   * out the hold window. Only consulted while completionHoldMs is set.
   */
  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }

  /** Clear the previous weigh-in (#394). */
  onSessionStart(): void {
    this.embeddedFatPercent = null;
    this.frameHasResistance = false;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const { weight, impedance } = reading;
    const sex = profile.gender === 'male' ? 1 : 0;
    const ym = new YunmaiCalc(sex, profile.height, profile.isAthlete);

    const heightM = profile.height / 100;
    const bmi = weight / (heightM * heightM);

    const embeddedFat = this.comp.of(reading, this.embeddedFatPercent);

    // The first usable fat value wins, and every other field below is derived
    // from THAT one (ADR D028, review D-08). `ym.fat()` returns 0 for a result
    // outside 5-75 %, which a real impedance reaches at a BMI around 50 and
    // above; water, muscle, bone and visceral fat used to be derived from that
    // 0 and exported next to a fat value from somewhere else (60 % fat with a
    // visceral rating of 1). On 0 the fat is the BMI estimate, not generic BIA:
    // no Yunmai frame on record shows the resistance is in ohms (YunmaiLib uses
    // it as `(R - 100) / 100`), and the SIGNAL values (105-221) pass the
    // 150-1200 gate while BIA on them lands far from the estimate (33 % against
    // 60 % at BMI 55, the 4 % floor at a normal BMI).
    const usable = (f: number | null | undefined): f is number =>
      f != null && compositionRejection({ fat: f }) === null;
    let fat: number;
    if (usable(embeddedFat)) {
      fat = embeddedFat;
    } else {
      const yunmaiFat = impedance > 0 ? ym.fat(profile.age, weight, impedance) : 0;
      fat = usable(yunmaiFat) ? yunmaiFat : estimateBodyFat(bmi, profile);
    }

    const musclePct = ym.muscle(fat);
    const water = ym.water(fat);
    const bone = ym.boneMass(musclePct, weight);
    const visceralFat = ym.visceralFat(fat, profile.age);

    return buildPayload(
      weight,
      impedance,
      {
        fat,
        water,
        muscle: musclePct,
        bone,
        visceralFat,
      },
      profile,
    );
  }
}

// ─── YunmaiLib (ported from openScale) ──────────────────────────────────────

/**
 * Body-composition calculator for Yunmai scales.
 *
 * sex: 1 = male, 0 = female
 * height: centimetres
 * fitnessBody: true if activity level is HEAVY or EXTREME
 */
class YunmaiCalc {
  private readonly fitnessBody: boolean;

  constructor(
    private readonly sex: number,
    private readonly height: number,
    fitnessBody: boolean,
  ) {
    this.fitnessBody = fitnessBody;
  }

  water(bodyFat: number): number {
    return ((100 - bodyFat) * 0.726 * 100 + 0.5) / 100;
  }

  fat(age: number, weight: number, resistance: number): number {
    let r = (resistance - 100) / 100;
    const h = this.height / 100;

    if (r >= 1) r = Math.sqrt(r);

    let f = (weight * 1.5) / h / h + age * 0.08;
    if (this.sex === 1) f -= 10.8;
    f = f - 7.4 + r;

    if (f < 5 || f > 75) f = 0;
    return f;
  }

  muscle(bodyFat: number): number {
    let m = (100 - bodyFat) * (this.fitnessBody ? 0.7 : 0.67);
    m = (m * 100 + 0.5) / 100;
    return m;
  }

  boneMass(musclePct: number, weight: number): number {
    const h = this.height - 170;
    let bone: number;

    if (this.sex === 1) {
      bone = ((weight * (musclePct / 100) * 4) / 7) * 0.22 * 0.6 + h / 100;
    } else {
      bone = ((weight * (musclePct / 100) * 4) / 7) * 0.34 * 0.45 + h / 100;
    }

    bone = (bone * 10 + 0.5) / 10;
    return bone;
  }

  leanBodyMass(weight: number, bodyFat: number): number {
    return (weight * (100 - bodyFat)) / 100;
  }

  visceralFat(bodyFat: number, age: number): number {
    let f = bodyFat;
    const a = age < 18 || age > 120 ? 18 : age;

    if (!this.fitnessBody) {
      if (this.sex === 1) {
        if (a < 40) f -= 21;
        else if (a < 60) f -= 22;
        else f -= 24;
      } else {
        if (a < 40) f -= 34;
        else if (a < 60) f -= 35;
        else f -= 36;
      }

      let d = this.sex === 1 ? 1.4 : 1.8;
      if (f > 0) d = 1.1;

      const vf = f / d + 9.5;
      return Math.max(1, Math.min(vf, 30));
    }

    // Fitness body type
    let vf: number;
    if (bodyFat > 15) {
      vf = (bodyFat - 15) / 1.1 + 12;
    } else {
      vf = (-1 * (15 - bodyFat)) / 1.4 + 12;
    }
    return Math.max(1, Math.min(vf, 9));
  }
}
