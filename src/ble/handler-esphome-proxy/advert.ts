import type { BleDeviceInfo } from '../../interfaces/scale-adapter.js';
import { normalizeUuid } from '../types.js';
import type { EsphomeServiceData, EsphomeBleAdvertisement } from './client.js';

/**
 * Convert a uint64 MAC (as JS number) to the canonical XX:XX:XX:XX:XX:XX form.
 * Defensive: returns a sentinel if the library ever hands us a non-numeric or
 * negative value so the caller can skip the advertisement instead of crashing.
 */
export function formatMacAddress(addr: unknown): string {
  if (typeof addr !== 'number' || !Number.isFinite(addr) || addr < 0) {
    return '00:00:00:00:00:00';
  }
  const hex = Math.trunc(addr).toString(16).padStart(12, '0');
  return (hex.match(/.{2}/g) ?? []).join(':').toUpperCase();
}

/** Inverse of formatMacAddress: "AA:BB:.." -> uint64 number for ESPHome GATT. */
export function macToInt(mac: string): number {
  return Number.parseInt(mac.replace(/[:-]/g, ''), 16);
}

/**
 * Parse the manufacturer ID from a BluetoothServiceData `uuid` field.
 * The library exposes the 16-bit company ID either as `"0xAABB"` (legacy
 * parsed path) or as a full 128-bit UUID like `"0000aabb-0000-1000-8000-...`
 * (after `ensureFullUuid`). Both are supported.
 */
export function parseManufacturerId(uuid: string): number | null {
  if (!uuid) return null;
  if (uuid.startsWith('0x')) {
    const n = Number.parseInt(uuid.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  // Full UUID: take the 16-bit segment from the first 8 hex chars
  const firstSegment = uuid.split('-')[0];
  if (!firstSegment) return null;
  const n = Number.parseInt(firstSegment, 16);
  return Number.isFinite(n) ? n : null;
}

/** Extract a manufacturer_data entry's raw bytes, preferring `legacyDataList`. */
export function extractBytes(entry: EsphomeServiceData): Buffer {
  if (entry.legacyDataList && entry.legacyDataList.length > 0) {
    return Buffer.from(entry.legacyDataList);
  }
  if (entry.data) {
    return Buffer.from(entry.data, 'base64');
  }
  return Buffer.alloc(0);
}

/**
 * True for a service or manufacturer data entry that still carries its payload.
 *
 * esphome-native-api 1.3.6 maps a legacy advertisement (proxy API older than
 * 1.9, which never gets raw advertisements) with
 * `.map(sd => sd.uuid = ensureFullUuid(sd.uuid))`. That returns the assigned
 * UUID string rather than the entry, so on such a proxy both lists arrive as
 * bare strings and the bytes are already gone before we see them (B-02).
 */
function isDataEntry(entry: unknown): entry is EsphomeServiceData {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { uuid?: unknown }).uuid === 'string'
  );
}

/**
 * Whether the library dropped the payload of any data entry in `ad` (see
 * isDataEntry). Lets the pool tell the user once, instead of a broadcast scale
 * on an old proxy just never producing a reading.
 */
export function hasLostAdvertisementData(ad: EsphomeBleAdvertisement): boolean {
  const entries: unknown[] = [...(ad.serviceDataList ?? []), ...(ad.manufacturerDataList ?? [])];
  return entries.some((e) => !isDataEntry(e));
}

/** Build a BleDeviceInfo from an ESPHome advertisement payload. */
export function toBleDeviceInfo(ad: EsphomeBleAdvertisement): BleDeviceInfo {
  const info: BleDeviceInfo = {
    localName: ad.name || '',
    address: formatMacAddress(ad.address),
    serviceUuids: (ad.serviceUuidsList ?? [])
      .filter((u): u is string => typeof u === 'string')
      .map(normalizeUuid),
  };
  const md = (ad.manufacturerDataList ?? []).find(isDataEntry);
  if (md) {
    const id = parseManufacturerId(md.uuid);
    const data = extractBytes(md);
    if (id != null && data.length > 0) {
      info.manufacturerData = { id, data };
    }
  }
  const serviceData = (ad.serviceDataList ?? []).filter(isDataEntry);
  if (serviceData.length > 0) {
    info.serviceData = serviceData
      .map((sd) => ({ uuid: normalizeUuid(sd.uuid), data: extractBytes(sd) }))
      .filter((sd) => sd.data.length > 0);
  }
  return info;
}
