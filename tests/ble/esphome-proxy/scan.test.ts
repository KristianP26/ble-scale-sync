import { describe, it, expect, vi } from 'vitest';
import type { BleChar } from '../../../src/ble/session/ports.js';
import { bleLog, normalizeUuid } from '../../../src/ble/types.js';
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
const fireDisconnectSpy = vi.fn();
// When set, connectGatt hands back a session that never notifies and whose
// device never reports a disconnect - an ESP32 that dropped off Wi-Fi mid-read.
let hangSession = false;
// When set, start() delivers these events instead of the default named pair.
let startAdverts: Array<[BleDeviceInfo, string]> | null = null;
// When set, connectGatt hands back a session whose frames the test sends
// through sendFrame, and whose fireDisconnect reports the disconnect.
let scriptedSession = false;
let sendFrame: ((d: Buffer) => void) | null = null;

vi.mock('../../../src/ble/handler-esphome-proxy/pool.js', () => {
  class FakeEsphomeProxyPool {
    private subs: Array<(info: BleDeviceInfo, mac: string) => void> = [];
    constructor(_cfg: unknown) {}
    async start(): Promise<void> {
      // Deliver the advert (twice, same MAC) once a subscriber is attached:
      // exercises the GATT in-flight guard and scanDevices dedup.
      setImmediate(() => {
        for (const cb of this.subs) {
          if (startAdverts) {
            for (const [info, mac] of startAdverts) cb(info, mac);
            continue;
          }
          cb({ localName: 'GATT-scale', serviceUuids: [] }, 'AA:BB:CC:DD:EE:01');
          cb({ localName: 'GATT-scale', serviceUuids: [] }, 'AA:BB:CC:DD:EE:01');
        }
      });
    }
    async stop(): Promise<void> {}
    onAdvertisement(cb: (info: BleDeviceInfo, mac: string) => void): () => void {
      this.subs.push(cb);
      return () => {};
    }
    async connectGatt(_mac: string) {
      if (scriptedSession) {
        const disconnectCbs: Array<() => void> = [];
        const scripted: BleChar = {
          async read() {
            return Buffer.alloc(0);
          },
          async write() {},
          async subscribe(onData) {
            sendFrame = onData;
            return () => {};
          },
        };
        return {
          charMap: new Map<string, BleChar>([
            [NOTIFY, scripted],
            [WRITE, scripted],
          ]),
          device: {
            onDisconnect: (cb: () => void) => void disconnectCbs.push(cb),
            fireDisconnect: () => {
              for (const cb of disconnectCbs.splice(0)) cb();
            },
          },
          close: closeSpy,
        };
      }
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
        device: { onDisconnect: (_cb: () => void) => {}, fireDisconnect: () => {} },
        close: closeSpy,
      };
    }
  }
  return { EsphomeProxyPool: FakeEsphomeProxyPool };
});

import { scanAndReadRaw, scanDevices } from '../../../src/ble/handler-esphome-proxy/scan.js';

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

  // The one-shot path had the same unbounded read as the watcher: on this
  // transport waitForRawReading only settles on a reading, a subscribe failure,
  // or the proxy's disconnect frame, and a proxy that vanished sends none. The
  // outer BROADCAST_WAIT_MS race only ABANDONS the promise, so without the
  // inner bound plus fireDisconnect the wait keeps its notify unsubscribers and
  // its unlock interval for the life of the process.
  it('tells an abandoned GATT read to tear itself down after the scan gives up', async () => {
    closeSpy.mockClear();
    fireDisconnectSpy.mockClear();
    vi.useFakeTimers();
    try {
      hangSession = true;
      const scan = scanAndReadRaw({
        adapters: [gattAdapter()],
        profile,
        esphomeProxy: {
          host: 'p1',
          port: 6053,
          client_info: 'x',
          additional_proxies: [],
        } as never,
      }).catch((e: unknown) => e);

      // Past both the 60 s scan window and the 60 s GATT idle bound.
      await vi.advanceTimersByTimeAsync(130_000);

      await scan;
      expect(fireDisconnectSpy).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      hangSession = false;
      vi.useRealTimers();
    }
  });

  // A shutdown ends the GATT session at once, as on node-ble (A-07, D051).
  // The scan itself already rejected on the abort, but the session used to
  // run on until its own idle bound or hold settled it, which a 5 s
  // force-exit grace does not wait for, and a held reading then logged
  // "Reading complete" for a weigh-in that went nowhere (#463).
  it('ends the GATT session at once when the scan is aborted', async () => {
    closeSpy.mockClear();
    fireDisconnectSpy.mockClear();
    vi.useFakeTimers();
    try {
      hangSession = true;
      const shutdown = new AbortController();
      const scan = scanAndReadRaw({
        adapters: [gattAdapter()],
        profile,
        esphomeProxy: {
          host: 'p1',
          port: 6053,
          client_info: 'x',
          additional_proxies: [],
        } as never,
        abortSignal: shutdown.signal,
      }).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(1000);
      expect(closeSpy).not.toHaveBeenCalled();
      shutdown.abort(new Error('shutting down'));
      await vi.advanceTimersByTimeAsync(0);

      expect(await scan).toEqual(new Error('shutting down'));
      expect(fireDisconnectSpy).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      hangSession = false;
      vi.useRealTimers();
    }
  });
});

// Characterization of the single-shot session policy (arch wave 2): a 60 s
// idle bound and no cap, so a scale that keeps sending frames keeps its
// session past the scan's own deadline; a shutdown hands nothing over.
describe('scanAndReadRaw GATT session policy', () => {
  const PROXY = { host: 'p1', port: 6053, client_info: 'x', additional_proxies: [] } as never;

  it('bounds the session by 60 s of silence and nothing else', async () => {
    closeSpy.mockClear();
    vi.useFakeTimers();
    scriptedSession = true;
    try {
      const adapter = { ...gattAdapter(), parseNotification: () => null } as ScaleAdapter;
      const scan = scanAndReadRaw({ adapters: [adapter], profile, esphomeProxy: PROXY }).catch(
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(1000);
      for (let t = 0; t < 300_000; t += 30_000) {
        sendFrame?.(Buffer.from([0x01]));
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(await scan).toBeInstanceOf(Error);
      expect(closeSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(closeSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      scriptedSession = false;
      sendFrame = null;
      vi.useRealTimers();
    }
  });

  it('hands a held weight nowhere on a shutdown', async () => {
    vi.useFakeTimers();
    scriptedSession = true;
    const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    try {
      const shutdown = new AbortController();
      const adapter = {
        ...gattAdapter(),
        completionHoldMs: 30_000,
        isFinal: () => false,
      } as ScaleAdapter;
      const scan = scanAndReadRaw({
        adapters: [adapter],
        profile,
        esphomeProxy: PROXY,
        abortSignal: shutdown.signal,
      }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      sendFrame?.(Buffer.from([0x01]));
      await vi.advanceTimersByTimeAsync(1000);
      shutdown.abort(new Error('shutting down'));
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await scan).toEqual(new Error('shutting down'));
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.startsWith('Reading complete'))).toEqual([]);
    } finally {
      scriptedSession = false;
      sendFrame = null;
      info.mockRestore();
      vi.useRealTimers();
    }
  });
});

// #461: the proxy delivers the advertisement and its scan response as two
// events, and the one that matches (named) need not carry the manufacturer
// data. The bytes are the #461 Physiq advertisement (node-ble log) with MAC
// echoed at [5..10] in place of its own; the split into a nameless event with
// them and a named one without is synthetic.
describe('scanAndReadRaw manufacturer data handoff (#461)', () => {
  const MFG_461 = {
    id: 0xffff,
    data: Buffer.from('08140100000100000000026108010015', 'hex'),
  };
  const MAC = '02:00:00:00:00:01';

  it('hands the last seen manufacturer data to the session, not to the matcher', async () => {
    const matched: BleDeviceInfo[] = [];
    const ctxMfg: Array<{ id: number; data: Buffer } | undefined> = [];
    const adapter = {
      ...gattAdapter(),
      matches: (info: BleDeviceInfo) => {
        if (info.localName !== 'GATT-scale') return false;
        matched.push(info);
        return true;
      },
      onConnected: async (ctx: Parameters<NonNullable<ScaleAdapter['onConnected']>>[0]) => {
        ctxMfg.push(ctx.manufacturerData);
      },
    } as ScaleAdapter;
    startAdverts = [
      [{ localName: '', serviceUuids: [], manufacturerData: MFG_461 }, MAC],
      [{ localName: 'GATT-scale', serviceUuids: [normalizeUuid('ffe0')] }, MAC],
    ];
    try {
      const result = await scanAndReadRaw({
        adapters: [adapter],
        profile,
        esphomeProxy: {
          host: 'p1',
          port: 6053,
          client_info: 'x',
          additional_proxies: [],
        } as never,
      });
      expect(result.reading.weight).toBe(75);
      expect(ctxMfg).toEqual([MFG_461]);
      expect(matched.length).toBeGreaterThan(0);
      expect(matched.every((info) => info.manufacturerData === undefined)).toBe(true);
    } finally {
      startAdverts = null;
    }
  });
});

describe('scanDevices via pool (#116)', () => {
  it('dedups repeated advertisements and records the matched adapter', async () => {
    const results = await scanDevices([gattAdapter()], 30, {
      host: 'p1',
      port: 6053,
      client_info: 'x',
      additional_proxies: [],
    } as never);
    expect(results).toHaveLength(1);
    expect(results[0].address).toBe('AA:BB:CC:DD:EE:01');
    expect(results[0].matchedAdapter).toBe('GattMock');
  });
});
