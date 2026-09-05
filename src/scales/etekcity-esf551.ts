import type {
  BleDeviceInfo,
  BodyComposition,
  CharacteristicBinding,
  GattWiring,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, computeBiaFat } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';

// ─── Etekcity ESF-551 Smart Fitness Scale (FFF0 vendor service) ──────────────

const SVC_FFF0 = uuid16(0xfff0);
const CHR_NOTIFY = uuid16(0xfff1);
const CHR_WRITE = uuid16(0xfff2);

/**
 * Measurement frame, 22 bytes, notified on FFF1.
 *
 *   [0-1]   a5 02        protocol marker
 *   [2]     sequence, increments once per frame and wraps
 *   [3-4]   10 00        payload length, 16
 *   [5]     checksum
 *   [6-9]   01 61 a1 00  fixed, part of the frame signature
 *   [10-12] weight, 24-bit LITTLE-endian, in grams
 *   [13-14] impedance, uint16 LE, ohms
 *   [19]    1 once the scale has settled; 0 for every frame before that
 *   [20]    1 when the impedance field is populated
 *   [21]    display unit: 0 kg, 1 lb, 2 st
 *
 * The weight is grams regardless of what the scale is displaying, so
 * `normalizesWeight` holds and the display unit is only logged.
 *
 * Decoded from the debug log in #385 (Etekcity Smart Fitness Scale,
 * D0:4D:00:43:40:BD, a full weigh-in from first contact to the settled frame)
 * and cross-checked field by field against the independent implementation in
 * https://github.com/ronnnnnnnnnnnnn/etekcity_esf551_ble (MIT), whose
 * `esf551/protocol.py` gates on exactly the same signature bytes.
 *
 * Reading the capture alone would have got the weight wrong: bytes [10-11]
 * settle at 0x1b52, which divides by 100 into a plausible 69.94 kg. It is
 * really a 24-bit field, 0x011b52 = 72530 g = 72.53 kg, and byte [12] only
 * stops looking like padding once someone weighs more than 65.5 kg.
 */
const FRAME_LEN = 22;
const WEIGHT_OFFSET = 10;
const IMPEDANCE_OFFSET = 13;
const SETTLED_OFFSET = 19;
const IMPEDANCE_VALID_OFFSET = 20;
const DISPLAY_UNIT_OFFSET = 21;
const WEIGHT_DIV = 1000;

/** Plausible human weight, kg. Guards a garbled frame, not a light user. */
const WEIGHT_MIN_KG = 2;
const WEIGHT_MAX_KG = 250;

const DISPLAY_UNITS: Record<number, string> = { 0: 'kg', 1: 'lb', 2: 'st' };

/** True when the frame carries this protocol's fixed signature bytes. */
function isMeasurementFrame(d: Buffer): boolean {
  return (
    d.length === FRAME_LEN &&
    d[0] === 0xa5 &&
    d[1] === 0x02 &&
    d[3] === 0x10 &&
    d[4] === 0x00 &&
    d[6] === 0x01 &&
    d[7] === 0x61 &&
    d[8] === 0xa1 &&
    d[9] === 0x00
  );
}

/**
 * Etekcity ESF-551 Smart Fitness Scale.
 *
 * MATCHED ON THE ADVERTISED NAME ONLY, deliberately. The unit exposes a bare
 * FFF0 service with FFF1 notify and FFF2 write, which is the same shape as the
 * Inlife and 1byone/Eufy families, and claiming that shape would take devices
 * away from them. It does advertise "Etekcity Smart Fitness Scale" in the clear
 * on every advertisement in the #385 capture, so the name is enough.
 *
 * The priority sits above Inlife (90) because Inlife's post-discovery rule is
 * "has FFF2 and not FFF4", which an ESF-551 satisfies: without this it is
 * claimed by Inlife, whose handshake it ignores, and the session ends on the
 * read timeout with no reading (#385).
 *
 * The scale streams settling frames continuously, several per second, with
 * byte [19] clear. Only the settled frame is a reading. There is no handshake:
 * subscribing to FFF1 is enough, which is why no `onConnected` is needed.
 */
export class EtekcityEsf551Adapter implements ScaleAdapterCore, GattWiring {
  readonly name = 'Etekcity ESF-551';
  readonly match: MatchDescriptor = {
    // Above Inlife (90), which otherwise claims this device on the shared FFF0
    // service plus an FFF2 write characteristic. 95 is taken by Koogeek-S1 and
    // priorities must be unique (registry-check), so 96.
    priority: 96,
    custom: true,
    names: { includes: ['etekcity'] },
    serviceUuids: ['fff0'],
    charUuids: ['fff1'],
  };
  readonly charNotifyUuid = CHR_NOTIFY;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;

  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_NOTIFY, type: 'notify' },
    { uuid: CHR_WRITE, type: 'write', optional: true },
  ];

  /** Log the display unit once per session rather than once per frame. */
  private loggedUnit = false;

  matches(device: BleDeviceInfo): boolean {
    return (device.localName || '').toLowerCase().includes('etekcity');
  }

  onSessionEnd(): void {
    this.loggedUnit = false;
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (!isMeasurementFrame(data)) return null;

    if (!this.loggedUnit) {
      this.loggedUnit = true;
      const raw = data[DISPLAY_UNIT_OFFSET];
      bleLog.debug(
        `Etekcity: scale is displaying ${DISPLAY_UNITS[raw] ?? `0x${raw.toString(16)}`}`,
      );
    }

    // Settling frames carry a live weight the scale has not committed to.
    if (data[SETTLED_OFFSET] !== 1) return null;

    const grams = data.readUIntLE(WEIGHT_OFFSET, 3);
    const weight = grams / WEIGHT_DIV;
    if (weight < WEIGHT_MIN_KG || weight > WEIGHT_MAX_KG || !Number.isFinite(weight)) return null;

    // Byte [20] is the scale's own "the impedance field means something" flag.
    // A barefoot weigh-in sets it; socks or a quick step-off leave it clear and
    // the field holds a stale zero.
    const impedance = data[IMPEDANCE_VALID_OFFSET] === 1 ? data.readUInt16LE(IMPEDANCE_OFFSET) : 0;

    bleLog.debug(`Etekcity: ${weight.toFixed(2)} kg / ${impedance} Ohm (settled)`);
    return { weight, impedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight >= WEIGHT_MIN_KG && reading.weight <= WEIGHT_MAX_KG;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // The raw impedance goes through the shared BIA estimator, the same way
    // Hutbit and Koogeek do it. Passing it to buildPayload without computing a
    // fat percentage first would silently fall back to the BMI estimate (#386).
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}

export { SVC_FFF0 as _SVC_FFF0 };
