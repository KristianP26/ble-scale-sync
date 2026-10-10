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

/** Map an HA advertisement onto the adapter-facing {@link BleDeviceInfo}. */
export function toBleDeviceInfo(ad: HaAdvertisement): BleDeviceInfo {
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

  // Like the other proxy transports, only the first manufacturer entry is
  // carried: BleDeviceInfo has a single slot and adapters key on one company.
  const mfr = Object.entries(ad.manufacturer_data ?? {})[0];
  if (mfr) {
    const id = Number.parseInt(mfr[0], 10);
    const data = hexToBuffer(mfr[1]);
    if (Number.isInteger(id) && id >= 0 && data.length > 0) info.manufacturerData = { id, data };
  }

  const sd = Object.entries(ad.service_data ?? {})
    .map(([uuid, hex]) => ({ uuid: normalizeUuid(uuid), data: hexToBuffer(hex) }))
    .filter((e) => e.data.length > 0);
  if (sd.length > 0) info.serviceData = sd;

  return info;
}
