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

import { EsphomeProxyPool } from '../../../src/ble/handler-esphome-proxy/pool.js';

const adv = (addr: number, rssi: number) => ({
  address: addr,
  name: 'QN-Scale',
  rssi,
  serviceUuidsList: [],
  serviceDataList: [],
  manufacturerDataList: [],
});

describe('EsphomeProxyPool', () => {
  beforeEach(() => fakeClients.clear());

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
});
