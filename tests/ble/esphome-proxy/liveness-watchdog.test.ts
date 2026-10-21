import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * #303: a single read ECONNRESET produced 4h35m of total silence. The container
 * stayed started, the ESP32 stayed healthy and reachable, and two weigh-ins were
 * lost. The watchdog turns that into a few-minute blip, but it is opt-in, so
 * these tests must also prove it stays dormant by default.
 */

class MockClient extends EventEmitter {
  connected = true;
  connection = new EventEmitter();
  disconnect = vi.fn();
  constructor(public readonly id: number) {
    super();
  }
}

let created: MockClient[] = [];
const createEsphomeClient = vi.fn(async () => {
  const c = new MockClient(created.length);
  created.push(c);
  return c;
});
const waitForConnected = vi.fn(async () => {});
const safeDisconnect = vi.fn(async () => {});

vi.mock('../../../src/ble/handler-esphome-proxy/client.js', () => ({
  createEsphomeClient,
  waitForConnected,
  safeDisconnect,
}));

const { EsphomeProxyPool } = await import('../../../src/ble/handler-esphome-proxy/pool.js');
const { bleLog } = await import('../../../src/ble/types.js');

type Cfg = ConstructorParameters<typeof EsphomeProxyPool>[0];

function cfg(advertisement_timeout: number): Cfg {
  return {
    host: 'bt-proxy.local',
    port: 6053,
    client_info: 'ble-scale-sync',
    additional_proxies: [],
    advertisement_timeout,
  } as unknown as Cfg;
}

/** Emit an advertisement so the pool records liveness for its proxy. */
function advertise(client: MockClient): void {
  client.emit('ble', { address: 0x03b3ec93b87e, name: 'Hutbit', rssi: -60 });
}

describe('ESPHome advertisement liveness watchdog (#303)', () => {
  beforeEach(() => {
    created = [];
    createEsphomeClient.mockClear();
    safeDisconnect.mockClear();
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stays dormant when advertisement_timeout is 0 (the default)', async () => {
    const pool = new EsphomeProxyPool(cfg(0));
    await pool.start();
    expect(createEsphomeClient).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    // Six hours of total silence and still no teardown: opt-in means opt-in.
    expect(createEsphomeClient).toHaveBeenCalledTimes(1);
    await pool.stop();
  });

  it('rebuilds the client after the configured silence', async () => {
    const pool = new EsphomeProxyPool(cfg(180));
    await pool.start();
    expect(createEsphomeClient).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200_000);

    expect(createEsphomeClient).toHaveBeenCalledTimes(2);
    expect(safeDisconnect).toHaveBeenCalledTimes(1);
    await pool.stop();
  });

  it('does not rebuild while advertisements keep arriving', async () => {
    const pool = new EsphomeProxyPool(cfg(180));
    await pool.start();

    // One advertisement every 60s for 10 minutes.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      advertise(created[0]);
    }

    expect(createEsphomeClient).toHaveBeenCalledTimes(1);
    await pool.stop();
  });

  it('never tears down a proxy with a GATT session in flight', async () => {
    const pool = new EsphomeProxyPool(cfg(180));
    await pool.start();
    pool.noteGattStart('bt-proxy.local:6053');

    await vi.advanceTimersByTimeAsync(600_000);
    expect(createEsphomeClient).toHaveBeenCalledTimes(1);

    // Once the session ends, the proxy becomes eligible again.
    pool.noteGattEnd('bt-proxy.local:6053');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(createEsphomeClient).toHaveBeenCalledTimes(2);
    await pool.stop();
  });

  it('gives up after repeated rebuilds that produce no advertisement', async () => {
    const pool = new EsphomeProxyPool(cfg(180));
    await pool.start();

    // Long enough for many rungs of backoff; the cap must still hold.
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);

    // 1 initial + at most 3 rebuilds, then it stops trying forever.
    expect(createEsphomeClient.mock.calls.length).toBeLessThanOrEqual(4);
    await pool.stop();
  });

  it('stops the timer on stop() so a one-shot run leaves nothing behind', async () => {
    const pool = new EsphomeProxyPool(cfg(180));
    await pool.start();
    await pool.stop();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(createEsphomeClient).toHaveBeenCalledTimes(1);
  });
});

describe('a failed rebuild must not leave an orphan client (#303)', () => {
  beforeEach(() => {
    created = [];
    createEsphomeClient.mockClear();
    safeDisconnect.mockClear();
    waitForConnected.mockReset();
    waitForConnected.mockImplementation(async () => {});
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    waitForConnected.mockImplementation(async () => {});
  });

  it('disconnects the half-built client and detaches its listener', async () => {
    const pool = new EsphomeProxyPool(cfg(180));
    await pool.start();
    expect(created).toHaveLength(1);

    // The rebuild's connect fails, which is the normal case when the watchdog
    // fires because the proxy is actually unreachable.
    waitForConnected.mockRejectedValueOnce(new Error('Timed out connecting'));
    await vi.advanceTimersByTimeAsync(200_000);

    const replacement = created[1];
    expect(replacement).toBeDefined();
    // The replacement must have been torn down, not abandoned. Left attached it
    // revives on its own (the library is built with reconnect:true) and starts
    // feeding onAd for an endpoint that is no longer in this.clients.
    expect(safeDisconnect).toHaveBeenCalledWith(replacement);
    expect(replacement.listenerCount('ble')).toBe(0);
  });

  it('an orphan cannot masquerade as a healthy endpoint', async () => {
    const pool = new EsphomeProxyPool(cfg(180));
    await pool.start();

    waitForConnected.mockRejectedValueOnce(new Error('Timed out connecting'));
    await vi.advanceTimersByTimeAsync(200_000);
    const orphan = created[1];
    const callsAfterFirstRebuild = createEsphomeClient.mock.calls.length;

    // If the orphan's listener were still attached, this advertisement would
    // refresh lastAdAt and the watchdog would never fire again.
    orphan.emit('ble', { address: 0x03b3ec93b87e, name: 'Hutbit', rssi: -60 });
    await vi.advanceTimersByTimeAsync(400_000);

    expect(createEsphomeClient.mock.calls.length).toBeGreaterThan(callsAfterFirstRebuild);
    await pool.stop();
  });
});
