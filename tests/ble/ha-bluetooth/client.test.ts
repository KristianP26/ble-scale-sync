import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HaBluetoothClient,
  HaBluetoothPermanentError,
  toWebSocketUrl,
  STALE_ADVERT_MS,
  type WsLike,
} from '../../../src/ble/handler-ha-bluetooth/index.js';
import type { HaAdvertisement } from '../../../src/ble/handler-ha-bluetooth/index.js';

/**
 * Scripted stand-in for the global WebSocket: records what the client sends and
 * lets the test play the Home Assistant side of the conversation.
 */
class FakeWs implements WsLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  // ─── test-side controls ───
  open(): void {
    this.readyState = 1;
    this.emit('open', undefined);
  }
  serverSays(msg: unknown): void {
    this.emit('message', { data: JSON.stringify(msg) });
  }
  serverCloses(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
  lastSent(): Record<string, unknown> {
    return this.sent[this.sent.length - 1];
  }
  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
}

const CONFIG = { url: 'http://ha.local:8123', token: 'tok' };
const NOW = 1_800_000_000_000;

function advert(overrides: Partial<HaAdvertisement> = {}): HaAdvertisement {
  return {
    name: '',
    address: 'F8:83:06:4E:B6:7E',
    rssi: -70,
    manufacturer_data: {},
    service_data: { '0000fe95-0000-1000-8000-00805f9b34fb': '1059d53b0a7eb64e0683f8' },
    service_uuids: [],
    source: '9c:13:9e:34:82:08',
    connectable: false,
    time: NOW / 1000,
    ...overrides,
  };
}

/** Drive a fake socket through the HA handshake up to a successful subscription. */
function handshake(ws: FakeWs): number {
  ws.open();
  ws.serverSays({ type: 'auth_required', ha_version: '2026.8.3' });
  ws.serverSays({ type: 'auth_ok', ha_version: '2026.8.3' });
  const sub = ws.sent.find((m) => m.type === 'bluetooth/subscribe_advertisements')!;
  const id = sub.id as number;
  ws.serverSays({ id, type: 'result', success: true, result: null });
  return id;
}

describe('toWebSocketUrl', () => {
  it('maps http(s) base URLs onto /api/websocket', () => {
    expect(toWebSocketUrl('http://ha.local:8123')).toBe('ws://ha.local:8123/api/websocket');
    expect(toWebSocketUrl('https://ha.example.com/')).toBe('wss://ha.example.com/api/websocket');
  });

  it('keeps an explicit websocket URL and path', () => {
    expect(toWebSocketUrl('wss://ha.example.com/api/websocket')).toBe(
      'wss://ha.example.com/api/websocket',
    );
    expect(toWebSocketUrl('ws://10.0.0.5:8123/ha/api/websocket')).toBe(
      'ws://10.0.0.5:8123/ha/api/websocket',
    );
  });

  it('rejects other schemes', () => {
    expect(() => toWebSocketUrl('mqtt://ha.local')).toThrow(/scheme/);
  });
});

describe('HaBluetoothClient', () => {
  let sockets: FakeWs[];
  let client: HaBluetoothClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    sockets = [];
    client = new HaBluetoothClient(CONFIG, {
      wsFactory: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
    });
  });
  afterEach(async () => {
    await client.stop();
    vi.useRealTimers();
  });

  it('authenticates with the token and subscribes to advertisements', async () => {
    const started = client.start();
    const ws = sockets[0];
    ws.open();
    ws.serverSays({ type: 'auth_required', ha_version: '2026.8.3' });
    expect(ws.lastSent()).toEqual({ type: 'auth', access_token: 'tok' });
    ws.serverSays({ type: 'auth_ok', ha_version: '2026.8.3' });
    expect(ws.lastSent()).toMatchObject({ type: 'bluetooth/subscribe_advertisements' });
    ws.serverSays({ id: ws.lastSent().id, type: 'result', success: true, result: null });
    await expect(started).resolves.toBeUndefined();
    expect(client.haVersion).toBe('2026.8.3');
  });

  it('rejects start() with a permanent error on a bad token', async () => {
    const started = client.start();
    const ws = sockets[0];
    ws.open();
    ws.serverSays({ type: 'auth_required' });
    ws.serverSays({ type: 'auth_invalid', message: 'Invalid access token or password' });
    await expect(started).rejects.toBeInstanceOf(HaBluetoothPermanentError);
    await expect(started).rejects.toThrow(/rejected the access token/);
    expect(ws.closed).not.toBeNull();
  });

  it('rejects start() when the subscription is refused (non-admin token)', async () => {
    const started = client.start();
    const ws = sockets[0];
    ws.open();
    ws.serverSays({ type: 'auth_required' });
    ws.serverSays({ type: 'auth_ok' });
    ws.serverSays({
      id: ws.lastSent().id,
      type: 'result',
      success: false,
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    await expect(started).rejects.toThrow(/administrator/);
  });

  it('rejects start() when the socket closes before subscribing', async () => {
    const started = client.start();
    sockets[0].serverCloses(1006, 'refused');
    await expect(started).rejects.toThrow(/before subscribing/);
  });

  it('rejects start() on connect timeout', async () => {
    const started = client.start();
    const assertion = expect(started).rejects.toThrow(/Timed out connecting/);
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;
  });

  it('delivers advertisements as BleDeviceInfo with an uppercase address', async () => {
    const started = client.start();
    const id = handshake(sockets[0]);
    await started;
    const cb = vi.fn();
    client.onAdvertisement(cb);
    sockets[0].serverSays({
      id,
      type: 'event',
      event: { add: [advert({ address: 'f8:83:06:4e:b6:7e' })] },
    });
    expect(cb).toHaveBeenCalledTimes(1);
    const [info, address] = cb.mock.calls[0];
    expect(address).toBe('F8:83:06:4E:B6:7E');
    expect(info.localName).toBe('');
    expect(info.serviceData).toEqual([
      {
        uuid: '0000fe9500001000800000805f9b34fb',
        data: Buffer.from('1059d53b0a7eb64e0683f8', 'hex'),
      },
    ]);
  });

  it('ignores events for other subscription ids and remove events', async () => {
    const started = client.start();
    const id = handshake(sockets[0]);
    await started;
    const cb = vi.fn();
    client.onAdvertisement(cb);
    sockets[0].serverSays({ id: id + 7, type: 'event', event: { add: [advert()] } });
    sockets[0].serverSays({ id, type: 'event', event: { remove: [{ address: 'AA' }] } });
    expect(cb).not.toHaveBeenCalled();
  });

  it('drops advertisements HA replays from its cache (stale time stamp)', async () => {
    const started = client.start();
    const id = handshake(sockets[0]);
    await started;
    const cb = vi.fn();
    client.onAdvertisement(cb);
    sockets[0].serverSays({
      id,
      type: 'event',
      event: {
        add: [
          advert({ time: (NOW - STALE_ADVERT_MS - 1000) / 1000 }),
          advert({ address: 'AA:BB:CC:DD:EE:FF', time: (NOW - 5000) / 1000 }),
        ],
      },
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][1]).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('filters on the configured scanner source', async () => {
    const filtered = new HaBluetoothClient(
      { ...CONFIG, source: '9C:13:9E:34:82:08' },
      { wsFactory: () => sockets[sockets.push(new FakeWs()) - 1] },
    );
    const started = filtered.start();
    const id = handshake(sockets[0]);
    await started;
    const cb = vi.fn();
    filtered.onAdvertisement(cb);
    sockets[0].serverSays({
      id,
      type: 'event',
      event: {
        add: [
          advert({ source: 'dc:a6:32:a1:5a:ca', address: '11:11:11:11:11:11' }),
          advert({ source: '9c:13:9e:34:82:08', address: '22:22:22:22:22:22' }),
        ],
      },
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][1]).toBe('22:22:22:22:22:22');
    await filtered.stop();
  });

  it('pings periodically and drops the socket when a pong is missed', async () => {
    const started = client.start();
    handshake(sockets[0]);
    await started;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0].lastSent()).toMatchObject({ type: 'ping' });
    sockets[0].serverSays({ id: sockets[0].lastSent().id, type: 'pong' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0].sent.filter((m) => m.type === 'ping')).toHaveLength(2);
    // No pong this time: the next tick drops the connection and reconnects.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0].closed).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
  });

  it('reconnects with backoff after an unexpected close and keeps subscribers', async () => {
    const started = client.start();
    handshake(sockets[0]);
    await started;
    const cb = vi.fn();
    client.onAdvertisement(cb);

    sockets[0].serverCloses(1006, 'gone');
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
    const id2 = handshake(sockets[1]);
    sockets[1].serverSays({ id: id2, type: 'event', event: { add: [advert()] } });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect after stop()', async () => {
    const started = client.start();
    handshake(sockets[0]);
    await started;
    await client.stop();
    expect(sockets[0].closed).toMatchObject({ code: 1000 });
    sockets[0].serverCloses(1000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('does not reconnect when reconnect is disabled', async () => {
    const oneShot = new HaBluetoothClient(CONFIG, {
      reconnect: false,
      wsFactory: () => sockets[sockets.push(new FakeWs()) - 1],
    });
    const started = oneShot.start();
    handshake(sockets[0]);
    await started;
    sockets[0].serverCloses();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
    await oneShot.stop();
  });

  it('survives a subscriber that throws and a non-JSON frame', async () => {
    const started = client.start();
    const id = handshake(sockets[0]);
    await started;
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    client.onAdvertisement(bad);
    client.onAdvertisement(good);
    (sockets[0] as unknown as { emit: (t: string, e: unknown) => void }).emit?.('message', {
      data: 'not json',
    });
    sockets[0].serverSays({ id, type: 'event', event: { add: [advert()] } });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
