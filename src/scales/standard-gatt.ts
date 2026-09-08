import { computeBiaFat, buildPayload, uuid16, ReadingComposition } from './body-comp-helpers.js';
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
  bodyFatPercent: number;
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
    if (data.length < 4) return null;

    let offset = 0;
    const flags = data.readUInt16LE(offset);
    offset += 2;

    const isKg = (flags & 0x0001) === 0;
    const tsPresent = (flags & 0x0002) !== 0;
    const userPresent = (flags & 0x0004) !== 0;
    const bmrPresent = (flags & 0x0008) !== 0;
    const musclePctPresent = (flags & 0x0010) !== 0;
    const muscleMassPresent = (flags & 0x0020) !== 0;
    const fatFreeMassPresent = (flags & 0x0040) !== 0;
    const softLeanPresent = (flags & 0x0080) !== 0;
    const waterMassPresent = (flags & 0x0100) !== 0;
    const impedancePresent = (flags & 0x0200) !== 0;
    const weightPresent = (flags & 0x0400) !== 0;
    const heightPresent = (flags & 0x0800) !== 0;

    const massMultiplier = isKg ? 0.005 : 0.01;

    // Body Fat Percentage — mandatory field
    if (offset + 2 > data.length) return null;
    const bodyFatPct = data.readUInt16LE(offset) * 0.1;
    offset += 2;

    // Timestamp (7 bytes)
    if (tsPresent) offset += 7;

    // User Index
    if (userPresent) offset += 1;

    // Basal Metabolism (kJ)
    if (bmrPresent) offset += 2;

    // Muscle Percentage
    let musclePct: number | undefined;
    if (musclePctPresent && offset + 2 <= data.length) {
      musclePct = data.readUInt16LE(offset) * 0.1;
      offset += 2;
    }

    // Muscle Mass
    if (muscleMassPresent && offset + 2 <= data.length) offset += 2;

    // Fat Free Mass
    if (fatFreeMassPresent && offset + 2 <= data.length) offset += 2;

    // Soft Lean Mass
    if (softLeanPresent && offset + 2 <= data.length) offset += 2;

    // Body Water Mass
    let waterMassKg: number | undefined;
    if (waterMassPresent && offset + 2 <= data.length) {
      const raw = data.readUInt16LE(offset) * massMultiplier;
      offset += 2;
      waterMassKg = isKg ? raw : raw * 0.453592;
    }

    // Impedance (resolution 0.1 Ohm)
    let impedance = 0;
    if (impedancePresent && offset + 2 <= data.length) {
      impedance = data.readUInt16LE(offset) * 0.1;
      offset += 2;
    }

    // Weight
    let weight = 0;
    if (weightPresent && offset + 2 <= data.length) {
      const rawW = data.readUInt16LE(offset) * massMultiplier;
      offset += 2;
      weight = isKg ? rawW : rawW * 0.453592;
    }

    if (heightPresent && offset + 2 <= data.length) offset += 2;

    this.cachedGatt = { bodyFatPercent: bodyFatPct, musclePct, waterMassKg };
    const reading: ScaleReading = { weight, impedance };
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
    // When impedance is available, use the full BIA-based calculation
    if (reading.impedance > 0) {
      const fat = computeBiaFat(reading.weight, reading.impedance, profile);
      return buildPayload(reading.weight, reading.impedance, { fat }, profile);
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
        fat: gatt?.bodyFatPercent && gatt.bodyFatPercent > 0 ? gatt.bodyFatPercent : undefined,
        water: waterPercent,
        muscle: gatt?.musclePct,
      },
      profile,
    );
  }
}
