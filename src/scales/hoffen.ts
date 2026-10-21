import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import {
  uuid16,
  buildPayload,
  xorChecksum,
  type ScaleBodyComp,
  ReadingComposition,
} from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog } from '../ble/types.js';

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class HoffenSession {
  /** The last frame we wrote, so its echo is not decoded as a measurement. */
  lastCommand: Buffer | null = null;
  cachedFat = 0;
  cachedWater = 0;
  cachedMuscle = 0;
  cachedBone = 0;
  cachedVisceral = 0;
}

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
  // Not renamed to mention the ProfiCare: this string is what a user puts in
  // ble.force_scale_adapter, so changing it would break existing configs.
  readonly name = 'Hoffen BS-8107';
  readonly match: MatchDescriptor = {
    priority: 20,
    // openScale maps two names onto this one driver: the Hoffen and the
    // ProfiCare PC-PW 3008 BT, which is the same hardware rebadged. Ours
    // claimed only the first, so a ProfiCare owner had an unsupported scale on
    // a protocol we already ship (#409).
    names: { exact: ['hoffen bs-8107', 'pc-pw 3008 bt'] },
  };
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb2);

  private s = new HoffenSession();

  /**
   * Composition pinned to the reading it was measured with (#394). See
   * ReadingComposition for why computeMetrics cannot read the live cache on
   * the watcher transports.
   */
  private readonly compByReading = new ReadingComposition<ScaleBodyComp>();

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
    this.s.lastCommand = Buffer.from(cmd);
    await ctx.write(this.charWriteUuid, cmd, false);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 5 || data[0] !== 0xfa) return null;

    // Byte [1] is a response code, and 0xFA plainly has several: onConnected
    // writes [0xFA, 0x85, 0x03, ...] itself. Every frame here is decoded as a
    // measurement regardless, and isComplete is a bare `weight > 0` with no
    // hold window, so the first reply that happens to decode ends the session
    // with whatever those two bytes contained (#405).
    //
    // Gating on a GUESSED measurement code would be the same mistake pointed
    // the other way, because no capture of this scale exists. What is certain
    // is that our OWN command is not a measurement, so an echo of it is
    // rejected; and the code is logged so the first owner to run with
    // debug: true answers the question for good.
    if (this.s.lastCommand && data.equals(this.s.lastCommand)) {
      bleLog.debug(
        `Hoffen: ignoring an echo of the command we just wrote [${data.toString('hex')}]`,
      );
      return null;
    }
    bleLog.debug(
      `Hoffen 0xFA frame: response code 0x${data[1].toString(16)} [${data.toString('hex')}]`,
    );

    const weight = data.readUInt16LE(3) / 10;

    // Check for BIA contact and body composition data
    if (data.length >= 19 && data[5] === 0x00) {
      this.s.cachedFat = data.readUInt16LE(6) / 10;
      this.s.cachedWater = data.readUInt16LE(8) / 10;
      this.s.cachedMuscle = data.readUInt16LE(10) / 10;
      this.s.cachedBone = data[14] / 10;
      this.s.cachedVisceral = data.readUInt16LE(17) / 10;
    }

    const reading: ScaleReading = { weight, impedance: 0 };
    this.compByReading.pin(reading, this.snapshot());
    return reading;
  }

  private snapshot(): ScaleBodyComp {
    return {
      fat: this.s.cachedFat > 0 ? this.s.cachedFat : undefined,
      water: this.s.cachedWater > 0 ? this.s.cachedWater : undefined,
      muscle: this.s.cachedMuscle > 0 ? this.s.cachedMuscle : undefined,
      bone: this.s.cachedBone > 0 ? this.s.cachedBone : undefined,
      visceralFat: this.s.cachedVisceral > 0 ? this.s.cachedVisceral : undefined,
    };
  }

  onSessionStart(): void {
    this.s = new HoffenSession();
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // Per-reading snapshot taken in parseNotification(). The live cache is only
    // a fallback for a reading this adapter did not build (direct callers,
    // tests); see the compByReading field comment for why it cannot be trusted.
    const comp = this.compByReading.of(reading, this.snapshot());
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
