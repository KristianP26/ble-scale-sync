import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';

// Custom 128-bit UUIDs (remove dashes, lowercase)
const SVC_UUID = 'f433bd8075b811e297d90002a5d5c51b';
const CHR_NOTIFY = '1a2ea40075b911e2be050002a5d5c51b';
const CHR_WRITE = '29f1108075b911e28bf60002a5d5c51b';

/**
 * Adapter for Exingtech Y1 / "vscale" BLE body-fat scales.
 *
 * Protocol details:
 *   - Custom service f433bd80-75b8-11e2-97d9-0002a5d5c51b
 *   - 20-byte frames with weight, fat, water, bone, muscle, visceral fat
 *   - Weight at [4-5] big-endian uint16 / 10 (kg)
 *   - Body comp fields at subsequent offsets, each BE uint16 / 10
 *   - Complete when fat byte at [6] is not 0xFF
 */
export class ExingtechY1Adapter implements ScaleAdapter {
  readonly name = 'Exingtech Y1';
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;

  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  /** Cached body-composition values from the most recent parsed frame. */
  private cachedComp: ScaleBodyComp = {};

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name === 'vscale') return true;

    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase().replace(/-/g, ''));
    return uuids.includes(SVC_UUID);
  }

  /**
   * Send user config: [0x10, userId, sex, age, height].
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    const { profile } = ctx;
    const sex = profile.gender === 'male' ? 0x00 : 0x01;
    const height = Math.min(0xff, Math.max(0, Math.round(profile.height)));
    const age = Math.min(0xff, Math.max(0, profile.age));
    await ctx.write(this.charWriteUuid, [0x10, 0x01, sex, age, height], false);
  }

  /**
   * Parse a 20-byte Exingtech Y1 notification frame.
   *
   * Layout:
   *   [0-3]    header / flags
   *   [4-5]    weight, big-endian uint16 / 10 (kg)
   *   [6-7]    body fat %, big-endian uint16 / 10
   *   [8-9]    water %, big-endian uint16 / 10
   *   [10-11]  bone mass, big-endian uint16 / 10
   *   [12-13]  muscle %, big-endian uint16 / 10
   *   [14]     visceral fat rating
   *   [15-19]  padding / reserved
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 15) return null;

    const weight = data.readUInt16BE(4) / 10;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    const fatRaw = data.readUInt16BE(6);
    const fat = fatRaw / 10;
    const water = data.readUInt16BE(8) / 10;
    const bone = data.readUInt16BE(10) / 10;
    const muscle = data.readUInt16BE(12) / 10;
    const visceral = data[14];

    const complete = data[6] !== 0xff;

    this.cachedComp = {
      fat: complete ? fat : undefined,
      water: complete ? water : undefined,
      bone: complete ? bone : undefined,
      muscle: complete ? muscle : undefined,
      visceralFat: complete ? visceral : undefined,
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
