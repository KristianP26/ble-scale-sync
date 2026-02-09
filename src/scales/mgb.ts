import type { Peripheral } from '@abandonware/noble';
import type {
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';

/**
 * Adapter for MGB-protocol scales (Swan, Icomon, YG brands).
 *
 * Protocol: service 0xFFB0, notify 0xFFB2, write 0xFFB1.
 * Unlock via magic init packet with checksum.
 *
 * Two-frame 20-byte protocol:
 *   Frame1 header [0xAC, 0x02|0x03, 0xFF]:
 *     weight at [9-10] BE /10 (kg), fat at [13-14] BE /10.
 *   Frame2 header [0x01, 0x00]:
 *     muscle at [2-3] LE /10, bone at [6-7] LE /10, water at [8-9] LE /10.
 *
 * Values are cached across frames until a complete reading is available.
 */
export class MgbAdapter implements ScaleAdapter {
  readonly name = 'MGB (Swan/Icomon/YG)';
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);
  /** Magic init: [0xAC, 0x02, 0xF7, 0x00, 0x00, 0x00, 0xCC, checksum]. */
  readonly unlockCommand = (() => {
    const checksum = (0xf7 + 0x00 + 0x00 + 0x00 + 0xcc) & 0xff;
    return [0xac, 0x02, 0xf7, 0x00, 0x00, 0x00, 0xcc, checksum];
  })();
  readonly unlockIntervalMs = 5000;

  private cachedWeight = 0;
  private cachedFat = 0;
  private cachedMuscle = 0;
  private cachedBone = 0;
  private cachedWater = 0;

  matches(peripheral: Peripheral): boolean {
    const name = (peripheral.advertisement.localName || '').toLowerCase();

    if (name.startsWith('swan')) return true;
    if (name === 'icomon') return true;
    if (name === 'yg') return true;

    const uuids = (peripheral.advertisement.serviceUuids || []).map((u) => u.toLowerCase());
    return uuids.some((u) => u === 'ffb0' || u === uuid16(0xffb0));
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 10) return null;

    // Frame1: header [0xAC, 0x02|0x03, 0xFF]
    if (data[0] === 0xac && (data[1] === 0x02 || data[1] === 0x03) && data[2] === 0xff) {
      if (data.length >= 15) {
        this.cachedWeight = ((data[9] << 8) | data[10]) / 10;
        this.cachedFat = ((data[13] << 8) | data[14]) / 10;
      }
    }

    // Frame2: header [0x01, 0x00]
    if (data[0] === 0x01 && data[1] === 0x00) {
      if (data.length >= 10) {
        this.cachedMuscle = data.readUInt16LE(2) / 10;
        this.cachedBone = data.readUInt16LE(6) / 10;
        this.cachedWater = data.readUInt16LE(8) / 10;
      }
    }

    if (this.cachedWeight <= 0) return null;

    return { weight: this.cachedWeight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.cachedFat > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    const comp: ScaleBodyComp = {
      fat: this.cachedFat > 0 ? this.cachedFat : undefined,
      water: this.cachedWater > 0 ? this.cachedWater : undefined,
      muscle: this.cachedMuscle > 0 ? this.cachedMuscle : undefined,
      bone: this.cachedBone > 0 ? this.cachedBone : undefined,
    };
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
