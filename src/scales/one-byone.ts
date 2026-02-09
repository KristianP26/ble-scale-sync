import type { Peripheral } from '@abandonware/noble';
import type {
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';

// ─── OneByoneAdapter (Eufy C1/P1, Health Scale) ─────────────────────────────

const ONEBYONE_NAMES = ['t9146', 't9147', 'health scale'];

/**
 * Adapter for Eufy C1/P1 and "Health Scale" branded 1byone devices.
 *
 * Protocol: service 0xFFF0, notify 0xFFF4, write 0xFFF1.
 * Unlock via clock-sync frame: [0xF1, yearHi, yearLo, month, day, hour, min, sec].
 * Measurement frames begin with 0xCF header.
 *   Weight at bytes [3-4] little-endian uint16 / 100 (kg).
 *   Impedance: ((data[2]<<8)+data[1]) * 0.1, valid when byte[9] != 1 and != 0.
 */
export class OneByoneAdapter implements ScaleAdapter {
  readonly name = '1byone (Eufy)';
  readonly charNotifyUuid = uuid16(0xfff4);
  readonly charWriteUuid = uuid16(0xfff1);
  /** Clock sync command — static default for 2026-02-09 00:00:00. */
  readonly unlockCommand = [0xf1, 0x07, 0xfa, 0x02, 0x09, 0x00, 0x00, 0x00];
  readonly unlockIntervalMs = 0;

  matches(peripheral: Peripheral): boolean {
    const name = (peripheral.advertisement.localName || '').toLowerCase();
    return ONEBYONE_NAMES.some((n) => name.includes(n));
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 5 || data[0] !== 0xcf) return null;

    const weight = data.readUInt16LE(3) / 100;

    let impedance = 0;
    if (data.length >= 10) {
      const rawImp = ((data[2] << 8) + data[1]) * 0.1;
      const impedanceInvalid = data[9] === 1 || rawImp === 0;
      if (!impedanceInvalid) {
        impedance = rawImp;
      }
    }

    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}

// ─── OneByoneNewAdapter (1byone scale — newer protocol) ─────────────────────

/**
 * Adapter for the newer "1byone scale" branded device.
 *
 * Protocol: service 0xFFB0, notify 0xFFB2, write 0xFFB1.
 * All frames begin with [0xAB, 0x2A].
 *   Type at byte[2]:
 *     0x80 = final weight: bytes [3-5] 24-bit big-endian, mask 0x03FFFF, /1000 (kg).
 *     0x01 = impedance: bytes [4-5] big-endian uint16.
 *     0x00 with byte[7]=0x80 = history (ignored).
 */
export class OneByoneNewAdapter implements ScaleAdapter {
  readonly name = '1byone Scale (new)';
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);
  readonly unlockCommand = [
    0xab, 0x2a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xd7,
  ];
  readonly unlockIntervalMs = 0;

  private cachedWeight = 0;
  private cachedImpedance = 0;

  matches(peripheral: Peripheral): boolean {
    const name = (peripheral.advertisement.localName || '').toLowerCase();
    return name === '1byone scale';
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3 || data[0] !== 0xab || data[1] !== 0x2a) return null;

    const type = data[2];

    if (type === 0x80 && data.length >= 6) {
      // Final weight frame: 24-bit BE at [3-5], mask lower 18 bits
      const raw24 = (data[3] << 16) | (data[4] << 8) | data[5];
      this.cachedWeight = (raw24 & 0x03ffff) / 1000;
    } else if (type === 0x01 && data.length >= 6) {
      // Impedance frame: BE uint16 at [4-5]
      this.cachedImpedance = (data[4] << 8) | data[5];
    } else if (type === 0x00 && data.length >= 8 && data[7] === 0x80) {
      // History frame — ignored
      return null;
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
