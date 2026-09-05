import { createDecipheriv } from 'node:crypto';
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

/** Xiaomi MiService advertisement service UUID (normalized 32-char form). */
const SVC_FE95 = '0000fe9500001000800000805f9b34fb';

/** Product id of the Mijia Scale S800 (xiaomi.scales.ms116, pdid 20962). */
export const S800_PID = 0x51e2;

/** MiBeacon frame-control bits. */
const FC_ENCRYPTED = 0x08;
const FC_MAC_INCLUDED = 0x10;

/** MiBeacon object id carrying the weigh-in measurement (9-byte value). */
const OBJ_MEASUREMENT = 0x4e16;

/** Plausible human-weight gate (kg) for the decoded trailing uint16. */
const WEIGHT_MIN = 10;
const WEIGHT_MAX = 250;

/** Normalize a service-data UUID (short, dashed, or 128-bit) to 32-char hex. */
function normUuid(uuid: string): string {
  const s = uuid.toLowerCase().replace(/[-{}]/g, '');
  if (s.length === 4) return `0000${s}00001000800000805f9b34fb`;
  if (s.length === 8) return `${s}00001000800000805f9b34fb`;
  return s;
}

/** Return the 6-byte frame-order MAC if the FE95 frame includes it, else null. */
export function macFrameOrderFromFrame(data: Buffer): Buffer | null {
  if (data.length < 11) return null;
  const fc = data.readUInt16LE(0);
  if ((fc & FC_MAC_INCLUDED) === 0) return null;
  return data.subarray(5, 11);
}

/**
 * Decrypt a MiBeacon v5 FE95 advertisement. Returns the decrypted object TLV
 * (`type(2 LE) | len | value`) or null when the frame is unencrypted, malformed,
 * or fails the AES-CCM tag (wrong key / wrong MAC).
 *
 * Layout: FC(2 LE) | PID(2) | cnt(1) | [MAC(6) if FC&0x10] | cipher | extCnt(3) | MIC(4).
 * nonce = macFrameOrder(6) || data[2..5) || extCnt(3); AAD = 0x11; tag = 4 bytes.
 */
export function decryptMiBeaconV5(
  data: Buffer,
  bindKey: Buffer,
  macFrameOrder: Buffer,
): Buffer | null {
  if (data.length < 12 || bindKey.length !== 16 || macFrameOrder.length !== 6) return null;
  const fc = data.readUInt16LE(0);
  if ((fc & FC_ENCRYPTED) === 0) return null;
  const cipherStart = (fc & FC_MAC_INCLUDED) !== 0 ? 11 : 5;
  if (data.length < cipherStart + 7) return null;
  const cipher = data.subarray(cipherStart, data.length - 7);
  const extCnt = data.subarray(data.length - 7, data.length - 4);
  const mic = data.subarray(data.length - 4);
  const nonce = Buffer.concat([macFrameOrder, data.subarray(2, 5), extCnt]);
  try {
    const dec = createDecipheriv('aes-128-ccm', bindKey, nonce, { authTagLength: 4 });
    dec.setAuthTag(mic);
    dec.setAAD(Buffer.from([0x11]), { plaintextLength: cipher.length });
    return Buffer.concat([dec.update(cipher), dec.final()]);
  } catch {
    return null;
  }
}

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
