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
import { buildPayload, WEIGHT_ONLY_HOLD_MS, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

// Custom 128-bit UUIDs (remove dashes, lowercase)
const CHR_NOTIFY = '1a2ea40075b911e2be050002a5d5c51b';
const CHR_WRITE = '29f1108075b911e28bf60002a5d5c51b';

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class ExingtechSession {
  /** Body-composition values from the most recent parsed frame. */
  cachedComp: ScaleBodyComp = {};
}

/**
 * Adapter for Exingtech Y1 / "vscale" BLE body-fat scales.
 *
 * Protocol details:
 *   - Custom service f433bd80-75b8-11e2-97d9-0002a5d5c51b
 *   - 20-byte frames with weight, fat, water, bone, muscle, visceral fat
 *   - Weight at [4-5] big-endian uint16 / 10 (kg)
 *   - Body comp fields at subsequent offsets, each BE uint16 / 10
 *   - Composition present when the fat byte at [6] is not 0xFF; a frame without it
 *     completes weight-only after WEIGHT_ONLY_HOLD_MS (D028)
 */
export class ExingtechY1Adapter implements ScaleAdapterCore, GattWiring, HoldForComposition {
  readonly name = 'Exingtech Y1';
  readonly match: MatchDescriptor = {
    priority: 120,
    names: { exact: ['vscale'] },
    serviceUuids: ['f433bd8075b811e297d90002a5d5c51b'],
  };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;

  private s = new ExingtechSession();

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
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
  parseNotification(data: Buffer): ScaleReading<ScaleBodyComp> | null {
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

    this.s.cachedComp = {
      fat: complete ? fat : undefined,
      water: complete ? water : undefined,
      bone: complete ? bone : undefined,
      muscle: complete ? muscle : undefined,
      visceralFat: complete ? visceral : undefined,
    };

    return { weight, impedance: 0, scaleComposition: this.s.cachedComp };
  }

  /**
   * The weight completes the reading; the composition makes it final (ADR D028,
   * review D-07).
   *
   * Requiring a fat value here meant a weigh-in the scale could not analyse
   * (socks, a child, a short step-on) never produced a reading at all: the
   * session ran into its timeout and the weight was lost. Now such a reading
   * holds the link for `WEIGHT_ONLY_HOLD_MS`, resolves at once if a frame with
   * composition arrives, and otherwise completes with the weight alone.
   */
  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  readonly completionHoldMs = WEIGHT_ONLY_HOLD_MS;

  isFinal(reading: ScaleReading<ScaleBodyComp>): boolean {
    const fat = (reading.scaleComposition ?? this.s.cachedComp).fat;
    return fat != null && fat > 0;
  }

  onSessionStart(): void {
    this.s = new ExingtechSession();
  }

  computeMetrics(reading: ScaleReading<ScaleBodyComp>, profile: UserProfile): BodyComposition {
    return buildPayload(
      reading.weight,
      reading.impedance,
      reading.scaleComposition ?? this.s.cachedComp,
      profile,
    );
  }
}
