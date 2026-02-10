import type {
  BleDeviceInfo,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';

/**
 * Adapter for Active Era BS-06 body-fat scales.
 *
 * Protocol: service 0xFFB0, notify 0xFFB2, write 0xFFB1.
 * Unlock via a 20-byte config packet starting with [0xAC, 0x27, ...].
 *
 * 20-byte measurement frames with magic 0xAC at byte[0].
 * Frame type at byte[18]:
 *   0xD5 = weight: bytes [3-5] 24-bit BE, mask 0x3FFFF, /1000 (kg).
 *          Stability flag at byte[2].
 *   0xD6 = impedance: bytes [4-5] BE uint16.
 *          If impedance >= 1500, correction formula is applied.
 *
 * Weight and impedance are cached across frames.
 */
export class ActiveEraAdapter implements ScaleAdapter {
  readonly name = 'Active Era BS-06';
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);
  readonly normalizesWeight = true;
  /** 20-byte config packet — simplified with zeros for timestamp/user data. */
  readonly unlockCommand = [
    0xac, 0x27, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  readonly unlockIntervalMs = 0;

  private cachedWeight = 0;
  private cachedImpedance = 0;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    return name.includes('ae bs-06');
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 20 || data[0] !== 0xac) return null;

    const frameType = data[18];

    if (frameType === 0xd5) {
      // Weight frame: 24-bit BE at [3-5], mask lower 18 bits
      const raw24 = (data[3] << 16) | (data[4] << 8) | data[5];
      this.cachedWeight = (raw24 & 0x3ffff) / 1000;
    } else if (frameType === 0xd6) {
      // Impedance frame: BE uint16 at [4-5]
      let imp = (data[4] << 8) | data[5];

      // Impedance correction for high values
      if (imp >= 1500) {
        imp = (imp - 1000 + this.cachedWeight * 10 * -0.4) / 0.6 / 10;
      }

      this.cachedImpedance = imp;
    }

    if (this.cachedWeight <= 0) return null;

    return { weight: this.cachedWeight, impedance: this.cachedImpedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
