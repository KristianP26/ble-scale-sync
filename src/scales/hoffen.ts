import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, xorChecksum, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

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
export class HoffenAdapter implements ScaleAdapterCore, GattWiring {
  readonly name = 'Hoffen BS-8107';
  readonly match: MatchDescriptor = { priority: 20, names: { exact: ['hoffen bs-8107'] } };
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb2);
  readonly normalizesWeight = true;

  private cachedFat = 0;
  private cachedWater = 0;
  private cachedMuscle = 0;
  private cachedBone = 0;
  private cachedVisceral = 0;
  /**
   * Composition as it stood when each reading was emitted. `computeMetrics()`
   * runs LATER than the parse that produced the reading, and on the watcher
   * transports (mqtt-proxy, esphome-proxy) the watcher does not pause while
   * the loop processes a reading: `loop.ts` awaits `processReading()`, which
   * includes network exports, and the watcher can open the NEXT GATT session -
   * and therefore fire `onSessionStart()` - in the meantime. Reading the live
   * cache in `computeMetrics` would then hand the completed reading a cache
   * that was just cleared. Weak so the processor dropping a reading frees it.
   */
  private readonly compByReading = new WeakMap<ScaleReading, ScaleBodyComp>();

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
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

    const reading: ScaleReading = { weight, impedance: 0 };
    this.compByReading.set(reading, this.snapshot());
    return reading;
  }

  private snapshot(): ScaleBodyComp {
    return {
      fat: this.cachedFat > 0 ? this.cachedFat : undefined,
      water: this.cachedWater > 0 ? this.cachedWater : undefined,
      muscle: this.cachedMuscle > 0 ? this.cachedMuscle : undefined,
      bone: this.cachedBone > 0 ? this.cachedBone : undefined,
      visceralFat: this.cachedVisceral > 0 ? this.cachedVisceral : undefined,
    };
  }

  /**
   * Clear the previous weigh-in (#394).
   *
   * Adapters are shared singletons. Without this the composition survives while
   * the weight does not, and isComplete is a bare `weight > 0` with no hold
   * window. One weigh-in
   * where the scale reports no BIA foot contact therefore exports the
   * PREVIOUS person's whole body composition against a fresh weight.
   */
  onSessionStart(): void {
    this.cachedFat = 0;
    this.cachedWater = 0;
    this.cachedMuscle = 0;
    this.cachedBone = 0;
    this.cachedVisceral = 0;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // Per-reading snapshot taken in parseNotification(). The live cache is only
    // a fallback for a reading this adapter did not build (direct callers,
    // tests); see the compByReading field comment for why it cannot be trusted.
    const comp = this.compByReading.get(reading) ?? this.snapshot();
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
