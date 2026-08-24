import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  BroadcastSource,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { buildPayload } from './body-comp-helpers.js';
import type { MatchDescriptor } from './match-descriptor.js';

/** Mi vendor history/body-comp characteristic (custom base UUID). */
const CHR_MI_HISTORY = '00002a2f0000351221180009af100700';

const KNOWN_PREFIXES = ['mibcs', 'mibfs', 'mi scale', 'mi_scale'];

/**
 * Body Composition Service UUID in the normalized 32-char no-dash form.
 * Handlers may pass UUIDs in short ('181b'), dashed, or already-normalized form,
 * so we strip dashes and expand short UUIDs before comparing.
 */
const SVC_BODY_COMP = '0000181b00001000800000805f9b34fb';
/** Weight Scale Service UUID used by the XMTZC04HM / MI_SCALE advertisement. */
const SVC_WEIGHT_SCALE = '0000181d00001000800000805f9b34fb';
/** Anhui Huami Information Technology Co., Ltd. Bluetooth company identifier. */
const HUAMI_COMPANY_ID = 0x0157;
const LEGACY_WSS_FRAME_LENGTH = 10;

/**
 * Adapter for the Xiaomi Mi Body Composition Scale 2.
 *
 * Protocol based on openScale's MiScaleHandler. Uses a vendor-specific
 * history characteristic under the Body Composition Service (0x181B).
 *
 * The XMTZC04HM / MI_SCALE variant instead exposes a 10-byte, weight-only
 * advertisement on the Weight Scale Service (0x181D). It is identified by
 * the Huami company identifier so it cannot collide with generic WSS scales.
 *
 * The 13-byte "live frame" carries weight + optional impedance.
 * Body-composition math is ported from openScale's MiScaleLib
 * (originally by prototux / MIBCS reverse-engineering).
 */
export class MiScale2Adapter implements ScaleAdapterCore, GattWiring, Unlockable, BroadcastSource {
  readonly name = 'Xiaomi Mi Scale 2';
  readonly match: MatchDescriptor = {
    priority: 210,
    custom: true,
    names: { startsWith: ['mibcs', 'mibfs', 'mi scale', 'mi_scale'] },
    serviceUuids: ['181b'],
  };
  readonly charNotifyUuid = CHR_MI_HISTORY;
  readonly charWriteUuid = CHR_MI_HISTORY;
  readonly normalizesWeight = true;
  /** ENABLE_HISTORY_MAGIC: triggers the scale to start streaming data. */
  readonly unlockCommand = [0x01, 0x96, 0x8a, 0xbd, 0x62];
  readonly unlockIntervalMs = 3000;
  /**
   * Prefer passive advertisement decoding over GATT.
   * MIBFS (XMTZC05HM) broadcasts the full frame in service data 0x181B, so
   * no connection or unlock is required. Some firmware variants do not stream
   * on the GATT characteristic even when connectable, making passive mode the
   * only reliable path.
   */
  readonly preferPassive = true;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toUpperCase();
    // Beurer SIG scales (BF720/BF105) expose the Body Composition service
    // 0x181B post-connect and would otherwise false-match here. Exclude them
    // by Beurer company id 0x0611 or BF720/BF105 name. (#168)
    if (device.manufacturerData?.id === 0x0611) return false;
    if (name.includes('BF720') || name.includes('BF105')) return false;
    if (KNOWN_PREFIXES.some((p) => name.startsWith(p.toUpperCase()))) return true;

    // Post-discovery: 0x181B is the generic SIG Body Composition Service that
    // standard BCS/WSS scales also expose (e.g. Beurer BF950, #255), so once the
    // characteristics are known require the Mi vendor history characteristic
    // rather than the bare service. This stops Mi (priority 210) from stealing
    // those devices from Standard GATT in the MAC-pinned re-resolution path.
    const chars = device.characteristicUuids;
    if (chars && chars.length > 0) {
      return chars.map((u) => u.toLowerCase()).includes(CHR_MI_HISTORY);
    }

    // XMTZC04HM advertises a 10-byte weight frame on 0x181D and often omits
    // its local name through proxy transports. Do not claim bare 0x181D: it
    // is the standard Weight Scale Service used by many unrelated scales.
    const hasLegacyWssAdvert =
      device.manufacturerData?.id === HUAMI_COMPANY_ID &&
      (device.serviceData ?? []).some(
        (sd) =>
          normalizeServiceUuid(sd.uuid) === SVC_WEIGHT_SCALE &&
          sd.data.length === LEGACY_WSS_FRAME_LENGTH,
      );
    if (hasLegacyWssAdvert) return true;

    // ESPHome / MQTT proxy advertisements may omit the BLE local name. The scale
    // always includes 0x181B as a service-data UUID (AD type 0x16), which lands in
    // serviceData rather than serviceUuids, so check both.
    const hasBcs = (u: string) => u === SVC_BODY_COMP;
    return (
      (device.serviceUuids ?? []).some(hasBcs) ||
      (device.serviceData ?? []).some((sd) => hasBcs(sd.uuid))
    );
  }

  /**
   * Parse a 13-byte Mi Scale v2 live frame.
   *
   * Layout:
   *   [0]     control byte 0: bit 0 = lbs flag
   *   [1]     control byte 1: bit 1 = impedance present, bit 5 = stable, bit 6 = catty, bit 7 = removed
   *   [2-3]   year (uint16 LE)
   *   [4]     month
   *   [5]     day
   *   [6]     hour
   *   [7]     minute
   *   [8]     second (unused here)
   *   [9-10]  impedance (uint16 LE)
   *   [11-12] weight raw (uint16 LE): divide by 200 for kg, 100 for lbs/catty
   */
  private parseFrame(data: Buffer): ScaleReading | null {
    if (data.length !== 13) return null;

    const c0 = data[0];
    const c1 = data[1];
    const isLbs = (c0 & 0x01) !== 0;
    const isCatty = (c1 & 0x40) !== 0;
    const stable = (c1 & 0x20) !== 0;
    const removed = (c1 & 0x80) !== 0;
    const hasImp = (c1 & 0x02) !== 0;

    if (!stable || removed) return null;

    const weightRaw = data.readUInt16LE(11);
    let weight: number;
    if (isLbs) {
      weight = (weightRaw / 100) * 0.453592;
    } else if (isCatty) {
      weight = (weightRaw / 100) * 0.5;
    } else {
      weight = weightRaw / 200;
    }

    let impedance = 0;
    if (hasImp) {
      impedance = data.readUInt16LE(9);
    }

    return { weight, impedance };
  }

  parseNotification(data: Buffer): ScaleReading | null {
    return this.parseFrame(data);
  }

  parseServiceData(uuid: string, data: Buffer): ScaleReading | null {
    const normalized = normalizeServiceUuid(uuid);
    if (normalized === SVC_BODY_COMP) return this.parseFrame(data);
    if (normalized !== SVC_WEIGHT_SCALE || data.length !== LEGACY_WSS_FRAME_LENGTH) return null;

    // XMTZC04HM / MI_SCALE passive frame (service data 0x181D):
    // [0] flags: bit 7 = no current measurement, bit 5 = stable, bits 1/2/4 = kg/lb/jin
    // [1-2] weight raw (uint16 LE): kg and jin use /200, lb uses /100 then lb→kg
    const flags = data[0];
    const hasMeasurement = (flags & 0x80) === 0;
    const stable = (flags & 0x20) !== 0;
    if (!hasMeasurement || !stable) return null;

    const rawWeight = data.readUInt16LE(1);
    if (rawWeight === 0) return null;

    let weight: number;
    if ((flags & 0x02) !== 0) {
      weight = rawWeight / 200;
    } else if ((flags & 0x04) !== 0) {
      weight = (rawWeight / 100) * 0.453592;
    } else if ((flags & 0x10) !== 0) {
      weight = (rawWeight / 100) * 0.5;
    } else {
      return null;
    }

    return { weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 10 && reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const { weight, impedance } = reading;
    // XMTZC04HM provides weight only. Do not feed a synthetic zero impedance
    // into the Mi BIA equations; use the shared profile-based estimate instead.
    if (impedance <= 0) return buildPayload(weight, 0, {}, profile);

    const mi = new MiScaleCalc(profile.gender === 'male' ? 1 : 0, profile.age, profile.height);

    const fat = mi.bodyFat(weight, impedance);
    const water = mi.water(fat);
    const bone = mi.boneMass(weight, impedance);
    const muscle = mi.muscle(weight, impedance);
    const visceralFat = mi.visceralFat(weight);

    return buildPayload(
      weight,
      impedance,
      {
        fat,
        water,
        muscle,
        bone,
        visceralFat,
      },
      profile,
    );
  }
}

function normalizeServiceUuid(uuid: string): string {
  const stripped = uuid.toLowerCase().replace(/[-{}]/g, '');
  if (stripped.length === 4) return `0000${stripped}00001000800000805f9b34fb`;
  if (stripped.length === 8) return `${stripped}00001000800000805f9b34fb`;
  return stripped;
}

// ─── MiScaleLib (ported from openScale / prototux MIBCS reverse-engineering) ─

/**
 * Body-composition calculator for Xiaomi Mi Scale 2.
 *
 * sex: 1 = male, 0 = female
 * height: centimetres
 */
class MiScaleCalc {
  constructor(
    private readonly sex: number,
    private readonly age: number,
    private readonly height: number,
  ) {}

  private lbmCoeff(weight: number, impedance: number): number {
    let lbm = ((this.height * 9.058) / 100) * (this.height / 100);
    lbm += weight * 0.32 + 12.226;
    lbm -= impedance * 0.0068;
    lbm -= this.age * 0.0542;
    return lbm;
  }

  bodyFat(weight: number, impedance: number): number {
    let lbmSub = 0.8;
    if (this.sex === 0 && this.age <= 49) lbmSub = 9.25;
    else if (this.sex === 0 && this.age > 49) lbmSub = 7.25;

    const lc = this.lbmCoeff(weight, impedance);
    let coeff = 1.0;

    if (this.sex === 1 && weight < 61) {
      coeff = 0.98;
    } else if (this.sex === 0 && weight > 60) {
      coeff = 0.96;
      if (this.height > 160) coeff *= 1.03;
    } else if (this.sex === 0 && weight < 50) {
      coeff = 1.02;
      if (this.height > 160) coeff *= 1.03;
    }

    let bf = (1 - ((lc - lbmSub) * coeff) / weight) * 100;
    if (bf > 63) bf = 75;
    return bf;
  }

  water(bodyFatPercent: number): number {
    const raw = (100 - bodyFatPercent) * 0.7;
    const coeff = raw < 50 ? 1.02 : 0.98;
    return coeff * raw;
  }

  boneMass(weight: number, impedance: number): number {
    const base = this.sex === 0 ? 0.245691014 : 0.18016894;
    let bone = (base - this.lbmCoeff(weight, impedance) * 0.05158) * -1;
    bone = bone > 2.2 ? bone + 0.1 : bone - 0.1;

    if (this.sex === 0 && bone > 5.1) bone = 8;
    else if (this.sex === 1 && bone > 5.2) bone = 8;

    return bone;
  }

  /**
   * Skeletal-muscle percentage via Janssen et al. BIA equation.
   * Falls back to LBM ratio if impedance is non-positive.
   */
  muscle(weight: number, impedance: number): number {
    if (weight <= 0) return 0;

    let smmKg: number;
    if (impedance > 0) {
      const h2r = (this.height * this.height) / impedance;
      smmKg = 0.401 * h2r + 3.825 * this.sex - 0.071 * this.age + 5.102;
    } else {
      const bf = this.bodyFat(weight, impedance);
      const lbm = weight - (bf / 100) * weight - this.boneMass(weight, impedance);
      const ratio = this.sex === 1 ? 0.52 : 0.46;
      smmKg = lbm * ratio;
    }

    const pct = (smmKg / weight) * 100;
    return Math.max(10, Math.min(pct, 60));
  }

  visceralFat(weight: number): number {
    let vf = 0;

    if (this.sex === 0) {
      if (weight > (13 - this.height * 0.5) * -1) {
        const sub = this.height * 1.45 + this.height * 0.1158 * this.height - 120;
        vf = (weight * 500) / sub - 6 + this.age * 0.07;
      } else {
        const sub = 0.691 + this.height * -0.0024 + this.height * -0.0024;
        vf = (this.height * 0.027 - sub * weight) * -1 + this.age * 0.07 - this.age;
      }
    } else {
      if (this.height < weight * 1.6) {
        const sub = (this.height * 0.4 - this.height * (this.height * 0.0826)) * -1;
        vf = (weight * 305) / (sub + 48) - 2.9 + this.age * 0.15;
      } else {
        const sub = 0.765 + this.height * -0.0015;
        vf = (this.height * 0.143 - weight * sub) * -1 + this.age * 0.15 - 5;
      }
    }

    return vf;
  }
}
