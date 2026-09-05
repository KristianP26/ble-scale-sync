import type {
  AdapterRuntimeConfig,
  BleDeviceInfo,
  BodyComposition,
  ScaleAdapterCore,
  BroadcastSource,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { buildPayload, computeBiaFat } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';
import { SVC_FE95, decryptMiBeaconV5, macFrameOrderFromFrame, normUuid } from './mibeacon.js';

// The MiBeacon frame helpers live in ./mibeacon.ts, shared with the S400
// adapter. Re-exported so existing imports of this module keep working.
export { decryptMiBeaconV5, macFrameOrderFromFrame } from './mibeacon.js';

/** Product id of the Mijia Scale S800 (xiaomi.scales.ms116, pdid 20962). */
export const S800_PID = 0x51e2;

/** MiBeacon object id carrying the weigh-in measurement (9-byte value). */
const OBJ_MEASUREMENT = 0x4e16;

/** Plausible human-weight gate (kg) for the decoded trailing uint16. */
const WEIGHT_MIN = 10;
const WEIGHT_MAX = 250;

/**
 * Parse a decrypted MiBeacon object TLV. Returns a weight reading when it is the
 * 0x4e16 measurement object whose trailing uint16 LE / 100 is a plausible weight,
 * else null (idle 0x5201, wrong object, or a non-weight rich frame).
 */
export function parseS800Object(decrypted: Buffer): ScaleReading | null {
  if (decrypted.length < 3) return null;
  const type = decrypted.readUInt16LE(0);
  const len = decrypted[2];
  if (type !== OBJ_MEASUREMENT || len < 9 || decrypted.length < 3 + len) return null;
  const value = decrypted.subarray(3, 3 + len);
  const weight = value.readUInt16LE(7) / 100;
  if (weight < WEIGHT_MIN || weight > WEIGHT_MAX) return null;
  return { weight, impedance: 0 };
}

/**
 * Xiaomi Mijia 8-electrode Body Composition Scale S800 (xiaomi.scales.ms116).
 *
 * Broadcast-only adapter. The S800 advertises encrypted MiBeacon v5 in service
 * data 0xFE95; the weigh-in object 0x4e16 carries weight (uint16 LE / 100). The
 * frames are AES-CCM encrypted under a per-device bind key from the Mi cloud,
 * configured as `ble.bind_key`. The full segmental body composition is only on
 * the encrypted Mi-auth GATT path (per-user token) and is out of scope; weight
 * plus the user profile drives the existing body-composition pipeline (#232).
 */
export class XiaomiS800Adapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'Xiaomi Mijia Scale S800';
  readonly match: MatchDescriptor = {
    priority: 200,
    custom: true,
    names: { includes: ['mijia scale s800'] },
    serviceUuids: ['fe95'],
  };
  // Broadcast-only: no GATT characteristics. preferPassive forces the broadcast
  // path even though the scale is connectable.
  readonly normalizesWeight = true;
  readonly preferPassive = true;

  private bindKey: Buffer | null = null;
  /** Real device MAC (frame byte order) cached from a MAC-included frame. */
  private cachedMac: Buffer | null = null;
  private warnedNoKey = false;

  configure(opts: AdapterRuntimeConfig): void {
    this.bindKey =
      opts.bindKey && /^[0-9a-fA-F]{32}$/.test(opts.bindKey)
        ? Buffer.from(opts.bindKey, 'hex')
        : null;
  }

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name.includes('mijia scale s800')) return true;
    for (const sd of device.serviceData ?? []) {
      if (
        normUuid(sd.uuid) === SVC_FE95 &&
        sd.data.length >= 4 &&
        sd.data.readUInt16LE(2) === S800_PID
      ) {
        return true;
      }
    }
    return false;
  }

  parseServiceData(uuid: string, data: Buffer): ScaleReading | null {
    if (normUuid(uuid) !== SVC_FE95) return null;
    if (data.length >= 4 && data.readUInt16LE(2) !== S800_PID) return null;

    // Cache the real MAC from any MAC-included frame so MAC-omitted rich frames
    // (FC 0x5948) can build the AES-CCM nonce.
    const frameMac = macFrameOrderFromFrame(data);
    if (frameMac) this.cachedMac = Buffer.from(frameMac);

    if (!this.bindKey) {
      if (!this.warnedNoKey) {
        this.warnedNoKey = true;
        bleLog.warn(
          'Xiaomi S800 detected but ble.bind_key is not configured; cannot decode weight',
        );
      }
      return null;
    }

    const mac = frameMac ?? this.cachedMac;
    if (!mac) return null; // no MAC seen yet this session
    const decrypted = decryptMiBeaconV5(data, this.bindKey, mac);
    if (!decrypted) return null;
    return parseS800Object(decrypted);
  }

  // Broadcast-only: no GATT notifications.
  parseNotification(): ScaleReading | null {
    return null;
  }

  isComplete(reading: ScaleReading): boolean {
    // Broadcast weight has impedance 0; accept any plausible weight.
    return reading.weight > WEIGHT_MIN;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
