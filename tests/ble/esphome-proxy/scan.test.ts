import { describe, it, expect, vi } from 'vitest';
import type { BleChar } from '../../../src/ble/shared.js';
import { normalizeUuid } from '../../../src/ble/types.js';
import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  UserProfile,
} from '../../../src/interfaces/scale-adapter.js';

const NOTIFY = normalizeUuid('2a9d');
const WRITE = normalizeUuid('2a9c');

// A fake pool: emits one matching advert for a GATT scale, and connectGatt
// returns a session whose notify char delivers one complete weight frame.
const closeSpy = vi.fn(async () => {});

vi.mock('../../../src/ble/handler-esphome-proxy/pool.js', () => {
  class FakeEsphomeProxyPool {
    private subs: Array<(info: BleDeviceInfo, mac: string) => void> = [];
    constructor(_cfg: unknown) {}
    async start(): Promise<void> {
      // Deliver the advert once a subscriber is attached.
      setImmediate(() => {
        for (const cb of this.subs)
          cb({ localName: 'GATT-scale', serviceUuids: [] }, 'AA:BB:CC:DD:EE:01');
      });
    }
    async stop(): Promise<void> {}
    onAdvertisement(cb: (info: BleDeviceInfo, mac: string) => void): () => void {
      this.subs.push(cb);
      return () => {};
    }
    async connectGatt(_mac: string) {
      let notifyCb: ((d: Buffer) => void) | null = null;
      const notifyChar: BleChar = {
        async read() {
          return Buffer.alloc(0);
        },
        async write() {},
        async subscribe(onData) {
          notifyCb = onData;
          // One complete weight frame on the next tick.
          setImmediate(() => notifyCb && notifyCb(Buffer.from([0x01])));
          return () => {};
        },
      };
      const writeChar: BleChar = {
        async read() {
          return Buffer.alloc(0);
        },
        async write() {},
        async subscribe() {
          return () => {};
        },
      };
      const charMap = new Map<string, BleChar>([
        [NOTIFY, notifyChar],
        [WRITE, writeChar],
      ]);
      return {
        charMap,
        device: { onDisconnect: (_cb: () => void) => {} },
        close: closeSpy,
      };
    }
  }
  return { EsphomeProxyPool: FakeEsphomeProxyPool };
});

import { scanAndReadRaw } from '../../../src/ble/handler-esphome-proxy/scan.js';

const profile: UserProfile = { height: 175, age: 30, gender: 'male', isAthlete: false };

function gattAdapter(): ScaleAdapter {
  return {
    name: 'GattMock',
    charNotifyUuid: NOTIFY,
    charWriteUuid: WRITE,
    unlockCommand: [],
    unlockIntervalMs: 0,
    matches: (info: BleDeviceInfo) => info.localName === 'GATT-scale',
    parseNotification: (): ScaleReading => ({ weight: 75, impedance: 0 }),
    isComplete: (r: ScaleReading) => r.weight > 0,
    computeMetrics: (r: ScaleReading) =>
      ({ weight: r.weight }) as ReturnType<ScaleAdapter['computeMetrics']>,
  } as ScaleAdapter;
}

describe('scanAndReadRaw GATT single-shot (#116)', () => {
  it('connects via the pool, reads over GATT, and closes the session', async () => {
    closeSpy.mockClear();
    const result = await scanAndReadRaw({
      adapters: [gattAdapter()],
      profile,
      esphomeProxy: { host: 'p1', port: 6053, client_info: 'x', additional_proxies: [] } as never,
    });
    expect(result.reading.weight).toBe(75);
    expect(result.adapter.name).toBe('GattMock');
    expect(closeSpy).toHaveBeenCalled();
  });
});
