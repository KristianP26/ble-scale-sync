import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, xorChecksum, type ScaleBodyComp } from './body-comp-helpers.js';

const CHR_NOTIFY = uuid16(0xfff4);
const CHR_WRITE = uuid16(0xfff1);

/**
 * Adapter for Excelvan CF369 / "Electronic Scale" BLE body-fat scales.
 *
 * Protocol ported from openScale's ExcelvanCF369 handler:
 *   - Service 0xFFF0, notify 0xFFF4, write 0xFFF1
 *   - Frames start with 0xCF, 16-17 bytes long
 *   - Weight at bytes [4-5] big-endian / 10 (kg)
 *   - Fat at [6-7] BE / 10, bone at [8] / 10, muscle at [9-10] BE / 10
 *   - Visceral fat at [11], water at [12-13] BE / 10
 *   - Complete when weight > 0 and fat byte at [6] is not 0xFF
 */
export class ExcelvanCF369Adapter implements ScaleAdapter {
  readonly name = 'Excelvan CF369';
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;

  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  /** Cached body-composition values from the most recent parsed frame. */
  private cachedComp: ScaleBodyComp = {};

  /**
   * Send user-config command with real profile data:
   *   [0] = 0xFE (command marker)
   *   [1] = userId (1)
   *   [2] = sex (0x01 = male, 0x00 = female)
   *   [3] = activity level (1)
   *   [4] = height in cm
   *   [5] = age
   *   [6] = unit (0x01 = kg)
   *   [7] = XOR checksum of bytes 1..6
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    const { profile } = ctx;
    const sex = profile.gender === 'male' ? 0x01 : 0x00;
    const height = Math.min(0xff, Math.max(0, Math.round(profile.height)));
    const age = Math.min(0xff, Math.max(0, profile.age));
    const cmd = [0xfe, 0x01, sex, 0x01, height, age, 0x01];
    cmd.push(xorChecksum(cmd, 1, 7));
    await ctx.write(this.charWriteUuid, cmd, false);
  }

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    return name === 'electronic scale';
  }

  /**
   * Parse an Excelvan CF369 notification frame.
   *
   * Layout (16-17 bytes, starts with 0xCF):
   *   [0]      0xCF marker
   *   [1-3]    header / flags
   *   [4-5]    weight, big-endian uint16 / 10 (kg)
   *   [6-7]    body fat %, big-endian uint16 / 10
   *   [8]      bone mass / 10
   *   [9-10]   muscle %, big-endian uint16 / 10
   *   [11]     visceral fat rating
   *   [12-13]  water %, big-endian uint16 / 10
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 14 || data[0] !== 0xcf) return null;

    const weight = data.readUInt16BE(4) / 10;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    const fatRaw = data.readUInt16BE(6);
    const fat = fatRaw / 10;
    const bone = data[8] / 10;
    const muscle = data.readUInt16BE(9) / 10;
    const visceral = data[11];
    const water = data.readUInt16BE(12) / 10;

    // Cache body-comp for use in computeMetrics
    this.cachedComp = {
      fat: data[6] !== 0xff ? fat : undefined,
      bone: data[6] !== 0xff ? bone : undefined,
      muscle: data[6] !== 0xff ? muscle : undefined,
      visceralFat: data[6] !== 0xff ? visceral : undefined,
      water: data[6] !== 0xff ? water : undefined,
    };

    return { weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.cachedComp.fat != null && this.cachedComp.fat > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    return buildPayload(reading.weight, reading.impedance, this.cachedComp, profile);
  }
}
