import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// The pool's client factory is mocked so no socket opens; the library's own
// message mapping (required below) is NOT mocked, because the point of this
// suite is the exact shape that mapping hands us (B-02, B-20).
const fakeClients = new Map<string, { _emit(ev: string, arg?: unknown): void }>();
vi.mock('../../../src/ble/handler-esphome-proxy/client.js', () => ({
  createEsphomeClient: vi.fn(async (cfg: { host: string }) => {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const c = {
      connected: true,
      connect() {},
      disconnect() {},
      on(ev: string, fn: (...a: unknown[]) => void) {
        (listeners[ev] ??= []).push(fn);
        return c;
      },
      removeListener(ev: string, fn: (...a: unknown[]) => void) {
        listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
        return c;
      },
      connection: {},
      _emit(ev: string, arg?: unknown) {
        (listeners[ev] ?? []).forEach((f) => f(arg));
      },
    };
    fakeClients.set(cfg.host, c);
    return c;
  }),
  waitForConnected: vi.fn(async () => {}),
  safeDisconnect: vi.fn(async () => {}),
}));

import { toBleDeviceInfo } from '../../../src/ble/handler-esphome-proxy/advert.js';
import { EsphomeProxyPool } from '../../../src/ble/handler-esphome-proxy/pool.js';
import type { EsphomeBleAdvertisement } from '../../../src/ble/handler-esphome-proxy/client.js';
import { bleLog, normalizeUuid } from '../../../src/ble/types.js';

const nodeRequire = createRequire(import.meta.url);
const { pb } = nodeRequire('@2colors/esphome-native-api/lib/utils/messages.js');
const { mapMessageByType } = nodeRequire(
  '@2colors/esphome-native-api/lib/utils/mapMessageByType.js',
);

const ADDR = 0xaabbccddeeff;

/**
 * A legacy advertisement (proxy API < 1.9) exactly as the library emits it:
 * built as the protobuf the proxy sends, decoded, and run through the real
 * mapMessageByType(). Its `.map(sd => sd.uuid = ...)` returns the UUID string,
 * so both data lists arrive as bare strings.
 */
function legacyAdvertisement(): EsphomeBleAdvertisement {
  const sd = new pb.BluetoothServiceData();
  sd.setUuid('0x181d');
  sd.setData(Buffer.from([0x02, 0x40, 0x1f]));
  const md = new pb.BluetoothServiceData();
  md.setUuid('0xffb0');
  md.setData(Buffer.from([0x01, 0x02]));
  const msg = new pb.BluetoothLEAdvertisementResponse();
  msg.setAddress(ADDR);
  msg.setName(Buffer.from('MIBFS'));
  msg.setRssi(-60);
  msg.addServiceUuids('0x181d');
  msg.setServiceDataList([sd]);
  msg.setManufacturerDataList([md]);
  msg.setAddressType(0);
  const decoded = pb.BluetoothLEAdvertisementResponse.deserializeBinary(msg.serializeBinary());
  return mapMessageByType('BluetoothLEAdvertisementResponse', decoded.toObject());
}

/** A raw advertisement (API >= 1.9) as the library emits it per advertisement. */
function rawAdvertisement(): EsphomeBleAdvertisement {
  const raw = new pb.BluetoothLERawAdvertisement();
  raw.setAddress(ADDR);
  raw.setRssi(-50);
  raw.setAddressType(1);
  // flags, manufacturer data (company 0xffb0, payload 01 02),
  // 16-bit service data (0x181d, payload 09 08)
  raw.setData(
    Buffer.from([
      0x02, 0x01, 0x06, 0x05, 0xff, 0xb0, 0xff, 0x01, 0x02, 0x05, 0x16, 0x1d, 0x18, 0x09, 0x08,
    ]),
  );
  const batch = new pb.BluetoothLERawAdvertisementsResponse();
  batch.setAdvertisementsList([raw]);
  const decoded = pb.BluetoothLERawAdvertisementsResponse.deserializeBinary(
    batch.serializeBinary(),
  );
  return mapMessageByType('BluetoothLERawAdvertisementsResponse', decoded.toObject())
    .advertisementsList[0];
}

describe('toBleDeviceInfo against the shapes esphome-native-api really emits', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the library still turns legacy data lists into bare UUID strings (B-02 premise)', () => {
    const ad = legacyAdvertisement() as unknown as { serviceDataList: unknown[] };
    // If a library upgrade fixes this, the guard in advert.ts becomes dead code
    // and can go; this assertion is what will say so.
    expect(ad.serviceDataList).toEqual(['0000181d-0000-1000-8000-00805f9b34fb']);
  });

  it('does not throw on a legacy advertisement and keeps what survived (B-02)', () => {
    let info: ReturnType<typeof toBleDeviceInfo> | undefined;
    expect(() => {
      info = toBleDeviceInfo(legacyAdvertisement());
    }).not.toThrow();
    if (!info) throw new Error('unreachable');
    expect(info.localName).toBe('MIBFS');
    expect(info.address).toBe('AA:BB:CC:DD:EE:FF');
    expect(info.serviceUuids).toEqual([normalizeUuid('181d')]);
    // The payload bytes were dropped by the library, so nothing is invented.
    expect(info.manufacturerData).toBeUndefined();
    expect(info.serviceData ?? []).toEqual([]);
  });

  it('decodes manufacturer and service data from a raw advertisement (B-20)', () => {
    const info = toBleDeviceInfo(rawAdvertisement());
    expect(info.address).toBe('AA:BB:CC:DD:EE:FF');
    expect(info.manufacturerData).toEqual({ id: 0xffb0, data: Buffer.from([0x01, 0x02]) });
    expect(info.serviceData).toEqual([
      { uuid: normalizeUuid('181d'), data: Buffer.from([0x09, 0x08]) },
    ]);
  });

  it('pool delivers a legacy advertisement and warns once per proxy (B-02)', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    const pool = new EsphomeProxyPool(
      { host: 'legacy', port: 6053, client_info: 'x', additional_proxies: [] } as never,
      { liveness: false },
    );
    await pool.start();
    const seen: string[] = [];
    pool.onAdvertisement((_info, mac) => seen.push(mac));
    const client = fakeClients.get('legacy')!;
    expect(() => client._emit('ble', legacyAdvertisement())).not.toThrow();
    expect(() => client._emit('ble', legacyAdvertisement())).not.toThrow();
    expect(seen).toEqual(['AA:BB:CC:DD:EE:FF', 'AA:BB:CC:DD:EE:FF']);
    const legacyWarnings = warn.mock.calls.filter((c) => /older than 1\.9/.test(String(c[0])));
    expect(legacyWarnings).toHaveLength(1);
    await pool.stop();
  });

  it('pool keeps delivering to other subscribers when one throws', async () => {
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    const pool = new EsphomeProxyPool(
      { host: 'raw', port: 6053, client_info: 'x', additional_proxies: [] } as never,
      { liveness: false },
    );
    await pool.start();
    const seen: string[] = [];
    pool.onAdvertisement(() => {
      throw new Error('subscriber bug');
    });
    pool.onAdvertisement((_info, mac) => seen.push(mac));
    expect(() => fakeClients.get('raw')!._emit('ble', rawAdvertisement())).not.toThrow();
    expect(seen).toEqual(['AA:BB:CC:DD:EE:FF']);
    await pool.stop();
  });
});
