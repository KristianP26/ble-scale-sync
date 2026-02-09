import type { Peripheral } from '@abandonware/noble';
import type {
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { buildPayload } from './body-comp-helpers.js';

// Sanitas SBF72/73 / Beurer BF915 custom service + characteristic UUIDs (full 128-bit)
const SVC_FFFF = '0000ffff00001000800000805f9b34fb';
const CHR_USER_LIST = '0000000100001000800000805f9b34fb';
const CHR_TAKE_MEAS = '0000000600001000800000805f9b34fb';

// Standard BCS characteristic for body composition measurement (inherited from StandardWeightProfileHandler)
const CHR_BODY_COMP_MEAS = '00002a9c00001000800000805f9b34fb';
const CHR_USER_CONTROL_POINT = '00002a9f00001000800000805f9b34fb';

const KNOWN_NAMES = ['sbf72', 'sbf73', 'bf915'];

interface CachedGattData {
  bodyFatPercent: number;
  musclePct?: number;
  waterMassKg?: number;
}

/**
 * Adapter for Sanitas SBF72 / SBF73 and Beurer BF915 scales.
 *
 * Protocol ported from openScale's SanitasSbf72Handler which extends
 * StandardWeightProfileHandler — uses standard BCS (0x181B) measurement
 * characteristic for body composition data, plus a custom service (0xFFFF)
 * for user management.
 *
 * Subscribes to Body Composition Measurement (0x2A9C) for weight/fat data.
 * Unlock sends user list request to trigger connection handshake.
 */
export class SanitasSbf72Adapter implements ScaleAdapter {
  readonly name = 'Sanitas SBF72/73';
  readonly charNotifyUuid = CHR_BODY_COMP_MEAS;
  readonly charWriteUuid = CHR_USER_CONTROL_POINT;
  /** UCP Consent opcode for user index 1 with consent code 0. */
  readonly unlockCommand = [0x02, 0x01, 0x00, 0x00];
  readonly unlockIntervalMs = 5000;

  private cachedGatt: CachedGattData | null = null;

  matches(peripheral: Peripheral): boolean {
    const name = (peripheral.advertisement.localName || '').toLowerCase();
    return KNOWN_NAMES.some((n) => name.includes(n));
  }

  /**
   * Parse a BT SIG Body Composition Measurement (0x2A9C) notification.
   *
   * Same format as StandardGattScaleAdapter — standard BCS flags with
   * body fat, optional fields (timestamp, user, BMR, muscle %, muscle mass,
   * fat-free mass, soft lean, water mass, impedance, weight, height).
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 4) return null;

    let offset = 0;
    const flags = data.readUInt16LE(offset); offset += 2;

    const isKg = (flags & 0x0001) === 0;
    const tsPresent = (flags & 0x0002) !== 0;
    const userPresent = (flags & 0x0004) !== 0;
    const bmrPresent = (flags & 0x0008) !== 0;
    const musclePctPresent = (flags & 0x0010) !== 0;
    const muscleMassPresent = (flags & 0x0020) !== 0;
    const fatFreeMassPresent = (flags & 0x0040) !== 0;
    const softLeanPresent = (flags & 0x0080) !== 0;
    const waterMassPresent = (flags & 0x0100) !== 0;
    const impedancePresent = (flags & 0x0200) !== 0;
    const weightPresent = (flags & 0x0400) !== 0;
    const heightPresent = (flags & 0x0800) !== 0;

    const massMultiplier = isKg ? 0.005 : 0.01;

    // Body Fat Percentage — mandatory field
    if (offset + 2 > data.length) return null;
    const bodyFatPct = data.readUInt16LE(offset) * 0.1; offset += 2;

    if (tsPresent) offset += 7;
    if (userPresent) offset += 1;
    if (bmrPresent) offset += 2;

    let musclePct: number | undefined;
    if (musclePctPresent && offset + 2 <= data.length) {
      musclePct = data.readUInt16LE(offset) * 0.1; offset += 2;
    }

    if (muscleMassPresent && offset + 2 <= data.length) offset += 2;
    if (fatFreeMassPresent && offset + 2 <= data.length) offset += 2;
    if (softLeanPresent && offset + 2 <= data.length) offset += 2;

    let waterMassKg: number | undefined;
    if (waterMassPresent && offset + 2 <= data.length) {
      const raw = data.readUInt16LE(offset) * massMultiplier; offset += 2;
      waterMassKg = isKg ? raw : raw * 0.453592;
    }

    let impedance = 0;
    if (impedancePresent && offset + 2 <= data.length) {
      impedance = data.readUInt16LE(offset) * 0.1; offset += 2;
    }

    let weight = 0;
    if (weightPresent && offset + 2 <= data.length) {
      const rawW = data.readUInt16LE(offset) * massMultiplier; offset += 2;
      weight = isKg ? rawW : rawW * 0.453592;
    }

    if (heightPresent && offset + 2 <= data.length) offset += 2;

    this.cachedGatt = { bodyFatPercent: bodyFatPct, musclePct, waterMassKg };
    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    const gatt = this.cachedGatt;
    const waterPercent = gatt?.waterMassKg && reading.weight > 0
      ? (gatt.waterMassKg / reading.weight) * 100
      : undefined;

    return buildPayload(reading.weight, reading.impedance, {
      fat: gatt?.bodyFatPercent && gatt.bodyFatPercent > 0 ? gatt.bodyFatPercent : undefined,
      water: waterPercent,
      muscle: gatt?.musclePct,
    }, profile);
  }
}
