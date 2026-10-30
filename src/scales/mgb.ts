import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import {
  uuid16,
  buildPayload,
  type ScaleBodyComp,
  WEIGHT_ONLY_HOLD_MS,
} from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { isAc27Frame } from './active-era.js';
import { bleLog } from '../ble/types.js';

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class MgbSession {
  cachedWeight = 0;
  cachedFat = 0;
  cachedMuscle = 0;
  cachedBone = 0;
  cachedWater = 0;
  /** Whether this session already pointed an AC 27 scale at its adapter. */
  ac27Hinted = false;
}

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
export class MgbAdapter implements ScaleAdapterCore, GattWiring, HoldForComposition {
  readonly name = 'MGB (Swan/Icomon/YG)';
  readonly match: MatchDescriptor = {
    priority: 30,
    names: { startsWith: ['swan'], exact: ['icomon', 'yg'] },
    serviceUuids: ['ffb0'],
  };
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);

  private s = new MgbSession();

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

  parseNotification(data: Buffer): ScaleReading<ScaleBodyComp> | null {
    if (!this.s.ac27Hinted && isAc27Frame(data)) {
      // An AC 27 scale whose advertisement did not carry the 0x27AC company id
      // (#458 and #462 have not shown theirs, and ESPHome API < 1.9 drops
      // manufacturer data) lands here on its bare FFB0 service. Nothing below
      // parses its frames, and without this the session just times out.
      this.s.ac27Hinted = true;
      bleLog.info(
        'This scale sends AC 27 frames, which the Active Era BS-06 adapter reads and this ' +
          "one cannot. Set ble.force_scale_adapter: 'Active Era BS-06' and ble.scale_mac, " +
          'and please report the "Advert:" line from a log with debug on, so it can be ' +
          'picked automatically (#466).',
      );
    }
    if (data.length < 10) return null;

    // Frame1: header [0xAC, 0x02|0x03, 0xFF]
    if (data[0] === 0xac && (data[1] === 0x02 || data[1] === 0x03) && data[2] === 0xff) {
      if (data.length >= 18) {
        this.s.cachedWeight = data.readUInt16BE(12) / 10;
        this.s.cachedFat = data.readUInt16BE(16) / 10;
      }
    }

    // Frame2: header [0x01, 0x00]
    if (data[0] === 0x01 && data[1] === 0x00) {
      if (data.length >= 10) {
        this.s.cachedMuscle = data.readUInt16LE(2) / 10;
        this.s.cachedBone = data.readUInt16LE(6) / 10;
        this.s.cachedWater = data.readUInt16LE(8) / 10;
      }
    }

    if (this.s.cachedWeight <= 0) return null;

    return { weight: this.s.cachedWeight, impedance: 0, scaleComposition: this.snapshot() };
  }

  private snapshot(): ScaleBodyComp {
    return {
      fat: this.s.cachedFat > 0 ? this.s.cachedFat : undefined,
      water: this.s.cachedWater > 0 ? this.s.cachedWater : undefined,
      muscle: this.s.cachedMuscle > 0 ? this.s.cachedMuscle : undefined,
      bone: this.s.cachedBone > 0 ? this.s.cachedBone : undefined,
    };
  }

  onSessionStart(): void {
    this.s = new MgbSession();
  }

  /**
   * The weight completes the reading; a body fat value makes it final (ADR
   * D028, review D-07).
   *
   * Requiring the fat here meant a weigh-in the scale could not analyse (socks,
   * a child, fat 0 in Frame1) never produced a reading: the session ran into
   * its timeout and the weight was lost. Now it holds the link for
   * `WEIGHT_ONLY_HOLD_MS`, resolves at once if a frame with fat arrives, and
   * otherwise completes with the weight alone.
   */
  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  readonly completionHoldMs = WEIGHT_ONLY_HOLD_MS;

  isFinal(reading: ScaleReading<ScaleBodyComp>): boolean {
    const fat = (reading.scaleComposition ?? this.snapshot()).fat;
    return fat != null && fat > 0;
  }

  computeMetrics(reading: ScaleReading<ScaleBodyComp>, profile: UserProfile): BodyComposition {
    // Per-reading snapshot taken in parseNotification(). The live cache is only
    // a fallback for a reading this adapter did not build (direct callers,
    // tests); see `ScaleReading.scaleComposition` for why it cannot be trusted.
    const comp = reading.scaleComposition ?? this.snapshot();
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
