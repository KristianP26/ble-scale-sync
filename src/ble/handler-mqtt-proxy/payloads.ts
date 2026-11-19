import { isMacAddress } from '../scale-id.js';
import {
  MAX_PEER_JSON_BYTES,
  MAX_PEER_OBJECT_BYTES,
  isPlainObject,
  parsePeerArray,
  parsePeerObject,
} from '../peer-input.js';

/**
 * Shape checks for what the ESP32 proxy publishes (ADR D108). The shapes come
 * from the firmware (`ble_bridge.py`, `main.py`); anything else on these topics
 * is not from it. The checks are per item and soft: one bad entry is dropped
 * and counted, the rest of the batch is used.
 */

/** A batch is at most 500 entries from the firmware; double that is already not a proxy. */
export const MAX_SCAN_ENTRIES = 1000;
/** Characteristics of one connected device. */
export const MAX_CONNECTED_CHARS = 256;
const MAX_NAME_CHARS = 256;
const MAX_SERVICES = 64;
const MAX_SERVICE_DATA = 32;
/** The UUIDs come from services and the like; the long forms are 36 characters. */
const SERVICE_UUID_RE = /^[0-9A-Za-z{}-]{1,40}$/;
/** A char UUID goes into MQTT topic names, so it must not hold `#`, `+` or `/`. */
const CHAR_UUID_RE = /^[0-9a-fA-F-]{4,36}$/;

export interface ScanResultEntry {
  address: string;
  name: string;
  rssi: number;
  services: string[];
  addr_type?: number;
  manufacturer_id?: number | null;
  manufacturer_data?: string | null;
  /** Array of {uuid, data} service-data entries (hex-encoded data). */
  service_data?: Array<{ uuid: string; data: string }> | null;
}

export interface ConnectedChar {
  uuid: string;
  properties: string[];
}

export interface ConnectedPayload {
  autonomous: boolean;
  /** A MAC; always present when `autonomous`. */
  address?: string;
  chars: ConnectedChar[];
}

function validEntry(raw: unknown): ScanResultEntry | null {
  if (!isPlainObject(raw) || !isMacAddress(raw.address)) return null;
  const entry: ScanResultEntry = {
    address: raw.address,
    name: typeof raw.name === 'string' ? raw.name.slice(0, MAX_NAME_CHARS) : '',
    rssi: typeof raw.rssi === 'number' && Number.isFinite(raw.rssi) ? raw.rssi : 0,
    services: Array.isArray(raw.services)
      ? raw.services
          .filter((s): s is string => typeof s === 'string' && SERVICE_UUID_RE.test(s))
          .slice(0, MAX_SERVICES)
      : [],
  };
  const addrType = raw.addr_type;
  if (
    typeof addrType === 'number' &&
    Number.isInteger(addrType) &&
    addrType >= 0 &&
    addrType <= 255
  ) {
    entry.addr_type = addrType;
  }
  const mfrId = raw.manufacturer_id;
  entry.manufacturer_id =
    typeof mfrId === 'number' && Number.isInteger(mfrId) && mfrId >= 0 && mfrId <= 0xffff
      ? mfrId
      : null;
  entry.manufacturer_data =
    typeof raw.manufacturer_data === 'string' ? raw.manufacturer_data : null;
  if (Array.isArray(raw.service_data)) {
    entry.service_data = raw.service_data
      .filter(
        (sd): sd is { uuid: string; data: string } =>
          isPlainObject(sd) && typeof sd.uuid === 'string' && typeof sd.data === 'string',
      )
      .slice(0, MAX_SERVICE_DATA)
      .map((sd) => ({ uuid: sd.uuid, data: sd.data }));
  } else {
    entry.service_data = null;
  }
  return entry;
}

export type ScanResultsParse =
  | { ok: true; entries: ScanResultEntry[]; total: number; dropped: number }
  | { ok: false; why: string };

/** Parse a `scan/results` payload: a JSON array of entries, each checked on its own. */
export function parseScanResults(raw: Buffer | string): ScanResultsParse {
  const parsed = parsePeerArray(raw, MAX_PEER_JSON_BYTES);
  if (!parsed.ok) return parsed;
  if (parsed.value.length > MAX_SCAN_ENTRIES) {
    return { ok: false, why: `too many entries (${parsed.value.length})` };
  }
  const entries: ScanResultEntry[] = [];
  for (const item of parsed.value) {
    const entry = validEntry(item);
    if (entry) entries.push(entry);
  }
  return {
    ok: true,
    entries,
    total: parsed.value.length,
    dropped: parsed.value.length - entries.length,
  };
}

export type ConnectedParse = { ok: true; value: ConnectedPayload } | { ok: false; why: string };

/**
 * Parse a `connected` payload. The characteristic list is required; a
 * characteristic that is not `{uuid, properties}` with a topic-safe uuid is
 * dropped. An autonomous connect without a valid MAC is refused outright.
 */
export function parseConnectedPayload(raw: Buffer | string): ConnectedParse {
  const parsed = parsePeerObject(raw, MAX_PEER_OBJECT_BYTES);
  if (!parsed.ok) return parsed;
  const data = parsed.value;
  const autonomous = Boolean(data.autonomous);
  const address = isMacAddress(data.address) ? data.address : undefined;
  if (autonomous && address === undefined) {
    return { ok: false, why: 'autonomous connect without a valid address' };
  }
  if (!Array.isArray(data.chars)) return { ok: false, why: 'no chars array' };
  if (data.chars.length > MAX_CONNECTED_CHARS) {
    return { ok: false, why: `too many chars (${data.chars.length})` };
  }
  const chars: ConnectedChar[] = [];
  for (const c of data.chars) {
    if (!isPlainObject(c) || typeof c.uuid !== 'string' || !CHAR_UUID_RE.test(c.uuid)) continue;
    chars.push({
      uuid: c.uuid,
      properties: Array.isArray(c.properties)
        ? c.properties.filter((p): p is string => typeof p === 'string').slice(0, 16)
        : [],
    });
  }
  return { ok: true, value: { autonomous, ...(address ? { address } : {}), chars } };
}
