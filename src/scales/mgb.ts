import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

/**
 * Adapter for MGB-protocol scales (Swan, Icomon, YG brands).
 *
 * Protocol: service 0xFFB0, notify 0xFFB2, write 0xFFB1.
 * Init via 6-command sequence (user profile, time sync, unit) per openScale MGBHandler.
 *
 * Two-frame 20-byte protocol:
 *   Frame1 header [0xAC, 0x02|0x03, 0xFF]:
 *     weight at [12-13] BE /10 (kg), fat at [16-17] BE /10.
 *   Frame2 header [0x01, 0x00]:
 *     muscle at [2-3] LE /10, bone at [6-7] LE /10, water at [8-9] LE /10.
 *
 * Values are cached across frames until a complete reading is available.
 */
export class MgbAdapter implements ScaleAdapterCore, GattWiring {
  readonly name = 'MGB (Swan/Icomon/YG)';
  readonly match: MatchDescriptor = {
    priority: 30,
    names: { startsWith: ['swan'], exact: ['icomon', 'yg'] },
    serviceUuids: ['ffb0'],
  };
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);
  readonly normalizesWeight = true;

  private cachedWeight = 0;
  private cachedFat = 0;
  private cachedMuscle = 0;
  private cachedBone = 0;
  private cachedWater = 0;
  /**
   * Composition as it stood when each reading was emitted. `computeMetrics()`
   * runs LATER than the parse that produced the reading, and on the watcher
   * transports (mqtt-proxy, esphome-proxy) the watcher does not pause while the
   * loop processes a reading: `loop.ts` awaits `processReading()`, which
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
   * Send full init sequence per openScale MGBHandler:
   *   1. 0xF7 00 00 00
   *   2. 0xFA 00 00 00
   *   3. 0xFB [sex] [age] [height]
   *   4. 0xFD [year%100] [month] [day]
   *   5. 0xFC [hour] [minute] [second]
   *   6. 0xFE 06 [unit=0x00] 00
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    const { profile } = ctx;
    const sex = profile.gender === 'male' ? 0x01 : 0x02;
    const height = Math.min(0xff, Math.round(profile.height));
    const age = Math.min(0xff, profile.age);
    const now = new Date();

    await ctx.write(this.charWriteUuid, [0xf7, 0x00, 0x00, 0x00], false);
    await ctx.write(this.charWriteUuid, [0xfa, 0x00, 0x00, 0x00], false);
    await ctx.write(this.charWriteUuid, [0xfb, sex, age, height], false);
    await ctx.write(
      this.charWriteUuid,
      [0xfd, now.getFullYear() % 100, now.getMonth() + 1, now.getDate()],
      false,
    );
    await ctx.write(
      this.charWriteUuid,
      [0xfc, now.getHours(), now.getMinutes(), now.getSeconds()],
      false,
    );
    await ctx.write(this.charWriteUuid, [0xfe, 0x06, 0x00, 0x00], false);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 10) return null;

    // Frame1: header [0xAC, 0x02|0x03, 0xFF]
    if (data[0] === 0xac && (data[1] === 0x02 || data[1] === 0x03) && data[2] === 0xff) {
      if (data.length >= 18) {
        this.cachedWeight = data.readUInt16BE(12) / 10;
        this.cachedFat = data.readUInt16BE(16) / 10;
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

    const reading: ScaleReading = { weight: this.cachedWeight, impedance: 0 };
    this.compByReading.set(reading, this.snapshot());
    return reading;
  }

  private snapshot(): ScaleBodyComp {
    return {
      fat: this.cachedFat > 0 ? this.cachedFat : undefined,
      water: this.cachedWater > 0 ? this.cachedWater : undefined,
      muscle: this.cachedMuscle > 0 ? this.cachedMuscle : undefined,
      bone: this.cachedBone > 0 ? this.cachedBone : undefined,
    };
  }

  /**
   * Clear the previous weigh-in (#394).
   *
   * Adapters are shared singletons. Without this the guard
   * `if (this.cachedWeight <= 0)` passes on the LAST session's weight, so any
   * 10-byte frame resolves the next session
   * with the previous person's weight and composition. It also leaks without
   * any unusual precondition: Frame1 refreshes only weight and fat, so a
   * session where Frame2 never arrives exports the previous muscle, bone and
   * water against the new weight.
   */
  onSessionStart(): void {
    this.cachedWeight = 0;
    this.cachedFat = 0;
    this.cachedMuscle = 0;
    this.cachedBone = 0;
    this.cachedWater = 0;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.cachedFat > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // Per-reading snapshot taken in parseNotification(). The live cache is only
    // a fallback for a reading this adapter did not build (direct callers,
    // tests); see the compByReading field comment for why it cannot be trusted.
    const comp = this.compByReading.get(reading) ?? this.snapshot();
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
