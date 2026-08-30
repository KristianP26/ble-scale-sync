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
  /** Unix seconds (float) when HA last saw the device. */
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
  // adapters expect an empty name in that case.
  const name = ad.name && ad.name.toUpperCase() !== ad.address.toUpperCase() ? ad.name : '';
  const info: BleDeviceInfo = {
    localName: name,
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
