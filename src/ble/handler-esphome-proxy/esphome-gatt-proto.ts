import { normalizeUuid } from '../types.js';

/**
 * ESPHome encodes a GATT UUID either as a single pre-formatted string or as a
 * [high, low] pair of unsigned 64-bit halves of the 128-bit value
 * (aioesphomeapi convention). Normalize both into the project's 32-char
 * lowercase form so it compares against adapter UUIDs via the existing
 * normalizeUuid().
 *
 * The [high, low] ordering is the documented aioesphomeapi layout; if a real
 * ESP ever hands the halves reversed, swap the two reads here (this is the
 * single point of change called out as risk #2 in the design spec).
 */
export function esphomeUuidToString(uuidList?: Array<string | number | bigint>): string {
  // Defensive: @2colors/esphome-native-api pre-decodes GATT uuids into a `uuid`
  // string and drops `uuidList`, so this fallback path may be handed nothing. A
  // missing/empty list must never throw and kill the whole GATT session (#229).
  if (!uuidList || uuidList.length === 0) return '';
  if (uuidList.length === 1) {
    const only = uuidList[0];
    if (typeof only === 'string') return normalizeUuid(only);
    const v = BigInt(only);
    // <= 0xffff: 16-bit short form, pad to 4 so normalizeUuid expands it via
    // the Bluetooth base UUID. Larger: a full 128-bit value, pad to 32 (same
    // as the [high, low] path below). toString(16) drops leading zeros, so
    // the width must be restored explicitly or the UUID decodes wrong.
    const hex = v <= 0xffffn ? v.toString(16).padStart(4, '0') : v.toString(16).padStart(32, '0');
    return normalizeUuid(hex);
  }
  const mask = (1n << 64n) - 1n;
  const high = BigInt(uuidList[0]) & mask;
  const low = BigInt(uuidList[1]) & mask;
  const full = (high << 64n) | low;
  return normalizeUuid(full.toString(16).padStart(32, '0'));
}

/**
 * Minimal structural types for the connection GATT messages we consume.
 *
 * `@2colors/esphome-native-api` runs every message through `mapMessageByType()`,
 * which for the GATT services response replaces the raw `uuidList` uint64 pair
 * with a pre-decoded `uuid` string. We prefer `uuid` and keep `uuidList` as a
 * fallback in case a different library version delivers the raw shape.
 */
export interface EsphomeGattCharacteristic {
  uuid?: string;
  uuidList?: Array<string | number | bigint>;
  handle: number;
  properties: number;
}

export interface EsphomeGattService {
  uuid?: string;
  uuidList?: Array<string | number | bigint>;
  handle: number;
  characteristicsList: EsphomeGattCharacteristic[];
}

export interface EsphomeGattServicesResponse {
  address: number;
  servicesList: EsphomeGattService[];
}

export interface EsphomeNotifyData {
  address: number;
  handle: number;
  dataList: number[];
}

export interface EsphomeDeviceConnection {
  address: number;
  connected: boolean;
  mtu?: number;
  error?: number;
}
