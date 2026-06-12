import type { BleChar, BleDevice } from '../shared.js';
import { bleLog, errMsg, normalizeUuid } from '../types.js';
import type { EsphomeClient, EsphomeConnection } from './client.js';
import { macToInt } from './advert.js';
import {
  esphomeUuidToString,
  type EsphomeGattServicesResponse,
  type EsphomeNotifyData,
  type EsphomeDeviceConnection,
} from './esphome-gatt-proto.js';

const NOTIFY_EVENT = 'message.BluetoothGATTNotifyDataResponse';
const CONNECTION_EVENT = 'message.BluetoothDeviceConnectionResponse';

export interface GattSession {
  /** Normalized-UUID -> BleChar, the shape waitForRawReading() consumes. */
  charMap: Map<string, BleChar>;
  device: BleDevice;
  close(): Promise<void>;
}

interface ConnectResponse extends EsphomeDeviceConnection {
  mtu?: number;
}

/**
 * Connect to `mac` through an ESPHome proxy client, discover its GATT table,
 * and expose it as the UUID-keyed BleChar map + BleDevice that the shared
 * waitForRawReading() seam expects. ESPHome speaks numeric handles and a uint64
 * address; the translation is contained here so adapters stay UUID-based and
 * unchanged.
 *
 * ESPHome's V3 connect request requires the BLE `address_type`; omitting it makes
 * newer firmware reject the connect with "Missing address type" (#215). When the
 * type is known (captured from the advertisement) we try it first; otherwise, and
 * as a fallback when the first attempt fails, we try the other type (public = 0,
 * random = 1).
 */
export async function openGattSession(
  client: EsphomeClient,
  mac: string,
  addressType?: number,
): Promise<GattSession> {
  const conn: EsphomeConnection = client.connection;
  const addr = macToInt(mac);

  const candidates = addressType === undefined ? [0, 1] : [addressType, addressType === 0 ? 1 : 0];
  let connResp: ConnectResponse | undefined;
  let lastErr = 'no connect attempt made';
  for (const type of candidates) {
    try {
      const resp = (await conn.connectBluetoothDeviceService(addr, type)) as ConnectResponse;
      if (resp && resp.connected === true) {
        connResp = resp;
        break;
      }
      lastErr = `connected=false (addr_type=${type})`;
    } catch (e) {
      lastErr = `${errMsg(e)} (addr_type=${type})`;
    }
  }
  if (!connResp) {
    throw new Error(`ESPHome proxy could not connect to ${mac}: ${lastErr}`);
  }
  const services = (await conn.listBluetoothGATTServicesService(
    addr,
  )) as EsphomeGattServicesResponse;

  let closed = false;
  const registered: Array<{ event: string; fn: (m: unknown) => void }> = [];
  const track = (event: string, fn: (m: unknown) => void): (() => void) => {
    conn.on(event, fn);
    registered.push({ event, fn });
    return () => {
      conn.removeListener(event, fn);
      const i = registered.findIndex((r) => r.fn === fn);
      if (i >= 0) registered.splice(i, 1);
    };
  };

  const charMap = new Map<string, BleChar>();
  for (const svc of services.servicesList ?? []) {
    for (const ch of svc.characteristicsList ?? []) {
      // The library hands us a pre-decoded `uuid` string; `uuidList` is the
      // raw-shape fallback. Skip entries we cannot identify rather than letting
      // one malformed characteristic throw and abort the whole session (#229).
      const uuid = ch.uuid ? normalizeUuid(ch.uuid) : esphomeUuidToString(ch.uuidList);
      if (!uuid) continue;
      const handle = ch.handle;

      const char: BleChar = {
        async read(): Promise<Buffer> {
          const r = (await conn.readBluetoothGATTCharacteristicService(addr, handle)) as {
            dataList: number[];
          };
          return Buffer.from(r.dataList ?? []);
        },
        async write(data: Buffer, withResponse: boolean): Promise<void> {
          if (closed) return;
          // One atomic characteristic write, matching the native node-ble
          // handler. ESPHome's bluetooth_proxy handles ATT-level fragmentation;
          // splitting here would send N distinct values, not a long write.
          await conn.writeBluetoothGATTCharacteristicService(
            addr,
            handle,
            Uint8Array.from(data),
            withResponse,
          );
        },
        async subscribe(onData: (data: Buffer) => void): Promise<() => void> {
          await conn.notifyBluetoothGATTCharacteristicService(addr, handle);
          const listener = (raw: unknown): void => {
            if (closed) return;
            const m = raw as EsphomeNotifyData;
            if (m.address === addr && m.handle === handle) {
              onData(Buffer.from(m.dataList ?? []));
            }
          };
          return track(NOTIFY_EVENT, listener);
        },
      };
      charMap.set(uuid, char);
    }
  }

  const device: BleDevice = {
    onDisconnect(cb: () => void): void {
      let fired = false;
      track(CONNECTION_EVENT, (raw: unknown) => {
        const m = raw as EsphomeDeviceConnection;
        if (!fired && m.address === addr && m.connected === false) {
          fired = true;
          cb();
        }
      });
    },
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const { event, fn } of registered.splice(0)) {
      conn.removeListener(event, fn);
    }
    try {
      await conn.disconnectBluetoothDeviceService(addr);
    } catch (e) {
      bleLog.debug(`ESPHome GATT disconnect for ${mac} ignored: ${errMsg(e)}`);
    }
  };

  return { charMap, device, close };
}
