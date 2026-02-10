import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  GarminPayload,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, xorChecksum, type ScaleBodyComp } from './body-comp-helpers.js';

/**
 * Adapter for the Hoffen BS-8107 body-fat scale.
 *
 * Protocol: service 0xFFB0, notify 0xFFB2, write 0xFFB2 (same char for both!).
 * Unlock via CMD_SEND_USER with XOR checksum.
 *
 * Frames start with magic 0xFA. Response code at byte[1].
 * Measurement response:
 *   Weight at [3-4] LE uint16 /10 (kg).
 *   If contact byte at [5] == 0x00 (BIA contact established):
 *     fat at [6-7] LE /10, water at [8-9] LE /10,
 *     muscle at [10-11] LE /10, bone at [14] /10,
 *     visceral fat at [17-18] LE /10.
 */
export class HoffenAdapter implements ScaleAdapter {
  readonly name = 'Hoffen BS-8107';
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb2);
  readonly normalizesWeight = true;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;

  private cachedFat = 0;
  private cachedWater = 0;
  private cachedMuscle = 0;
  private cachedBone = 0;
  private cachedVisceral = 0;

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    return name === 'hoffen bs-8107';
  }

  /**
   * CMD_SEND_USER with real profile: [0xFA, 0x85, 0x03, gender, age, height, xor].
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    const { profile } = ctx;
    const gender = profile.gender === 'male' ? 0x00 : 0x01;
    const height = Math.min(0xff, Math.max(0, Math.round(profile.height)));
    const age = Math.min(0xff, Math.max(0, profile.age));
    const cmd = [0xfa, 0x85, 0x03, gender, age, height];
    cmd.push(xorChecksum(cmd, 0, cmd.length));
    await ctx.write(this.charWriteUuid, cmd, false);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 5 || data[0] !== 0xfa) return null;

    const weight = data.readUInt16LE(3) / 10;

    // Check for BIA contact and body composition data
    if (data.length >= 19 && data[5] === 0x00) {
      this.cachedFat = data.readUInt16LE(6) / 10;
      this.cachedWater = data.readUInt16LE(8) / 10;
      this.cachedMuscle = data.readUInt16LE(10) / 10;
      this.cachedBone = data[14] / 10;
      this.cachedVisceral = data.readUInt16LE(17) / 10;
    }

    return { weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): GarminPayload {
    const comp: ScaleBodyComp = {
      fat: this.cachedFat > 0 ? this.cachedFat : undefined,
      water: this.cachedWater > 0 ? this.cachedWater : undefined,
      muscle: this.cachedMuscle > 0 ? this.cachedMuscle : undefined,
      bone: this.cachedBone > 0 ? this.cachedBone : undefined,
      visceralFat: this.cachedVisceral > 0 ? this.cachedVisceral : undefined,
    };
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
