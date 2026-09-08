import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import {
  uuid16,
  buildPayload,
  ReadingComposition,
  type ScaleBodyComp,
} from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

const CHR_NOTIFY = uuid16(0xfff4);
const CHR_WRITE = uuid16(0xfff1);

/**
 * Adapter for Hesley / "YunChen" BLE body-fat scales.
 *
 * Protocol ported from openScale's Hesley handler:
 *   - Service 0xFFF0, notify 0xFFF4, write 0xFFF1
 *   - 20-byte frames
 *   - Weight at bytes [2-3] big-endian / 100 (kg)
 *   - Fat at [4-5] BE / 10, water at [8-9] BE / 10
 *   - Muscle at [10-11] BE / 10, bone at [12-13] BE / 10
 */
export class HesleyScaleAdapter implements ScaleAdapterCore, GattWiring, Unlockable {
  readonly name = 'Hesley';
  readonly match: MatchDescriptor = { priority: 100, names: { exact: ['yunchen'] } };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;
  /** Magic init sequence to start measurements. */
  readonly unlockCommand = [0xa5, 0x01, 0x2c, 0xab, 0x50, 0x5a, 0x29];
  readonly unlockIntervalMs = 0;

  /** Cached body-composition values from the most recent parsed frame. */
  private cachedComp: ScaleBodyComp = {};
  /**
   * Composition pinned to the reading it was measured with (#394): this adapter
   * is a shared singleton and `computeMetrics()` runs later than the parse, so
   * on the watcher transports the live cache can already belong to the next
   * weigh-in. See ReadingComposition.
   */
  private readonly comp = new ReadingComposition<ScaleBodyComp>();

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  /**
   * Parse a Hesley / YunChen notification frame.
   *
   * Layout (20 bytes):
   *   [0-1]    header / flags
   *   [2-3]    weight, big-endian uint16 / 100 (kg)
   *   [4-5]    body fat %, big-endian uint16 / 10
   *   [6-7]    (unused / reserved)
   *   [8-9]    water %, big-endian uint16 / 10
   *   [10-11]  muscle %, big-endian uint16 / 10
   *   [12-13]  bone mass (kg), big-endian uint16 / 10
   *   [14-19]  (remaining bytes)
   */
  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 14) return null;

    const weight = data.readUInt16BE(2) / 100;
    if (weight <= 0 || !Number.isFinite(weight)) return null;

    const fat = data.readUInt16BE(4) / 10;
    const water = data.readUInt16BE(8) / 10;
    const muscle = data.readUInt16BE(10) / 10;
    const bone = data.readUInt16BE(12) / 10;

    this.cachedComp = {
      fat: fat > 0 ? fat : undefined,
      water: water > 0 ? water : undefined,
      muscle: muscle > 0 ? muscle : undefined,
      bone: bone > 0 ? bone : undefined,
    };

    const reading: ScaleReading = { weight, impedance: 0 };
    this.comp.pin(reading, this.cachedComp);
    return reading;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  /**
   * Clear the previous weigh-in before anything is subscribed (#394).
   *
   * The pin above is what fixes the real leak. This reset covers the OTHER
   * path: a reading built outside parseNotification (a direct caller, a test)
   * has nothing pinned, so computeMetrics falls back to the live cache - and
   * that must not still hold the previous person's numbers. It is also what
   * the ScaleAdapter contract requires of every adapter, so a sibling added
   * later inherits a correct example rather than this one's peculiarity.
   */
  onSessionStart(): void {
    this.cachedComp = {};
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(
      reading.weight,
      reading.impedance,
      this.comp.of(reading, this.cachedComp),
      profile,
    );
  }
}
