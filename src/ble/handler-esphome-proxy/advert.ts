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

/** Build a BleDeviceInfo from an ESPHome advertisement payload. */
export function toBleDeviceInfo(ad: EsphomeBleAdvertisement): BleDeviceInfo {
  const info: BleDeviceInfo = {
    localName: ad.name || '',
    serviceUuids: (ad.serviceUuidsList ?? []).map(normalizeUuid),
  };
  const md = ad.manufacturerDataList?.[0];
  if (md) {
    const id = parseManufacturerId(md.uuid);
    const data = extractBytes(md);
    if (id != null && data.length > 0) {
      info.manufacturerData = { id, data };
    }
  }
  if (ad.serviceDataList && ad.serviceDataList.length > 0) {
    info.serviceData = ad.serviceDataList
      .map((sd) => ({ uuid: normalizeUuid(sd.uuid), data: extractBytes(sd) }))
      .filter((sd) => sd.data.length > 0);
  }
  return info;
}
