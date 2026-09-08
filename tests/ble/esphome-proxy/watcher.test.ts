import { describe, it, expect, vi } from 'vitest';
import type { BleChar } from '../../../src/ble/shared.js';
import { normalizeUuid } from '../../../src/ble/types.js';
import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
} from '../../../src/interfaces/scale-adapter.js';

const NOTIFY = normalizeUuid('2a9d');
const WRITE = normalizeUuid('2a9c');

const closeSpy = vi.fn(async () => {});
const connectGattSpy = vi.fn();
const fireDisconnectSpy = vi.fn();
// When set, connectGatt hands back a session that never notifies and whose
// device never reports a disconnect - an ESP32 that dropped off Wi-Fi mid-read.
let hangSession = false;

vi.mock('../../../src/ble/handler-esphome-proxy/pool.js', () => {
  class FakeEsphomeProxyPool {
    private subs: Array<(info: BleDeviceInfo, mac: string) => void> = [];
    constructor(_cfg: unknown) {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    emitAdvert(info: BleDeviceInfo, mac: string): void {
      for (const cb of this.subs) cb(info, mac);
    }
    onAdvertisement(cb: (info: BleDeviceInfo, mac: string) => void): () => void {
      this.subs.push(cb);
      return () => {
        this.subs = this.subs.filter((s) => s !== cb);
      };
    }
    async connectGatt(mac: string) {
      connectGattSpy(mac);
      if (hangSession) {
        const silent: BleChar = {
          async read() {
            return Buffer.alloc(0);
          },
          async write() {},
          async subscribe() {
            return () => {};
          },
        };
        return {
          charMap: new Map<string, BleChar>([
            [NOTIFY, silent],
            [WRITE, silent],
          ]),
          device: { onDisconnect: (_cb: () => void) => {}, fireDisconnect: fireDisconnectSpy },
          close: closeSpy,
        };
      }
      let notifyCb: ((d: Buffer) => void) | null = null;
      const notifyChar: BleChar = {
        async read() {
          return Buffer.alloc(0);
        },
        async write() {},
        async subscribe(onData) {
          notifyCb = onData;
          setImmediate(() => notifyCb && notifyCb(Buffer.from([0x01])));
          return () => {};
        },
      };
      const noop: BleChar = {
        async read() {
          return Buffer.alloc(0);
        },
        async write() {},
        async subscribe() {
          return () => {};
        },
      };
      return {
        charMap: new Map<string, BleChar>([
          [NOTIFY, notifyChar],
          [WRITE, noop],
        ]),
        device: { onDisconnect: (_cb: () => void) => {}, fireDisconnect: () => {} },
        close: closeSpy,
      };
    }
  }
  return { EsphomeProxyPool: FakeEsphomeProxyPool };
});

const { ReadingWatcher } = await import('../../../src/ble/handler-esphome-proxy/watcher.js');

const config = { host: 'p1', port: 6053, client_info: 'x', additional_proxies: [] } as never;

function gattAdapter(): ScaleAdapter {
  return {
    name: 'GattMock',
    charNotifyUuid: NOTIFY,
    charWriteUuid: WRITE,
    unlockCommand: [],
    unlockIntervalMs: 0,
    matches: (info: BleDeviceInfo) => info.localName === 'GATT-scale',
    parseNotification: (): ScaleReading => ({ weight: 82, impedance: 0 }),
    isComplete: (r: ScaleReading) => r.weight > 0,
    computeMetrics: (r: ScaleReading) =>
      ({ weight: r.weight }) as ReturnType<ScaleAdapter['computeMetrics']>,
  } as ScaleAdapter;
}

describe('ReadingWatcher GATT continuous (#116)', () => {
  it('connects on demand, queues the GATT reading, closes, and guards re-entry', async () => {
    closeSpy.mockClear();
    connectGattSpy.mockClear();
    const watcher = new ReadingWatcher(config, [gattAdapter()]);
    await watcher.start();

    // Reach the mocked pool instance the watcher created.
    const pool = (
      watcher as unknown as {
        pool: { emitAdvert: (info: BleDeviceInfo, mac: string) => void };
      }
    ).pool;
    const info: BleDeviceInfo = { localName: 'GATT-scale', serviceUuids: [] };
    pool.emitAdvert(info, 'AA:BB:CC:DD:EE:02');
    // A second advert for the same scale while the first GATT read is in flight.
    pool.emitAdvert(info, 'AA:BB:CC:DD:EE:02');

    const reading = await watcher.nextReading();
    expect(reading.reading.weight).toBe(82);
    expect(reading.adapter.name).toBe('GattMock');
    expect(connectGattSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalled();

    await watcher.stop();
  });

  it('bounds a hung GATT read instead of disabling that scale for the process', async () => {
    // waitForRawReading only settles on a reading, a subscribe failure, or the
    // proxy's disconnect frame. An ESP32 that vanishes sends no such frame, so
    // an unbounded read never returns: the finally never runs, gattInFlight is
    // never cleared (that scale is never read again) and the session is never
    // closed (the advertisement watchdog stays disarmed for that endpoint).
    closeSpy.mockClear();
    connectGattSpy.mockClear();
    fireDisconnectSpy.mockClear();
    vi.useFakeTimers();
    try {
      hangSession = true;
      const watcher = new ReadingWatcher(config, [gattAdapter()]);
      await watcher.start();
      const pool = (
        watcher as unknown as {
          pool: { emitAdvert: (info: BleDeviceInfo, mac: string) => void };
        }
      ).pool;
      const info: BleDeviceInfo = { localName: 'GATT-scale', serviceUuids: [] };
      pool.emitAdvert(info, 'AA:BB:CC:DD:EE:03');

      // Past the absolute session cap. Without the bound nothing below happens.
      await vi.advanceTimersByTimeAsync(95_000);

      // Fired BEFORE close(), which splices out the listener the abandoned
      // wait's own teardown path depends on.
      expect(fireDisconnectSpy).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalled();

      // The in-flight guard was released, so the scale is readable again.
      hangSession = false;
      pool.emitAdvert(info, 'AA:BB:CC:DD:EE:03');
      await vi.advanceTimersByTimeAsync(0);
      const reading = await watcher.nextReading();
      expect(reading.reading.weight).toBe(82);
      expect(connectGattSpy).toHaveBeenCalledTimes(2);

      await watcher.stop();
    } finally {
      hangSession = false;
      vi.useRealTimers();
    }
  });
});
