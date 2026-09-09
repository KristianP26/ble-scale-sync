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
import { bleLog } from '../ble/types.js';

/**
 * Adapter for Active Era BS-06 body-fat scales.
 *
 * Protocol: service 0xFFB0, notify 0xFFB2, write 0xFFB1.
 * Unlock via a 20-byte config packet starting with [0xAC, 0x27, ...].
 *
 * 20-byte measurement frames with magic 0xAC at byte[0].
 * Frame type at byte[18]:
 *   0xD5 = weight: bytes [3-5] 24-bit BE, mask 0x3FFFF, /1000 (kg).
 *          Stability flag at byte[2].
 *   0xD6 = impedance: bytes [4-5] BE uint16.
 *          If impedance >= 1500, correction formula is applied.
 *
 * Weight and impedance are cached across frames.
 */
export class ActiveEraAdapter implements ScaleAdapterCore, GattWiring, Unlockable {
  readonly name = 'Active Era BS-06';
  readonly match: MatchDescriptor = { priority: 50, names: { includes: ['ae bs-06'] } };
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);
  readonly normalizesWeight = true;
  /** 20-byte config packet — simplified with zeros for timestamp/user data. */
  readonly unlockCommand = [
    0xac, 0x27, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ];
  readonly unlockIntervalMs = 0;

  private cachedWeight = 0;
  private cachedImpedance = 0;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 20 || data[0] !== 0xac) return null;

    const frameType = data[18];

    if (frameType === 0xd5) {
      // Weight frame: 24-bit BE at [3-5], mask lower 18 bits
      const raw24 = (data[3] << 16) | (data[4] << 8) | data[5];
      this.cachedWeight = (raw24 & 0x3ffff) / 1000;
    } else if (frameType === 0xd6) {
      // Impedance frame: BE uint16 at [4-5]
      const raw = (data[4] << 8) | data[5];
      let imp = raw;

      // Impedance correction for high values
      if (imp >= 1500) {
        imp = (imp - 1000 + this.cachedWeight * 10 * -0.4) / 0.6 / 10;
      }

      // The RAW value is the one number that settles whether this correction is
      // right, and until now nothing ever showed it: `imp` was reassigned in
      // place, so the only value that reached a log was the corrected one. That
      // made the question in #386 unanswerable by the one person who could
      // answer it, an owner running with debug on.
      //
      // Why it matters: run the plausible 150-1200 ohm band backwards through
      // `(raw - 1000 - 4w) / 6 / 10` at 80 kg and it maps to raw 2220-8520,
      // most of the usable u16 range, so the band cannot discriminate. Drop the
      // `/10` and the threshold and the divisor line up exactly, 1500 landing on
      // 300 ohm. That is internal consistency, not a decode, so BIA stays off
      // here until a real reading says which reading of the formula is right.
      bleLog.debug(
        `Active Era 0xD6: raw=${raw}` +
          (raw >= 1500
            ? ` -> corrected ${imp.toFixed(1)} ohm`
            : ' (below the 1500 correction gate)') +
          `, cached weight ${this.cachedWeight} kg (#386)`,
      );

      this.cachedImpedance = imp;
    }

    if (this.cachedWeight <= 0) return null;

    return { weight: this.cachedWeight, impedance: this.cachedImpedance };
  }

  /**
   * Clear the previous weigh-in (#394).
   *
   * Adapters are shared singletons, so without this both caches survive and
   * the next session resolves on its first frame with the previous weight and
   * impedance. The stale weight is
   * worse than a stale number on its own: the `imp >= 1500` correction
   * multiplies it in, so even a fresh impedance frame decodes wrongly.
   */
  onSessionStart(): void {
    this.cachedWeight = 0;
    this.cachedImpedance = 0;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
