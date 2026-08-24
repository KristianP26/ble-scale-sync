import type {
  BleDeviceInfo,
  BodyComposition,
  BroadcastSource,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { buildPayload, normalizeServiceUuid, uuid16 } from './body-comp-helpers.js';
import type { MatchDescriptor } from './match-descriptor.js';

const SVC_WEIGHT_SCALE = uuid16(0x181d);
const HUAMI_COMPANY_ID = 0x0157;
const FRAME_LENGTH = 10;
const WEIGHT_MIN = 10;
/** Advertised local name, upper-cased. Exact: 'MI SCALE' prefixes belong to MiScale2Adapter. */
const LOCAL_NAME = 'MI SCALE2';

/**
 * Xiaomi Mi Smart Scale 2 legacy variant (XMTZC04HM / MI SCALE2).
 *
 * This is deliberately separate from MiScale2Adapter: it broadcasts a standard
 * 10-byte Weight Scale Service (0x181D) measurement, contains no impedance,
 * and is complete as soon as its stable flag is set. Native transports may
 * expose only the exact MI SCALE2 name before connection; nameless frames use
 * the company-id plus exact frame-length gate to avoid unrelated WSS scales.
 */
export class XiaomiMiScaleLegacyAdapter implements ScaleAdapterCore, BroadcastSource {
  readonly name = 'Xiaomi Mi Smart Scale 2 (XMTZC04HM)';
  readonly match: MatchDescriptor = {
    priority: 215,
    custom: true,
    names: { exact: ['mi scale2'] },
    serviceUuids: ['181d'],
    manufacturerId: HUAMI_COMPANY_ID,
  };
  readonly normalizesWeight = true;
  readonly preferPassive = true;

  matches(device: BleDeviceInfo): boolean {
    // BlueZ exposes neither service data nor manufacturer data before a
    // connection, so the node-ble MAC-pinned and auto-discovery paths match on
    // the name alone. Without this branch they resolve to MiScale2Adapter,
    // which no longer parses 0x181D, and the passive scan never yields a
    // reading. Exact, because MiScale2Adapter owns the 'mi scale' prefix.
    if ((device.localName || '').toUpperCase() === LOCAL_NAME) return true;

    return (
      device.manufacturerData?.id === HUAMI_COMPANY_ID &&
      (device.serviceData ?? []).some(
        (sd) =>
          normalizeServiceUuid(sd.uuid) === SVC_WEIGHT_SCALE && sd.data.length === FRAME_LENGTH,
      )
    );
  }

  parseNotification(): ScaleReading | null {
    return null;
  }

  parseServiceData(uuid: string, data: Buffer): ScaleReading | null {
    if (normalizeServiceUuid(uuid) !== SVC_WEIGHT_SCALE || data.length !== FRAME_LENGTH)
      return null;

    // Weight Scale Measurement flags: bit 0 = lb, bit 1 = timestamp present,
    // bit 4 = catty/jin, bit 5 = stable, bit 7 = removed/no current measurement.
    const flags = data[0];
    const stable = (flags & 0x20) !== 0;
    const removed = (flags & 0x80) !== 0;
    if (!stable || removed) return null;

    const rawWeight = data.readUInt16LE(1);
    if (rawWeight === 0) return null;

    const isLbs = (flags & 0x01) !== 0;
    const isCatty = (flags & 0x10) !== 0;
    const weight = isLbs
      ? (rawWeight / 100) * 0.45359237
      : isCatty
        ? (rawWeight / 100) * 0.5
        : rawWeight / 200;

    // Bytes 3..9 contain the Weight Scale Service timestamp. The scale puts it
    // on live frames too, while ScaleReading.timestamp means a historical cache
    // replay to the runtime, so it must remain unset until replay semantics are known.
    return { weight, impedance: 0 };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > WEIGHT_MIN;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    return buildPayload(reading.weight, 0, {}, profile);
  }
}
