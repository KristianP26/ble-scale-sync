import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the client factory so no real sockets open.
const fakeClients = new Map<string, FakeClient>();

interface FakeClient {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  on(ev: string, fn: (...a: unknown[]) => void): FakeClient;
  removeListener(ev: string, fn: (...a: unknown[]) => void): FakeClient;
  connection: Record<string, unknown>;
  _emit(ev: string, arg?: unknown): void;
}

vi.mock('../../../src/ble/handler-esphome-proxy/client.js', () => ({
  createEsphomeClient: vi.fn(async (cfg: { host: string }) => {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const c: FakeClient = {
      connected: true,
      connect() {
        (listeners['connected'] ?? []).forEach((f) => f());
      },
      disconnect() {},
      on(ev, fn) {
        (listeners[ev] ??= []).push(fn);
        return c;
      },
      removeListener(ev, fn) {
        listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
        return c;
      },
      connection: {},
      _emit(ev, arg) {
        (listeners[ev] ?? []).forEach((f) => f(arg));
      },
    };
    fakeClients.set(cfg.host, c);
    return c;
  }),
  waitForConnected: vi.fn(async () => {}),
  safeDisconnect: vi.fn(async () => {}),
}));

// Mock the GATT bridge so connectGatt() does not need real GATT discovery stubs;
// we only assert how the pool calls it (which address type it forwards). Other
// tests in this file never call connectGatt, so the mock does not affect them.
vi.mock('../../../src/ble/handler-esphome-proxy/gatt.js', () => ({
  openGattSession: vi.fn(async () => ({
    charMap: new Map(),
    device: { onDisconnect() {} },
    close: async () => {},
  })),
}));

import { EsphomeProxyPool } from '../../../src/ble/handler-esphome-proxy/pool.js';
import { openGattSession } from '../../../src/ble/handler-esphome-proxy/gatt.js';

const adv = (addr: number, rssi: number, addressType?: number) => ({
  address: addr,
  name: 'QN-Scale',
  rssi,
  serviceUuidsList: [],
  serviceDataList: [],
  manufacturerDataList: [],
  ...(addressType === undefined ? {} : { addressType }),
});

describe('EsphomeProxyPool', () => {
  beforeEach(() => {
    fakeClients.clear();
    vi.mocked(openGattSession).mockClear();
  });

  it('aggregates advertisements from every proxy', async () => {
    const pool = new EsphomeProxyPool({
      host: 'p1',
      port: 6053,
      client_info: 'x',
      additional_proxies: [{ host: 'p2', port: 6053, client_info: 'x' }],
    } as never);
    await pool.start();
    const seen: string[] = [];
    pool.onAdvertisement((_info, mac) => seen.push(mac));
    fakeClients.get('p1')!._emit('ble', adv(0x112233445566, -50));
    fakeClients.get('p2')!._emit('ble', adv(0xaabbccddeeff, -60));
    expect(seen).toContain('11:22:33:44:55:66');
    expect(seen).toContain('AA:BB:CC:DD:EE:FF');
    await pool.stop();
  });

  it('pickProxyFor returns the proxy with the strongest recent RSSI', async () => {
    const pool = new EsphomeProxyPool({
      host: 'p1',
      port: 6053,
      client_info: 'x',
      additional_proxies: [{ host: 'p2', port: 6053, client_info: 'x' }],
    } as never);
    await pool.start();
    fakeClients.get('p1')!._emit('ble', adv(0x112233445566, -80));
    fakeClients.get('p2')!._emit('ble', adv(0x112233445566, -40));
    expect(pool.pickProxyFor('11:22:33:44:55:66')).toBe('p2:6053');
    expect(pool.proxyOrderFor('11:22:33:44:55:66')).toEqual(['p2:6053', 'p1:6053']);
    await pool.stop();
  });

  it('captures the address type from advertisements (#215)', async () => {
    const pool = new EsphomeProxyPool({
      host: 'p1',
      port: 6053,
      client_info: 'x',
      additional_proxies: [],
    } as never);
    await pool.start();
    fakeClients.get('p1')!._emit('ble', adv(0xaabbccddeeff, -50, 1));
    expect(pool.addressTypeFor('aa:bb:cc:dd:ee:ff')).toBe(1);
    // Public = 0 is valid and falsy: must still be captured, not dropped.
    fakeClients.get('p1')!._emit('ble', adv(0x112233445566, -50, 0));
    expect(pool.addressTypeFor('11:22:33:44:55:66')).toBe(0);
    await pool.stop();
  });

  it('connectGatt forwards the captured address type to openGattSession (#215)', async () => {
    const pool = new EsphomeProxyPool({
      host: 'p1',
      port: 6053,
      client_info: 'x',
      additional_proxies: [],
    } as never);
    await pool.start();
    fakeClients.get('p1')!._emit('ble', adv(0xaabbccddeeff, -50, 1));
    await pool.connectGatt('AA:BB:CC:DD:EE:FF');
    expect(openGattSession).toHaveBeenCalledWith(expect.anything(), 'AA:BB:CC:DD:EE:FF', 1);
    await pool.stop();
  });

  it('returns null when no proxy has seen the MAC', async () => {
    const pool = new EsphomeProxyPool({
      host: 'p1',
      port: 6053,
      client_info: 'x',
      additional_proxies: [],
    } as never);
    await pool.start();
    expect(pool.pickProxyFor('00:00:00:00:00:01')).toBeNull();
    await pool.stop();
  });

  it('evicts sightings older than the TTL instead of growing unbounded', async () => {
    vi.useFakeTimers();
    try {
      const pool = new EsphomeProxyPool({
        host: 'p1',
        port: 6053,
        client_info: 'x',
        additional_proxies: [],
      } as never);
      await pool.start();

      fakeClients.get('p1')!._emit('ble', adv(0x112233445566, -50, 1));
      expect(pool.pickProxyFor('11:22:33:44:55:66')).toBe('p1:6053');
      expect(pool.addressTypeFor('11:22:33:44:55:66')).toBe(1);

      // Advance past SIGHTING_TTL_MS (60s) then record a different MAC. The
      // stale entry must be swept, not just filtered out on read.
      vi.advanceTimersByTime(61_000);
      fakeClients.get('p1')!._emit('ble', adv(0xaabbccddeeff, -55));

      const internal = pool as unknown as { sightings: Map<string, unknown> };
      expect(internal.sightings.has('11:22:33:44:55:66')).toBe(false);
      expect(pool.pickProxyFor('11:22:33:44:55:66')).toBeNull();
      expect(pool.pickProxyFor('aa:bb:cc:dd:ee:ff')).toBe('p1:6053');
      // The address-type cache must be swept in lockstep with the sightings.
      expect(pool.addressTypeFor('11:22:33:44:55:66')).toBeUndefined();

      await pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
