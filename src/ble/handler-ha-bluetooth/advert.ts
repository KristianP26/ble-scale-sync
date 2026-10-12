import type { BleDeviceInfo } from '../../interfaces/scale-adapter.js';
import { normalizeUuid } from '../types.js';

/**
 * One entry of the `add` list in a `bluetooth/subscribe_advertisements` event,
 * as serialised by Home Assistant (`serialize_service_info`). `manufacturer_data`
 * and `service_data` are hex strings keyed by decimal company id / full UUID and
 * are aggregated by HA across advertisements; `raw` is the latest packet only.
 */
export interface HaAdvertisement {
  name: string;
  address: string;
  rssi: number;
  manufacturer_data: Record<string, string>;
  service_data: Record<string, string>;
  service_uuids: string[];
  /** Scanner that heard it (adapter MAC, ESPHome/SLZB device id, ...). */
  source: string;
  connectable: boolean;
  /**
   * Unix seconds (float) when HA last heard the device: HA's monotonic receive
   * time plus the wall-clock offset HA took when this subscription started. In
   * the subscribe snapshot that can be minutes ago; in a live event it is the
   * time of that advertisement.
   */
  time: number;
  tx_power?: number | null;
  raw?: string | null;
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

type ManufacturerEntry = NonNullable<BleDeviceInfo['manufacturerData']>;

const HEX_RE = /^(?:[0-9a-f]{2})*$/i;
const AD_TYPE_MANUFACTURER = 0xff;

/**
 * The first manufacturer-specific AD structure in a raw advertising payload
 * that carries a company id and at least one byte of data, or null when there
 * is none or the payload does not parse (odd or non-hex string, an AD
 * structure running past the end).
 */
function manufacturerFromRaw(raw: string | null | undefined): ManufacturerEntry | null {
  if (!raw || !HEX_RE.test(raw)) return null;
  const p = Buffer.from(raw, 'hex');
  let i = 0;
  while (i < p.length) {
    const len = p[i];
    if (len === 0) break;
    if (i + 1 + len > p.length) return null;
    if (p[i + 1] === AD_TYPE_MANUFACTURER && len >= 4) {
      return { id: p.readUInt16LE(i + 2), data: Buffer.from(p.subarray(i + 4, i + 1 + len)) };
    }
    i += 1 + len;
  }
  return null;
}

/**
 * Whether one manufacturer entry carries the device's own address: the high
 * byte of its company id followed by its first five data bytes (#408).
 */
function echoesAddress(id: number, hex: string, address: string): boolean {
  const own = address.replace(/[:-]/g, '').toLowerCase();
  const echo = (id >> 8).toString(16).padStart(2, '0') + hex.slice(0, 10).toLowerCase();
  return own.length === 12 && echo === own;
}

/**
 * Which manufacturer entry to hand to the adapters. BleDeviceInfo has one slot,
 * and Home Assistant's dict is not one packet: it is every company id the
 * device has used since the scanner last forgot it (15 minutes of silence),
 * merged, and JavaScript lists its integer-like keys in ascending order, not in
 * the order HA inserted them. Taking the first key therefore gave the
 * numerically lowest company id, not the newest one.
 *
 * Harmless for a device with one fixed company id, whose value HA overwrites
 * with every packet, so that case stays exactly as it was and never reads
 * `raw`. A scale whose company id changes (OKOK C0 frames carry a counter in
 * its high byte, #408) piles up keys, and the lowest is an earlier weigh-in or
 * an idle frame. Then `raw`, the packet that caused this event, says which
 * entry is current. Without a usable `raw` (bleak fallback scanner, remote
 * scanners that pass parsed data only), the entry is dropped rather than
 * guessed when the keys are one device's changing id: they all share their
 * low byte (OKOK C0: the counter is the high byte), or every one of them
 * spells the device's own address (Eufy C20 / P3: the first byte of the
 * address is the high byte of the id, the rest opens the data, the low byte
 * changes while weighing, and a stale key held a weigh-in from minutes
 * before). A shared high byte alone is not taken for that: every company id
 * below 0x0100 has the same one, and a Eufy P2 / P2 Pro, also seen with more
 * than one entry, would lose its broadcast if its ids happened to share it.
 * Anything else keeps the first entry as before.
 */
function pickManufacturerData(
  ad: HaAdvertisement,
  onUndatable: (() => void) | undefined,
): ManufacturerEntry | null {
  const keys = Object.entries(ad.manufacturer_data ?? {});
  if (keys.length > 1) {
    const newest = manufacturerFromRaw(ad.raw);
    if (newest) return newest;
    const ids = keys.map(([key]) => Number.parseInt(key, 10));
    const sharedLow = ids.every((id) => (id & 0xff) === (ids[0] & 0xff));
    const ownAddress = keys.every(([, hex], i) => echoesAddress(ids[i], hex, ad.address));
    if (sharedLow || ownAddress) {
      onUndatable?.();
      return null;
    }
  }
  const first = keys[0];
  if (!first) return null;
  const id = Number.parseInt(first[0], 10);
  const data = hexToBuffer(first[1]);
  return Number.isInteger(id) && id >= 0 && data.length > 0 ? { id, data } : null;
}

/**
 * Map an HA advertisement onto the adapter-facing {@link BleDeviceInfo}.
 *
 * @param onUndatable called when the manufacturer data was dropped because the
 *   merged dict cannot say which entry is current (see pickManufacturerData);
 *   the caller decides whether that is worth a log line.
 */
export function toBleDeviceInfo(ad: HaAdvertisement, onUndatable?: () => void): BleDeviceInfo {
  // HA reports the address as the name of a device that never sent one; the
  // adapters expect an empty name in that case. Compared without separators
  // because BlueZ's generated Alias for a nameless device is the address with
  // dashes, which an older bleak passed on as the name (current bleak drops it
  // in device_name_from_props).
  const bare = (s: string): string => s.replace(/[:-]/g, '').toUpperCase();
  const name = ad.name && bare(ad.name) !== bare(ad.address) ? ad.name : '';
  const info: BleDeviceInfo = {
    localName: name,
    address: ad.address.toUpperCase(),
    serviceUuids: (ad.service_uuids ?? []).map(normalizeUuid),
  };

  const mfr = pickManufacturerData(ad, onUndatable);
  if (mfr) info.manufacturerData = mfr;

  const sd = Object.entries(ad.service_data ?? {})
    .map(([uuid, hex]) => ({ uuid: normalizeUuid(uuid), data: hexToBuffer(hex) }))
    .filter((e) => e.data.length > 0);
  if (sd.length > 0) info.serviceData = sd;

  return info;
}
