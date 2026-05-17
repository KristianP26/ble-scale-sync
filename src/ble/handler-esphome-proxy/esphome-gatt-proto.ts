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
export function esphomeUuidToString(uuidList: Array<string | number | bigint>): string {
  if (uuidList.length === 1) return normalizeUuid(String(uuidList[0]));
  const mask = (1n << 64n) - 1n;
  const high = BigInt(uuidList[0]) & mask;
  const low = BigInt(uuidList[1]) & mask;
  const full = (high << 64n) | low;
  return normalizeUuid(full.toString(16).padStart(32, '0'));
}

/** Minimal structural types for the connection GATT messages we consume. */
export interface EsphomeGattCharacteristic {
  uuidList: Array<string | number | bigint>;
  handle: number;
  properties: number;
}

export interface EsphomeGattService {
  uuidList: Array<string | number | bigint>;
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
