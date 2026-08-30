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
import {
  FC_ENCRYPTED,
  FC_OBJECT_INCLUDED,
  SVC_FE95,
  decryptMiBeaconV5,
  iterateMiBeaconObjects,
  macFrameOrderFromAddress,
  macFrameOrderFromFrame,
  miBeaconPayloadOffset,
  miBeaconProductId,
  normUuid,
} from './mibeacon.js';

/**
 * MiBeacon product ids the S400 family advertises. Three ids are seen on the
 * MJTZC01YM (S400, yunmai.scales.ms103 / ms104, pdid 12505 = 0x30d9) across
 * regions / firmware; 0x4b05 is the MJTZC03YM sibling. Ids and object layout
 * follow Home Assistant's xiaomi-ble (https://github.com/Bluetooth-Devices/xiaomi-ble).
 */
export const S400_PIDS: ReadonlySet<number> = new Set([0x30d9, 0x3bd5, 0x48cf, 0x4b05]);

/** MiBeacon object id carrying the S400 weigh-in measurement (9-byte value). */
export const OBJ_S400_MEASUREMENT = 0x6e16;

/** Plausible human-weight gate (kg). */
const WEIGHT_MIN = 10;
const WEIGHT_MAX = 250;

/** Heart-rate field is an offset from 50 bpm; 0 and 127 mean "absent". */
const HEART_RATE_BASE = 50;

/** What one decoded 0x6e16 object says. */
export type S400MeasurementKind =
  /** Weight (plus 50 kHz impedance and heart rate when measured barefoot). */
  | 'weight'
  /** Final frame of a barefoot weigh-in: 250 kHz impedance only. */
  | 'impedance-high'
  /** All fields zero: the person stepped off. */
  | 'reset';

export interface S400Measurement {
  kind: S400MeasurementKind;
  /** Mi Home user slot the scale assigned the reading to. */
  profileId: number;
  /** Weight in kg; 0 on impedance-high and reset frames. */
  weight: number;
  /** Impedance in ohms (50 kHz on weight frames, 250 kHz on impedance-high); 0 when absent. */
  impedance: number;
  /** Heart rate in bpm, or null when the scale did not measure one. */
  heartRate: number | null;
  /** Scale clock at measurement time, Unix seconds. */
  timestamp: number;
}

/**
 * Decode the 9-byte 0x6e16 value: `profile(1) | packed(4 LE) | timestamp(4 LE)`.
 * `packed` holds three bit fields: bits 0-10 weight (0.1 kg), bits 11-17
 * heart rate (bpm - 50), bits 18-31 impedance (0.1 ohm). Layout per the `obj6e16`
 * parser in Home Assistant's xiaomi-ble library (Apache-2.0),
 * https://github.com/Bluetooth-Devices/xiaomi-ble. Returns null when the value is too short.
 */
export function decodeS400Measurement(value: Buffer): S400Measurement | null {
  if (value.length < 9) return null;
  const profileId = value[0];
  const packed = value.readUInt32LE(1);
  const timestamp = value.readUInt32LE(5);
  const massRaw = packed & 0x7ff;
  const hrRaw = (packed >>> 11) & 0x7f;
  const impedanceRaw = packed >>> 18;

  const weight = massRaw / 10;
  const impedance = impedanceRaw / 10;
  const heartRate = hrRaw > 0 && hrRaw < 127 ? hrRaw + HEART_RATE_BASE : null;

  let kind: S400MeasurementKind;
  if (massRaw === 0 && hrRaw === 0 && impedanceRaw === 0) kind = 'reset';
  else if (massRaw === 0 && hrRaw === 0) kind = 'impedance-high';
  else kind = 'weight';

  return { kind, profileId, weight, impedance, heartRate, timestamp };
}

/**
 * Xiaomi Body Composition Scale S400 (MJTZC01YM, made by Yunmai).
 *
 * Broadcast-only adapter. The S400 is a "sleepy" MiBeacon v5 device: it only
 * advertises while someone stands on it, in service data 0xFE95, and encrypts
 * the measurement under a per-device bind key from the Mi cloud (`ble.bind_key`,
 * same as the S800). A barefoot weigh-in produces two encrypted frames: weight
 * + 50 kHz impedance (+ heart rate), then 250 kHz impedance alone; with socks
 * only the weight frame follows, and an all-zero frame marks stepping off.
 *
 * The weight frame is the reading: its 50 kHz impedance is what the shared BIA
 * pipeline expects, so body composition is computed from real impedance. The
 * 250 kHz value and the heart rate have no field in `ScaleReading` and are
 * only logged.
 *
 * Measurement frames omit the MAC (FC 0x5948) although the CCM nonce needs it.
 * The unencrypted idle beacon (FC 0x5a30) does carry it, so it is cached from
 * there; `ble.scale_mac` is the fallback when no idle beacon was seen.
 */
export class XiaomiS400Adapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'Xiaomi Body Composition Scale S400';
  readonly match: MatchDescriptor = {
    priority: 205,
    // Shares the FE95 service with the S800; the product id in the service
    // data keeps the two apart, which the descriptor cannot express.
    custom: true,
    names: { includes: ['scale s400'] },
    serviceUuids: ['fe95'],
  };
  // Broadcast-only: no GATT characteristics. preferPassive forces the broadcast
  // path even though the scale is connectable.
  readonly normalizesWeight = true;
  readonly preferPassive = true;

  private bindKey: Buffer | null = null;
  /** `ble.scale_mac` in frame byte order, the nonce fallback. */
  private configuredMac: Buffer | null = null;
  /** Real device MAC (frame byte order) cached from a MAC-included frame. */
  private cachedMac: Buffer | null = null;
  private warnedNoKey = false;
  private warnedNoMac = false;
  private warnedBadDecrypt = false;
  /** Frame counter of the last frame logged, so repeats of one advert log once. */
  private lastLoggedCounter: number | null = null;

  configure(opts: AdapterRuntimeConfig): void {
    this.bindKey =
      opts.bindKey && /^[0-9a-fA-F]{32}$/.test(opts.bindKey)
        ? Buffer.from(opts.bindKey, 'hex')
        : null;
    this.configuredMac = opts.scaleMac ? macFrameOrderFromAddress(opts.scaleMac) : null;
  }

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name.includes('scale s400')) return true;
    for (const sd of device.serviceData ?? []) {
      if (normUuid(sd.uuid) === SVC_FE95 && this.isS400Frame(sd.data)) return true;
    }
    return false;
  }

  private isS400Frame(data: Buffer): boolean {
    const pid = miBeaconProductId(data);
    return pid !== null && S400_PIDS.has(pid);
  }

  parseServiceData(uuid: string, data: Buffer): ScaleReading | null {
    if (normUuid(uuid) !== SVC_FE95 || !this.isS400Frame(data)) return null;
    const fc = data.readUInt16LE(0);

    // Cache the real MAC from any MAC-included frame (the idle beacon) so the
    // MAC-omitted measurement frames can build the AES-CCM nonce.
    const frameMac = macFrameOrderFromFrame(data);
    if (frameMac) this.cachedMac = Buffer.from(frameMac);

    // Idle beacon: no object. Nothing to decode.
    if ((fc & FC_OBJECT_INCLUDED) === 0) return null;

    let payload: Buffer | null;
    if ((fc & FC_ENCRYPTED) !== 0) {
      if (!this.bindKey) {
        if (!this.warnedNoKey) {
          this.warnedNoKey = true;
          bleLog.warn(
            'Xiaomi S400 detected but ble.bind_key is not configured; cannot decode weight',
          );
        }
        return null;
      }
      const mac = frameMac ?? this.configuredMac ?? this.cachedMac;
      if (!mac) {
        if (!this.warnedNoMac) {
          this.warnedNoMac = true;
          bleLog.warn(
            'Xiaomi S400 frame received before its MAC is known; set ble.scale_mac so ' +
              'measurements decrypt without waiting for an idle beacon',
          );
        }
        return null;
      }
      payload = decryptMiBeaconV5(data, this.bindKey, mac);
      if (!payload) {
        if (!this.warnedBadDecrypt) {
          this.warnedBadDecrypt = true;
          bleLog.warn('Xiaomi S400 frame failed to decrypt; check ble.bind_key and ble.scale_mac');
        }
        return null;
      }
      this.warnedBadDecrypt = false;
    } else {
      const offset = miBeaconPayloadOffset(data);
      if (offset === null) return null;
      payload = data.subarray(offset);
    }

    for (const obj of iterateMiBeaconObjects(payload)) {
      if (obj.id !== OBJ_S400_MEASUREMENT) continue;
      const m = decodeS400Measurement(obj.value);
      if (!m) continue;
      return this.toReading(m, data[4]);
    }
    return null;
  }

  private toReading(m: S400Measurement, counter: number): ScaleReading | null {
    const logOnce = this.lastLoggedCounter !== counter;
    this.lastLoggedCounter = counter;

    if (m.kind === 'reset') {
      if (logOnce) bleLog.debug('Xiaomi S400: person stepped off');
      return null;
    }
    if (m.kind === 'impedance-high') {
      if (logOnce) {
        bleLog.debug(`Xiaomi S400: 250 kHz impedance ${m.impedance} ohm (profile ${m.profileId})`);
      }
      return null;
    }
    if (m.weight < WEIGHT_MIN || m.weight > WEIGHT_MAX) return null;
    if (logOnce) {
      const hr = m.heartRate !== null ? `, heart rate ${m.heartRate} bpm` : '';
      const z = m.impedance > 0 ? `, 50 kHz impedance ${m.impedance} ohm` : ', no impedance';
      bleLog.info(`Xiaomi S400: ${m.weight} kg${z}${hr} (profile ${m.profileId})`);
    }
    return { weight: m.weight, impedance: m.impedance };
  }

  // Broadcast-only: no GATT notifications.
  parseNotification(): ScaleReading | null {
    return null;
  }

  isComplete(reading: ScaleReading): boolean {
    // The weight frame already carries the 50 kHz impedance when there is one;
    // a socks weigh-in legitimately has none, so weight alone completes.
    return reading.weight >= WEIGHT_MIN && reading.weight <= WEIGHT_MAX;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
