import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { buildPayload, ReadingComposition } from './body-comp-helpers.js';
import { parseSigBodyComposition, toScaleReading } from './sig-bcs.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

// Sanitas SBF72/73 / Beurer BF915 custom service + characteristic UUIDs (full 128-bit)
// Standard BCS characteristic for body composition measurement (inherited from StandardWeightProfileHandler)
const CHR_BODY_COMP_MEAS = '00002a9c00001000800000805f9b34fb';
const CHR_USER_CONTROL_POINT = '00002a9f00001000800000805f9b34fb';

interface CachedGattData {
  /** Undefined when the scale reported no measurement, not 0 (#405). */
  bodyFatPercent?: number;
  musclePct?: number;
  waterMassKg?: number;
}

/**
 * Adapter for Sanitas SBF72 / SBF73 and Beurer BF915 scales.
 *
 * **Limitation:** Uses hardcoded UCP consent for user index 1. The scale must
 * have user slot 1 configured via the manufacturer's official app before use.
 *
 * Protocol ported from openScale's SanitasSbf72Handler which extends
 * StandardWeightProfileHandler — uses standard BCS (0x181B) measurement
 * characteristic for body composition data, plus a custom service (0xFFFF)
 * for user management.
 *
 * Subscribes to Body Composition Measurement (0x2A9C) for weight/fat data.
 * Unlock sends user list request to trigger connection handshake.
 */
export class SanitasSbf72Adapter implements ScaleAdapterCore, GattWiring, Unlockable {
  readonly name = 'Sanitas SBF72/73';
  readonly match: MatchDescriptor = {
    priority: 170,
    names: { includes: ['sbf72', 'sbf73', 'bf915'] },
  };
  readonly charNotifyUuid = CHR_BODY_COMP_MEAS;
  readonly charWriteUuid = CHR_USER_CONTROL_POINT;
  readonly normalizesWeight = true;
  /** UCP Consent opcode for user index 1 with consent code 0. */
  readonly unlockCommand = [0x02, 0x01, 0x00, 0x00];
  readonly unlockIntervalMs = 5000;

  private cachedGatt: CachedGattData | null = null;
  /**
   * Composition pinned to the reading it was measured with (#394): this adapter
   * is a shared singleton and `computeMetrics()` runs later than the parse, so
   * on the watcher transports the live cache can already belong to the next
   * weigh-in. See ReadingComposition.
   */
  private readonly comp = new ReadingComposition<CachedGattData | null>();

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  /**
   * Parse a BT SIG Body Composition Measurement (0x2A9C) notification.
   *
   * Same format as StandardGattScaleAdapter — standard BCS flags with
   * body fat, optional fields (timestamp, user, BMR, muscle %, muscle mass,
   * fat-free mass, soft lean, water mass, impedance, weight, height).
   */
  parseNotification(data: Buffer): ScaleReading | null {
    const decoded = parseSigBodyComposition(data);
    if (!decoded) return null;

    this.cachedGatt = {
      bodyFatPercent: decoded.bodyFatPercent,
      musclePct: decoded.musclePct,
      waterMassKg: decoded.waterMassKg,
    };
    const reading = toScaleReading(decoded);
    this.comp.pin(reading, this.cachedGatt);
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
    this.cachedGatt = null;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const gatt = this.comp.of(reading, this.cachedGatt);
    const waterPercent =
      gatt?.waterMassKg && reading.weight > 0
        ? (gatt.waterMassKg / reading.weight) * 100
        : undefined;

    return buildPayload(
      reading.weight,
      reading.impedance,
      {
        fat: gatt?.bodyFatPercent,
        water: waterPercent,
        muscle: gatt?.musclePct,
      },
      profile,
    );
  }
}
