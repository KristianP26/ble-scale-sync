import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

/** Bitmask flags for tracking which frame types have been received. */
const FRAME_WEIGHT = 0x01; // 0xA5
const FRAME_FAT = 0x02; // 0xB0
const FRAME_MUSCLE = 0x04; // 0xC0
const FRAME_BMR = 0x08; // 0xD0
const FRAME_ALL = FRAME_WEIGHT | FRAME_FAT | FRAME_MUSCLE | FRAME_BMR;

/**
 * Adapter for the Senssun Fat Scale.
 *
 * Protocol: service 0xFFF0, notify 0xFFF1, write 0xFFF2.
 * Unlock via user sync command with XOR checksum of bytes[1..6].
 *
 * Notifications may be prefixed with 0xFF padding (stripped).
 * Frame types by byte[0]:
 *   0xA5 = weight at [1-2] BE /10, stable when [5]=0xAA.
 *   0xB0 = fat at [1-2] BE /10, water at [3-4] BE /10.
 *   0xC0 = muscle at [1-2] BE /10, bone at [3-4] BE /10.
 *   0xD0 = BMR (ignored).
 * Measurement is complete when all 4 frame types have been received.
 */
export class SenssunAdapter implements ScaleAdapterCore, GattWiring, Unlockable {
  readonly name = 'Senssun Fat Scale';
  readonly match: MatchDescriptor = { priority: 260, names: { exact: ['senssun fat'] } };
  readonly charNotifyUuid = uuid16(0xfff1);
  readonly charWriteUuid = uuid16(0xfff2);
  readonly normalizesWeight = true;
  /** User sync command: [0xA5, 0x10, 0x11, 0x1E, 0xA0, 0x00, 0x00, xor, 0x00]. */
  readonly unlockCommand = (() => {
    const bytes = [0xa5, 0x10, 0x11, 0x1e, 0xa0, 0x00, 0x00];
    let xor = 0;
    for (let i = 1; i <= 6; i++) xor ^= bytes[i];
    return [...bytes, xor & 0xff, 0x00];
  })();
  readonly unlockIntervalMs = 5000;

  private cachedWeight = 0;
  private cachedFat = 0;
  private cachedWater = 0;
  private cachedMuscle = 0;
  private cachedBone = 0;
  private framesMask = 0;
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

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 2) return null;

    // Strip leading 0xFF padding bytes
    let offset = 0;
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) return null;
    const frame = data.subarray(offset);

    if (frame.length < 3) return null;

    const type = frame[0];

    if (type === 0xa5 && frame.length >= 6) {
      // Weight frame: BE uint16 at [1-2] / 10
      this.cachedWeight = ((frame[1] << 8) | frame[2]) / 10;
      this.framesMask |= FRAME_WEIGHT;
      // Stable flag at [5] === 0xAA (informational, we still cache the weight)
    } else if (type === 0xb0 && frame.length >= 5) {
      // Fat/water frame: fat at [1-2] BE /10, water at [3-4] BE /10
      this.cachedFat = ((frame[1] << 8) | frame[2]) / 10;
      this.cachedWater = ((frame[3] << 8) | frame[4]) / 10;
      this.framesMask |= FRAME_FAT;
    } else if (type === 0xc0 && frame.length >= 5) {
      // Muscle/bone frame: muscle at [1-2] BE /10, bone at [3-4] BE /10
      this.cachedMuscle = ((frame[1] << 8) | frame[2]) / 10;
      this.cachedBone = ((frame[3] << 8) | frame[4]) / 10;
      this.framesMask |= FRAME_MUSCLE;
    } else if (type === 0xd0) {
      // BMR frame — ignored but tracked
      this.framesMask |= FRAME_BMR;
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
   * Adapters are shared singletons. Without this `framesMask` stays at
   * FRAME_ALL for the life of the process once one session has seen all four
   * frame types, which disarms
   * the completeness gate permanently: the next session resolves on its
   * first frame, exporting a still-unsettled weight (the 0xAA stable flag is
   * deliberately ignored) with the previous person's composition.
   */
  onSessionStart(): void {
    this.cachedWeight = 0;
    this.cachedFat = 0;
    this.cachedWater = 0;
    this.cachedMuscle = 0;
    this.cachedBone = 0;
    this.framesMask = 0;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && (this.framesMask & FRAME_ALL) === FRAME_ALL;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // Per-reading snapshot taken in parseNotification(). The live cache is only
    // a fallback for a reading this adapter did not build (direct callers,
    // tests); see the compByReading field comment for why it cannot be trusted.
    const comp = this.compByReading.get(reading) ?? this.snapshot();
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
