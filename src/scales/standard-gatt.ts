import { biaFatIfPlausible, buildPayload, uuid16 } from './body-comp-helpers.js';
import { SigMeasurementPairing } from './sig-bcs.js';
import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  MultiCharNotify,
  Unlockable,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import type { MatchDescriptor } from './match-descriptor.js';
import { isGenericExcludedName } from './derived-excludes.js';
import { normalizeUuid } from '../ble/types.js';

// Standard BT SIG characteristic UUIDs
const CHR_BODY_COMP_MEAS = uuid16(0x2a9c);
const CHR_WEIGHT_MEAS = uuid16(0x2a9d);
const CHR_USER_CONTROL_POINT = uuid16(0x2a9f);

// Service short-form UUIDs (as noble may advertise them)
const SVC_BODY_COMP_SHORT = '181b';
const SVC_WEIGHT_SHORT = '181d';

/**
 * How long a 0x2A9D weight waits for the 0x2A9C that may follow it. A scale
 * with the Weight Scale service alone never sends one, so its weigh-in resolves
 * when this runs out (or when it disconnects, whichever is first).
 */
const BCS_WAIT_MS = 5000;

/** Known brand / model substrings for standard-GATT body-composition scales.
 *  Only models NOT handled by specific adapters should be listed here.
 *  BF720 / BF105 / BF500 / BF788 / BF950 / BF915 are SIG consent+bond scales
 *  owned by BeurerBf720Adapter, so they are deliberately absent: matches()
 *  bails on isGenericExcludedName() before this list is consulted, which made
 *  listing them both dead and self-contradictory (#229, #255). */
// bf1000, sbf76 and sbf77 come from openScale's standard Beurer/Sanitas
// handler (#409). They are SIG-profile models with no adapter of their own, so
// without a name they were reachable only through the generic 0x181B/0x181D
// service claim. sbf70 and sbf75 are deliberately absent: those are the custom
// FFE1 protocol and belong to beurer-sanitas.ts.
const KNOWN_NAMES = [
  'beurer',
  'silvercrest',
  'bf600',
  'bf850',
  'bf1000',
  'sbf76',
  'sbf77',
  'medisana',
];

/**
 * Adapter for scales implementing the standard Bluetooth SIG
 * Body Composition Service (0x181B) and/or Weight Scale Service (0x181D).
 *
 * Covers: Beurer, Sanitas, Silvercrest, Digoo, 1byone, Medisana, and other
 * BCS/WSS-compliant scales.
 *
 * Subscribes to Weight Measurement (0x2A9D) and Body Composition Measurement
 * (0x2A9C), each when the device has it, and pairs them into one weigh-in (see
 * SigMeasurementPairing). The weight is mandatory only in 0x2A9D, so reading
 * 0x2A9C alone left a Weight Scale only device, and one that sends its weight
 * there and only the fat in 0x2A9C, without a reading at all (review C-05).
 *
 * Every binding is optional because no single characteristic is common to all
 * of them. The cost is that a GATT discovery race hiding them all is no longer
 * reported as missing characteristics: the session then waits out its timeout
 * and the next cycle reconnects.
 */
export class StandardGattScaleAdapter
  implements ScaleAdapterCore, GattWiring, MultiCharNotify, HoldForComposition, Unlockable
{
  readonly name = 'Standard GATT (BCS/WSS)';
  readonly match: MatchDescriptor = {
    priority: 0,
    custom: true,
    // Derived from KNOWN_NAMES so the descriptor cannot drift from matches()
    // again (it missed the #409 names). Informational only: the descriptor is
    // custom, and genericExcludes() skips priority 0.
    names: {
      includes: [...KNOWN_NAMES],
    },
    serviceUuids: ['181b', '181d'],
  };
  readonly charNotifyUuid = CHR_BODY_COMP_MEAS;
  readonly charWriteUuid = CHR_USER_CONTROL_POINT;
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_WEIGHT_MEAS, type: 'notify', optional: true },
    { uuid: CHR_BODY_COMP_MEAS, type: 'notify', optional: true },
    { uuid: CHR_USER_CONTROL_POINT, type: 'write', optional: true },
  ];
  readonly normalizesWeight = true;
  readonly completionHoldMs = BCS_WAIT_MS;
  /** UCP Consent opcode for user index 1 with consent code 0. */
  readonly unlockCommand = [0x02, 0x01, 0x00, 0x00];
  readonly unlockIntervalMs = 5000;

  /**
   * Pairs 0x2A9D with 0x2A9C and pins the scale's composition to the reading it
   * was measured with (#394): this adapter is a shared singleton and
   * `computeMetrics()` runs later than the parse.
   */
  private readonly sig = new SigMeasurementPairing();

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name && isGenericExcludedName(name)) return false;

    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    const hasBcs = uuids.some((u) => u === SVC_BODY_COMP_SHORT || u === uuid16(0x181b));
    const hasWss = uuids.some((u) => u === SVC_WEIGHT_SHORT || u === uuid16(0x181d));
    if (hasBcs || hasWss) return true;

    return KNOWN_NAMES.some((n) => name.includes(n));
  }

  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    const uuid = normalizeUuid(charUuid);
    if (uuid === CHR_WEIGHT_MEAS) return this.sig.onWeight(data);
    if (uuid === CHR_BODY_COMP_MEAS) return this.sig.onBodyComposition(data);
    return null;
  }

  /**
   * Parse a BT SIG Body Composition Measurement (0x2A9C) notification, for a
   * caller that has no characteristic to name.
   */
  parseNotification(data: Buffer): ScaleReading | null {
    return this.sig.onBodyComposition(data);
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  /** A 0x2A9C reading is the whole weigh-in; a 0x2A9D one waits for it. */
  isFinal(reading: ScaleReading): boolean {
    return this.sig.isFinal(reading);
  }

  /**
   * Clear the previous weigh-in before anything is subscribed (#394).
   *
   * The pin is what fixes the real leak. This reset covers the OTHER path: a
   * reading built outside the parsers (a direct caller, a test) has nothing
   * pinned, so computeMetrics falls back to the latest composition, which must
   * not still hold the previous person's numbers, and a 0x2A9C must not close a
   * 0x2A9D of the previous session.
   */
  onSessionStart(): void {
    this.sig.reset();
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // The scale's own composition wins whenever it measured one (review C-09):
    // it used to be thrown away for our BIA estimate as soon as the impedance
    // was plausible, so the fat in Garmin did not match the scale's display.
    // buildPayload judges it as a whole (D028) and falls back to BIA from the
    // same impedance, or the BMI estimate, when it is not a body.
    const gatt = this.sig.compositionOf(reading);
    if (gatt?.bodyFatPercent !== undefined) {
      const water =
        gatt.waterMassKg !== undefined && reading.weight > 0
          ? (gatt.waterMassKg / reading.weight) * 100
          : undefined;
      return buildPayload(
        reading.weight,
        reading.impedance,
        { fat: gatt.bodyFatPercent, water, muscle: gatt.musclePct },
        profile,
      );
    }

    // No fat from the scale. Water or muscle without the fat they were measured
    // with are not used (D028); BIA from a plausible impedance, else the BMI
    // estimate. An impedance of 0 never reaches a formula.
    const fat = biaFatIfPlausible(reading.weight, reading.impedance, profile);
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
