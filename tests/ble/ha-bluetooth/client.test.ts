import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HaBluetoothClient,
  HaBluetoothPermanentError,
  toWebSocketUrl,
  STALE_ADVERT_MS,
  type WsLike,
} from '../../../src/ble/handler-ha-bluetooth/index.js';
import type { HaAdvertisement } from '../../../src/ble/handler-ha-bluetooth/index.js';
import { bleLog } from '../../../src/ble/types.js';

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
  /** The connection fails before `open`: Node 22 fires only this, never `close`. */
  serverErrors(message = 'Received network error or non-101 status code.'): void {
    this.emit('error', { message });
  }
  lastSent(): Record<string, unknown> {
    return this.sent[this.sent.length - 1];
  }
  protected emit(type: string, ev: unknown): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
}

/**
 * Node 22's WebSocket: close() on a socket that never opened fires `error`
 * again, synchronously, before it returns.
 */
class Node22Ws extends FakeWs {
  closeCalls = 0;
  close(code?: number, reason?: string): void {
    this.closeCalls++;
    if (this.readyState === 0) this.emit('error', { message: 'closed before open' });
    super.close(code, reason);
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

  it('says once per address that undatable manufacturer data was dropped (#408)', async () => {
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const started = client.start();
    const id = handshake(sockets[0]);
    await started;
    const cb = vi.fn();
    client.onAdvertisement(cb);
    // Two weigh-ins of the openScale #1177 Yoda0 (records #614 and #715), merged
    // by Home Assistant, from a scanner that sends no raw packet.
    const yoda = advert({
      name: 'Yoda0',
      address: '08:B8:D0:E8:5F:6D',
      service_data: {},
      manufacturer_data: {
        [String(0x3fc0)]: '1dce1388000025000000000000',
        [String(0x40c0)]: '204e1388000025000000000000',
      },
      raw: null,
    });
    sockets[0].serverSays({ id, type: 'event', event: { add: [yoda] } });
    sockets[0].serverSays({ id, type: 'event', event: { add: [yoda] } });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[0][0].manufacturerData).toBeUndefined();
    const lines = debug.mock.calls.filter(([m]) => String(m).includes('no raw packet'));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toContain('08:B8:D0:E8:5F:6D');
    debug.mockRestore();
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

  // ─── Snapshot vs live traffic and the clock-skew warning (#420) ───
  //
  // Home Assistant answers the subscribe with one event holding its whole
  // advertisement history (oldest first since 2026.8), then sends one event per
  // live advertisement. Only live traffic says anything about the clocks.

  /** An advertisement HA last heard `ageMs` ago, on the (fake) current clock. */
  function aged(ageMs: number, address = 'F8:83:06:4E:B6:7E'): HaAdvertisement {
    return advert({ address, time: (Date.now() - ageMs) / 1000 });
  }

  function skewWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
    return warn.mock.calls.map((c) => String(c[0])).filter((m) => /NTP|clock/.test(m));
  }

  /** One live event per advertisement, `stepMs` of fake time apart. */
  function sendLive(ws: FakeWs, id: number, count: number, ageMs: number, stepMs = 500): void {
    for (let i = 0; i < count; i++) {
      vi.advanceTimersByTime(stepMs);
      ws.serverSays({ id, type: 'event', event: { add: [aged(ageMs)] } });
    }
  }

  async function subscribed(): Promise<number> {
    const started = client.start();
    const id = handshake(sockets[0]);
    await started;
    return id;
  }

  it('does not take the subscribe snapshot for clock skew', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const id = await subscribed();
    const cb = vi.fn();
    client.onAdvertisement(cb);
    // The shape from the #420 log: many devices last heard minutes ago, oldest
    // first, and the few heard just now at the end.
    const old = Array.from({ length: 25 }, (_, i) =>
      aged(900_000 - i * 30_000, `AA:00:00:00:00:${String(i).padStart(2, '0')}`),
    );
    sockets[0].serverSays({
      id,
      type: 'event',
      event: { add: [...old, aged(2_000, '11:11:11:11:11:11'), aged(0, '22:22:22:22:22:22')] },
    });
    expect(skewWarnings(warn)).toHaveLength(0);
    expect(cb.mock.calls.map((c) => c[1])).toEqual(['11:11:11:11:11:11', '22:22:22:22:22:22']);
  });

  // A clock disagreement between the two hosts drops every advertisement while
  // the subscription still looks healthy, so the symptom is silence with no
  // error. The warning is the only thing that makes it diagnosable.
  it('warns once when live advertisements keep arriving stale', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const id = await subscribed();
    const cb = vi.fn();
    client.onAdvertisement(cb);
    sockets[0].serverSays({ id, type: 'event', event: { add: [] } });
    sendLive(sockets[0], id, 25, 600_000);
    const skew = skewWarnings(warn);
    expect(skew).toHaveLength(1);
    expect(skew[0]).toMatch(/600s in the past/);
    expect(skew[0]).toMatch(/NTP/);
    expect(cb).not.toHaveBeenCalled();
  });

  it('warns when live advertisements turn stale after a fresh one', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const id = await subscribed();
    const cb = vi.fn();
    client.onAdvertisement(cb);
    sockets[0].serverSays({ id, type: 'event', event: { add: [] } });
    sendLive(sockets[0], id, 1, 0);
    sendLive(sockets[0], id, 25, 600_000);
    expect(skewWarnings(warn)).toHaveLength(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not take a burst of stale live advertisements for clock skew', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const id = await subscribed();
    const cb = vi.fn();
    client.onAdvertisement(cb);
    sockets[0].serverSays({ id, type: 'event', event: { add: [] } });
    // What queued up while this process stalled arrives in one go.
    sendLive(sockets[0], id, 25, 35_000, 0);
    sendLive(sockets[0], id, 1, 0, 0);
    expect(skewWarnings(warn)).toHaveLength(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a fresh live advertisement restarts the count', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const id = await subscribed();
    const cb = vi.fn();
    client.onAdvertisement(cb);
    sockets[0].serverSays({ id, type: 'event', event: { add: [] } });
    sendLive(sockets[0], id, 15, 600_000);
    sendLive(sockets[0], id, 1, 0);
    sendLive(sockets[0], id, 15, 600_000);
    expect(skewWarnings(warn)).toHaveLength(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('treats the first event after every subscribe as a snapshot', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const id1 = await subscribed();
    client.onAdvertisement(vi.fn());
    sockets[0].serverSays({ id: id1, type: 'event', event: { add: [] } });
    // A stale run too short to warn, cut off by Home Assistant restarting.
    sendLive(sockets[0], id1, 15, 600_000);

    sockets[0].serverCloses(1006, 'restart');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
    const id2 = handshake(sockets[1]);
    const old = Array.from({ length: 25 }, (_, i) =>
      aged(600_000 - i * 1_000, `AA:00:00:00:00:${String(i).padStart(2, '0')}`),
    );
    sockets[1].serverSays({ id: id2, type: 'event', event: { add: old } });
    // Spread out, so the 10 s span cannot hide a miscount: neither this
    // snapshot nor the run from the previous subscription may count.
    sendLive(sockets[1], id2, 5, 600_000, 2_500);
    expect(skewWarnings(warn)).toHaveLength(0);

    // Real skew on the new subscription is still reported, once.
    sendLive(sockets[1], id2, 25, 600_000);
    expect(skewWarnings(warn)).toHaveLength(1);
    sendLive(sockets[1], id2, 1, 0);
    sendLive(sockets[1], id2, 25, 600_000);
    expect(skewWarnings(warn)).toHaveLength(1);
  });

  it('warns again on the next subscription', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const id1 = await subscribed();
    sockets[0].serverSays({ id: id1, type: 'event', event: { add: [] } });
    sendLive(sockets[0], id1, 25, 600_000);
    expect(skewWarnings(warn)).toHaveLength(1);

    // Skew that outlives a new subscription, and with it a new clock offset on
    // the Home Assistant side, is between the hosts: say so again.
    sockets[0].serverCloses(1006, 'restart');
    await vi.advanceTimersByTimeAsync(2_000);
    const id2 = handshake(sockets[1]);
    sockets[1].serverSays({ id: id2, type: 'event', event: { add: [] } });
    sendLive(sockets[1], id2, 25, 600_000);
    expect(skewWarnings(warn)).toHaveLength(2);
  });

  it('logs one debug summary per snapshot', async () => {
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    debug.mockClear();
    const id = await subscribed();
    client.onAdvertisement(vi.fn());
    sockets[0].serverSays({
      id,
      type: 'event',
      event: {
        add: [
          aged(400_000, 'AA:00:00:00:00:01'),
          aged(300_000, 'AA:00:00:00:00:02'),
          aged(200_000, 'AA:00:00:00:00:03'),
          aged(100_000, 'AA:00:00:00:00:04'),
          aged(1_000, 'AA:00:00:00:00:05'),
        ],
      },
    });
    const lines = debug.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => /sent 5 cached advertisements.*skipped 4/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /newest 1s old/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('Ignoring'))).toHaveLength(0);
  });

  it('still warns about live skew when Home Assistant sends no snapshot event', async () => {
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    warn.mockClear();
    const id = await subscribed();
    const cb = vi.fn();
    client.onAdvertisement(cb);
    // No empty snapshot after the result: the first live event is taken for
    // it, and its fresh advertisement must still get through.
    sendLive(sockets[0], id, 1, 0);
    expect(cb).toHaveBeenCalledTimes(1);
    sendLive(sockets[0], id, 25, 600_000);
    expect(skewWarnings(warn)).toHaveLength(1);
    expect(cb).toHaveBeenCalledTimes(1);
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

  it('keeps reconnecting when HA restarts before its Bluetooth integration is loaded (B-05)', async () => {
    const error = vi.spyOn(bleLog, 'error').mockImplementation(() => {});
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const started = client.start();
    handshake(sockets[0]);
    await started;
    const cb = vi.fn();
    client.onAdvertisement(cb);

    // HA restarts. Its HTTP server, and with it the websocket API, comes up with
    // the frontend in bootstrap stage 0; `bluetooth` is a stage 1 integration
    // and registers bluetooth/subscribe_advertisements only when it loads.
    sockets[0].serverCloses(1006, 'restart');
    await vi.advanceTimersByTimeAsync(2_000);
    const early = sockets[1];
    early.open();
    early.serverSays({ type: 'auth_required' });
    early.serverSays({ type: 'auth_ok' });
    early.serverSays({
      id: early.lastSent().id,
      type: 'result',
      success: false,
      error: { code: 'unknown_command', message: 'Unknown command.' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).not.toHaveBeenCalled();

    // Bluetooth is up by the next attempt, and the stream resumes on its own.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sockets).toHaveLength(3);
    const id = handshake(sockets[2]);
    sockets[2].serverSays({ id, type: 'event', event: { add: [advert()] } });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('still gives up for good when a reconnect is refused as unauthorized', async () => {
    const error = vi.spyOn(bleLog, 'error').mockImplementation(() => {});
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const started = client.start();
    handshake(sockets[0]);
    await started;

    sockets[0].serverCloses(1006, 'gone');
    await vi.advanceTimersByTimeAsync(2_000);
    const ws = sockets[1];
    ws.open();
    ws.serverSays({ type: 'auth_required' });
    ws.serverSays({ type: 'auth_ok' });
    ws.serverSays({
      id: ws.lastSent().id,
      type: 'result',
      success: false,
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/will not reconnect/));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(2);
  });

  // ─── A connection that fails before `open` ───

  it('fails start() at once when the websocket connection fails', async () => {
    const started = client.start();
    const outcome = started.then(
      () => 'ok',
      (e: Error) => e.message,
    );
    sockets[0].serverErrors();
    await vi.advanceTimersByTimeAsync(0);
    const result = await Promise.race([outcome, Promise.resolve('pending')]);
    expect(result).toMatch(
      /^Could not connect to Home Assistant at ws:\/\/ha\.local:8123\/api\/websocket: Received network error/,
    );
    expect(sockets[0].closed).not.toBeNull();
    // The connect timeout is gone too: left armed, it would close whatever
    // socket is current when it fires.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not re-enter close() when Node 22 fires error again from close()', async () => {
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    debug.mockClear();
    const node22: Node22Ws[] = [];
    const strict = new HaBluetoothClient(CONFIG, {
      wsFactory: () => node22[node22.push(new Node22Ws()) - 1],
    });
    const started = strict.start();
    const outcome = started.then(
      () => 'ok',
      (e: Error) => e.message,
    );
    node22[0].serverErrors();
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([outcome, Promise.resolve('pending')])).toMatch(
      /Could not connect to Home Assistant/,
    );
    expect(node22[0].closeCalls).toBe(1);
    expect(debug.mock.calls.filter((c) => String(c[0]).includes('websocket error'))).toHaveLength(
      2,
    );
    await strict.stop();
  });

  it('retries a failed connection on the backoff, not after the connect timeout', async () => {
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    await subscribed();
    sockets[0].serverCloses(1006, 'restart');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
    sockets[1].serverErrors();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sockets).toHaveLength(3);
  });

  it('reconnects once when error is followed by close (Node 24)', async () => {
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    await subscribed();
    sockets[0].serverCloses(1006, 'restart');
    await vi.advanceTimersByTimeAsync(2_000);
    sockets[1].serverErrors('');
    sockets[1].serverCloses(1006);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets).toHaveLength(3);
  });

  // Node 24 fires `error`, then `close`, when the server drops an open socket.
  // Only `close` may handle that one: dropping the socket from `error` would
  // make `close` look superseded, and nothing would ever reconnect.
  it('reconnects when an open socket reports an error before it closes', async () => {
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    await subscribed();
    sockets[0].serverErrors('');
    sockets[0].serverCloses(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
  });
});
