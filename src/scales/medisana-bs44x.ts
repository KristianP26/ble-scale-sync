import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';

const CHR_NOTIFY = uuid16(0x8a21);
const CHR_WRITE = uuid16(0x8a81);

const EXACT_NAMES = ['013197', '013198', '0202b6'];

/**
 * Adapter for Medisana BS44x / BS440 BLE body-composition scales.
 *
 * Protocol details:
 *   - Service 0x78B2, notify (indicate) 0x8A21, write 0x8A81
 *   - Time sync unlock command: [0x02, t0, t1, t2, t3] (LE u32 unix timestamp)
 *   - Two notification types distinguished by frame length:
 *     - Weight frame (< 16 bytes): weight at [1-2] LE u16 / 100 (kg)
 *     - Feature frame (>= 16 bytes): fat, water, muscle, bone at various offsets
 *   - Values cached across frames; complete when weight > 0 and fat > 0
 */
export class MedisanaBs44xAdapter implements ScaleAdapter {
  readonly name = 'Medisana BS44x';
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;

  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  /** Cached weight from weight frames. */
  private cachedWeight = 0;

  /** Cached body-composition values from feature frames. */
  private cachedComp: ScaleBodyComp = {};

  /** Time sync with real Unix timestamp. */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const cmd = Buffer.alloc(5);
    cmd[0] = 0x02;
    cmd.writeUInt32LE(now, 1);
    await ctx.write(this.charWriteUuid, [...cmd], true);
  }

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();

    if (EXACT_NAMES.includes(name)) return true;
    if (name.startsWith('0203b')) return true;

    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    const svcFull = uuid16(0x78b2);
    return uuids.includes('78b2') || uuids.includes(svcFull);
  }

  /**
   * Parse a Medisana BS44x notification frame.
   *
   * Weight frame (length < 16):
   *   [1-2]    weight, little-endian uint16 / 100 (kg)
   *
   * Feature frame (length >= 16):
   *   [8-9]    fat %, little-endian uint16 & 0x0FFF / 10
   *   [10-11]  water %, little-endian uint16 & 0x0FFF / 10
   *   [12-13]  muscle %, little-endian uint16 & 0x0FFF / 10
   *   [14-15]  bone mass, little-endian uint16 & 0x0FFF / 10
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3) return null;

    if (data.length >= 16) {
      // Feature frame — body composition data
      const fat = (data.readUInt16LE(8) & 0x0fff) / 10;
      const water = (data.readUInt16LE(10) & 0x0fff) / 10;
      const muscle = (data.readUInt16LE(12) & 0x0fff) / 10;
      const bone = (data.readUInt16LE(14) & 0x0fff) / 10;

      this.cachedComp = {
        fat: fat > 0 ? fat : undefined,
        water: water > 0 ? water : undefined,
        muscle: muscle > 0 ? muscle : undefined,
        bone: bone > 0 ? bone : undefined,
      };
    } else {
      // Weight frame
      if (data.length >= 3) {
        const weight = data.readUInt16LE(1) / 100;
        if (weight > 0 && Number.isFinite(weight)) {
          this.cachedWeight = weight;
        }
      }
    }

    if (this.cachedWeight <= 0) return null;

    return { weight: this.cachedWeight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.cachedComp.fat != null && this.cachedComp.fat > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    return buildPayload(reading.weight, reading.impedance, this.cachedComp, profile);
  }
}
