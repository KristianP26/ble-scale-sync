import { ManufacturerDataCache } from '../advertisement.js';
import { bleLog, formatMac } from '../types.js';
import type { AdvertisementSnapshot } from './device-object.js';

/**
 * The manufacturer data a node-ble GATT session is handed (#463, D071).
 *
 * The transport reads the advertisement once, off the Device1 object right
 * after it shows up and a few ms before StopDiscovery. BlueZ builds that object
 * from the first report it hears, and a scan response can come apart from its
 * advertisement, so the object can lack the manufacturer data the unit does
 * send. A QN scale's object is removed before every cycle (D060), so that can
 * happen in any cycle: the #463 Physiq had it at 17:57 and not at 19:39 of the
 * same day, and without it the session cannot read the scale's impedance flag.
 *
 * So this remembers, for the life of the process, the last non-empty
 * manufacturer data each address advertised in the GATT path, and a session
 * whose own snapshot has none gets that. Only for the session handoff
 * (ConnectionContext.manufacturerData), never for matching: the pre-connect
 * match, the post-connect one and the broadcast parsers keep the snapshot as it
 * is, or a stale frame could pick another adapter or be read as a reading
 * (#372). A restart starts empty, as does every run in single-shot mode.
 */
let lastSeen = new ManufacturerDataCache();

/** Forget every address, for test isolation. */
export function _resetSessionAdvertForTests(): void {
  lastSeen = new ManufacturerDataCache();
}

/**
 * The snapshot's own manufacturer data, else the last one this address
 * advertised in this run. Remembers the snapshot's, if it has any.
 */
export function sessionManufacturerData(
  mac: string,
  snapshot: AdvertisementSnapshot,
): { id: number; data: Buffer } | undefined {
  const key = formatMac(mac);
  lastSeen.remember(snapshot, key);
  const md = lastSeen.forSession(snapshot, key);
  if (md && md !== snapshot.manufacturerData) {
    bleLog.debug(
      `${key} advertised no manufacturer data this time; the session gets what it ` +
        'advertised earlier in this run (#463)',
    );
  }
  return md;
}
