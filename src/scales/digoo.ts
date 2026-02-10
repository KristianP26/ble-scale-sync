import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';

const CHR_NOTIFY = uuid16(0xfff1);
const CHR_WRITE = uuid16(0xfff2);

/**
 * Adapter for Digoo / "Mengii" BLE body-fat scales.
 *
 * Protocol ported from openScale's Digoo handler:
 *   - Service 0xFFF0, notify 0xFFF1, write 0xFFF2
 *   - 20-byte frames
 *   - Control byte at [5]: bit0 = weight stable, bit1 = all body-comp values present
 *   - Weight at [3-4] big-endian / 100 (kg)
 *   - When all-values bit set:
 *     fat at [6-7] BE / 10, visceral at [10] / 10,
 *     water at [11-12] BE / 10, muscle at [16-17] BE / 10, bone at [18] / 10
 *   - Complete when weight > 0 and both stable and all-values bits are set
 */
export class DigooScaleAdapter implements ScaleAdapter {
  readonly name = 'Digoo';
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 5000;

  /** Cached body-composition values from the most recent parsed frame. */
  private cachedComp: ScaleBodyComp = {};
  /** Tracks whether the weight reading is stable. */
  private stable = false;
  /** Tracks whether all body-comp values are present. */
  private allValues = false;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    return name === 'mengii';
  }

  /**
   * Send user config to trigger BIA analysis after connection.
   *
   * openScale format:
   *   [0x09, 0x10, 0x12, 0x11, 0x0D, 0x01, height, age, gender, unit, 0..0, checksum]
   *   checksum = sum of bytes 3..14 & 0xFF
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    const { profile } = ctx;
    const gender = profile.gender === 'male' ? 0x00 : 0x01;
    const height = Math.min(0xff, Math.max(0, Math.round(profile.height)));
    const age = Math.min(0xff, Math.max(0, profile.age));
    const cmd = [0x09, 0x10, 0x12, 0x11, 0x0d, 0x01, height, age, gender, 0x01, 0, 0, 0, 0, 0];
    let checksum = 0;
    for (let i = 3; i <= 14; i++) checksum += cmd[i];
    cmd.push(checksum & 0xff);
    await ctx.write(this.charWriteUuid, cmd, false);
  }

  /**
   * Parse a Digoo / Mengii notification frame.
   *
   * Layout (20 bytes):
   *   [0-2]    header / flags
   *   [3-4]    weight, big-endian uint16 / 100 (kg)
   *   [5]      control byte: bit0 = stable, bit1 = all-values present
   *   [6-7]    body fat %, big-endian uint16 / 10
   *   [8-9]    (reserved)
   *   [10]     visceral fat / 10
   *   [11-12]  water %, big-endian uint16 / 10
   *   [13-15]  (reserved)
   *   [16-17]  muscle %, big-endian uint16 / 10
   *   [18]     bone mass / 10
   *   [19]     (remaining byte)
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 19) return null;

    const weight = data.readUInt16BE(3) / 100;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    const control = data[5];
    this.stable = (control & 0x01) !== 0;
    this.allValues = (control & 0x02) !== 0;

    if (this.allValues) {
      const fat = data.readUInt16BE(6) / 10;
      const visceral = data[10] / 10;
      const water = data.readUInt16BE(11) / 10;
      const muscle = data.readUInt16BE(16) / 10;
      const bone = data[18] / 10;

      this.cachedComp = {
        fat: fat > 0 ? fat : undefined,
        visceralFat: visceral > 0 ? visceral : undefined,
        water: water > 0 ? water : undefined,
        muscle: muscle > 0 ? muscle : undefined,
        bone: bone > 0 ? bone : undefined,
      };
    } else {
      this.cachedComp = {};
    }

    return { weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.stable && this.allValues;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    return buildPayload(reading.weight, reading.impedance, this.cachedComp, profile);
  }
}
