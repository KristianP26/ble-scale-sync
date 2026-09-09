import {
  biaFatIfPlausible,
  buildPayload,
  uuid16,
  ReadingComposition,
} from './body-comp-helpers.js';
import { parseSigBodyComposition, toScaleReading } from './sig-bcs.js';
import type {
  BleDeviceInfo,
  ScaleAdapterCore,
  GattWiring,
  Unlockable,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import type { MatchDescriptor } from './match-descriptor.js';
import { isGenericExcludedName } from './derived-excludes.js';

// Standard BT SIG characteristic UUIDs
const CHR_BODY_COMP_MEAS = uuid16(0x2a9c);
const CHR_USER_CONTROL_POINT = uuid16(0x2a9f);

// Service short-form UUIDs (as noble may advertise them)
const SVC_BODY_COMP_SHORT = '181b';
const SVC_WEIGHT_SHORT = '181d';

/** Known brand / model substrings for standard-GATT body-composition scales.
 *  Only models NOT handled by specific adapters should be listed here.
 *  BF720 / BF105 / BF500 / BF788 / BF950 are SIG consent+bond scales owned by
 *  BeurerBf720Adapter, so they are deliberately absent: matches() bails on
 *  isGenericExcludedName() before this list is consulted, which made listing
 *  them both dead and self-contradictory (#229, #255). */
const KNOWN_NAMES = ['beurer', 'silvercrest', 'bf600', 'bf850', 'medisana'];

interface CachedGattData {
  /** Undefined when the scale reported no measurement, not 0 (#405). */
  bodyFatPercent?: number;
  musclePct?: number;
  waterMassKg?: number;
}

/**
 * Adapter for scales implementing the standard Bluetooth SIG
 * Body Composition Service (0x181B) and/or Weight Scale Service (0x181D).
 *
 * Covers: Beurer, Sanitas, Silvercrest, Digoo, 1byone, Medisana, and other
 * BCS/WSS-compliant scales.
 *
 * Subscribes to the Body Composition Measurement characteristic (0x2A9C).
 * Parses the standard GATT flags for unit detection, body fat, impedance,
 * weight, water mass, and muscle percentage.
 */
export class StandardGattScaleAdapter implements ScaleAdapterCore, GattWiring, Unlockable {
  readonly name = 'Standard GATT (BCS/WSS)';
  readonly match: MatchDescriptor = {
    priority: 0,
    custom: true,
    names: {
      includes: ['beurer', 'silvercrest', 'bf600', 'bf850', 'medisana'],
    },
    serviceUuids: ['181b', '181d'],
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
    const name = (device.localName || '').toLowerCase();
    if (name && isGenericExcludedName(name)) return false;

    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    const hasBcs = uuids.some((u) => u === SVC_BODY_COMP_SHORT || u === uuid16(0x181b));
    const hasWss = uuids.some((u) => u === SVC_WEIGHT_SHORT || u === uuid16(0x181d));
    if (hasBcs || hasWss) return true;

    return KNOWN_NAMES.some((n) => name.includes(n));
  }

  /**
   * Parse a BT SIG Body Composition Measurement (0x2A9C) notification.
   *
   * Layout (per Bluetooth GATT specification):
   *   Bytes 0-1 : Flags (uint16 LE)
   *   Bytes 2-3 : Body Fat Percentage (uint16 LE, resolution 0.1 %)
   *   Then optional fields governed by flag bits.
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
    // A plausible impedance gets the full BIA calculation. An implausible one
    // does NOT fall through to Deurenberg here, unlike the impedance-only
    // adapters: this scale reports its own body composition, which is a better
    // source than an estimate from BMI, so a rejected impedance lands on the
    // branch below rather than throwing that away too (#405).
    const biaFat = biaFatIfPlausible(reading.weight, reading.impedance, profile);
    if (biaFat !== undefined) {
      return buildPayload(reading.weight, reading.impedance, { fat: biaFat }, profile);
    }

    // Fallback: derive metrics from GATT body-fat + profile estimations
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
