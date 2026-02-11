import type {
  BleDeviceInfo,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { buildPayload, estimateBodyFat, uuid16 } from './body-comp-helpers.js';

// Yunmai GATT service / characteristic UUIDs
const CHR_MEAS = uuid16(0xffe4); // notify — measurement data
const CHR_CMD = uuid16(0xffe9); // write  — commands

// Response-type markers in data[3]
const RESP_MEASURED = 0x02;

/**
 * Adapter for Yunmai scales (Signal, Mini, SE).
 *
 * Protocol ported from openScale's YunmaiHandler:
 *   - Measurement service 0xFFE0, char 0xFFE4 (notify)
 *   - Command service 0xFFE5, char 0xFFE9 (write)
 *   - Final frame identified by data[3] === 0x02
 *   - Weight at bytes [13-14] big-endian / 100  (kg)
 *   - Resistance at bytes [15-16] big-endian     (Mini/SE only)
 *   - Fat at bytes [17-18] big-endian / 100       (protocol >= 0x1E, Mini/SE only)
 *
 * Body-composition formulas ported from openScale's YunmaiLib.
 */
export class YunmaiScaleAdapter implements ScaleAdapter {
  readonly name = 'Yunmai';
  readonly charNotifyUuid = CHR_MEAS;
  readonly charWriteUuid = CHR_CMD;
  readonly normalizesWeight = true;
  /** GET_PROTOCOL_VERSION — initiates measurement on connect. */
  readonly unlockCommand = [0x0d, 0x05, 0x13, 0x00, 0x16];
  readonly unlockIntervalMs = 5000;

  /** True for Mini (ISM) and SE (ISSE) variants that report resistance. */
  private isMini = false;

  /** Cached fat percentage from protocol >= 0x1E embedded in the frame. */
  private embeddedFatPercent: number | null = null;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (!name.includes('yunmai')) return false;
    this.isMini = name.includes('ism') || name.includes('isse');
    return true;
  }

  /**
   * Parse a Yunmai final-measurement frame.
   *
   * Layout (≥ 18 bytes):
   *   [0]      packet marker / length
   *   [1]      protocol version (for Mini)
   *   [2]      ?
   *   [3]      response type (0x01 = measuring, 0x02 = final)
   *   [4]      ?
   *   [5-8]    Unix timestamp, big-endian uint32
   *   [9-12]   User ID, big-endian uint32
   *   [13-14]  Weight in 0.01 kg, big-endian uint16
   *   [15-16]  Resistance, big-endian uint16  (Mini/SE only)
   *   [17-18]  Fat % × 100, big-endian uint16 (Mini/SE, protocol ≥ 0x1E)
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 15) return null;

    // Only process final (measured) frames
    if (data[3] !== RESP_MEASURED) return null;

    const weightRaw = data.readUInt16BE(13);
    const weight = weightRaw / 100;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    let impedance = 0;
    this.embeddedFatPercent = null;

    if (this.isMini && data.length >= 17) {
      impedance = data.readUInt16BE(15);

      if (data.length >= 19) {
        const protocolVer = data[1];
        if (protocolVer >= 0x1e) {
          this.embeddedFatPercent = data.readUInt16BE(17) / 100;
        }
      }
    }

    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    if (reading.weight <= 0) return false;
    // Mini/SE: wait for impedance data for full body composition
    if (this.isMini) return reading.impedance > 0;
    return true;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const { weight, impedance } = reading;
    const sex = profile.gender === 'male' ? 1 : 0;
    const ym = new YunmaiCalc(sex, profile.height, profile.isAthlete);

    const heightM = profile.height / 100;
    const bmi = weight / (heightM * heightM);

    let fat: number;
    if (this.embeddedFatPercent != null && this.embeddedFatPercent > 0) {
      fat = this.embeddedFatPercent;
    } else if (impedance > 0) {
      fat = ym.fat(profile.age, weight, impedance);
    } else {
      fat = estimateBodyFat(bmi, profile);
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
