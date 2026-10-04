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
import { buildPayload } from './body-comp-helpers.js';
import { SigMeasurementPairing } from './sig-bcs.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { normalizeUuid } from '../ble/types.js';

// Standard SIG characteristics (inherited from openScale's
// StandardWeightProfileHandler, which subscribes both measurements).
const CHR_WEIGHT_MEAS = '00002a9d00001000800000805f9b34fb';
const CHR_BODY_COMP_MEAS = '00002a9c00001000800000805f9b34fb';
const CHR_USER_CONTROL_POINT = '00002a9f00001000800000805f9b34fb';

/** How long a 0x2A9D weight waits for the 0x2A9C that follows it. */
const BCS_WAIT_MS = 5000;

/**
 * Adapter for Sanitas SBF72 / SBF73 scales.
 *
 * **Limitation:** Uses hardcoded UCP consent for user index 1. The scale must
 * have user slot 1 configured via the manufacturer's official app before use.
 *
 * Protocol ported from openScale's SanitasSbf72Handler which extends
 * StandardWeightProfileHandler: standard Weight Measurement (0x2A9D) and Body
 * Composition Measurement (0x2A9C), plus a custom service (0xFFFF) for user
 * management. Both measurements are subscribed and paired into one weigh-in
 * (SigMeasurementPairing): the weight is mandatory only in 0x2A9D, and both
 * carry the SIG Time Stamp of a stored record (review C-02, C-05).
 *
 * The Beurer BF915 used to be claimed here by name. It needs a bonded link, a
 * per-device consent code and the right user slot, none of which this adapter
 * provides, and delivers its weight on 0x2A9D (#335, #417), so it belongs to
 * BeurerBf720Adapter (review C-07).
 *
 * Unlock writes the User Control Point consent `02 01 00 00` (user index 1,
 * consent code 0) every 5 s.
 */
export class SanitasSbf72Adapter
  implements ScaleAdapterCore, GattWiring, MultiCharNotify, HoldForComposition, Unlockable
{
  readonly name = 'Sanitas SBF72/73';
  readonly match: MatchDescriptor = {
    priority: 170,
    names: { includes: ['sbf72', 'sbf73'] },
  };
  readonly charNotifyUuid = CHR_BODY_COMP_MEAS;
  readonly charWriteUuid = CHR_USER_CONTROL_POINT;
  // 0x2A9C and the consent characteristic stay required, as they were when this
  // adapter read 0x2A9C alone; 0x2A9D is added without making it a new
  // requirement.
  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_WEIGHT_MEAS, type: 'notify', optional: true },
    { uuid: CHR_BODY_COMP_MEAS, type: 'notify' },
    { uuid: CHR_USER_CONTROL_POINT, type: 'write' },
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
    return matchesDescriptor(device, this.match);
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
   * not still hold the previous person's numbers.
   */
  onSessionStart(): void {
    this.sig.reset();
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const gatt = this.sig.compositionOf(reading);
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
