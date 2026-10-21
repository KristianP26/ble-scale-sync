import { describe, it, expect, vi } from 'vitest';
import type { BleChar } from '../../../src/ble/session/ports.js';
import { normalizeUuid, POST_READING_RECONNECT_MS } from '../../../src/ble/types.js';
import { M1690_PROTOCOL_VERSION_REPLY } from '../../helpers/yunmai-m1690.js';
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
// When set, connectGatt rejects with this reason (a full proxy slot, a peer
// that refuses the link).
let failConnectWith: string | null = null;
// When set, connectGatt hands back a session that never notifies but whose
// device does report a disconnect, when the test calls endSilentSession: a
// scale still on after its reading that nobody steps on, until it switches off.
let silentSession = false;
let endSilentSession: (() => void) | null = null;
// When set, the default session's device reports a disconnect right after its
// one notification: a scale that hands over a stored record and switches off.
let disconnectAfterNotify = false;
// When set, connectGatt hands back a session in which the scale sends nothing
// but this buffer, 80 ms after each write: a Yunmai after a weigh-in, which only
// answers the unlock (#474).
let answerWritesWith: Buffer | null = null;
// When set, connectGatt hands back a session whose frames the test sends
// through sendFrame, and whose fireDisconnect reports the disconnect.
let scriptedSession = false;
let sendFrame: ((d: Buffer) => void) | null = null;

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
      if (failConnectWith !== null) throw new Error(failConnectWith);
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
      if (silentSession) {
        const quiet: BleChar = {
          async read() {
            return Buffer.alloc(0);
          },
          async write() {},
          async subscribe() {
            return () => {};
          },
        };
        const disconnectCbs: Array<() => void> = [];
        endSilentSession = () => {
          for (const cb of disconnectCbs.splice(0)) cb();
        };
        return {
          charMap: new Map<string, BleChar>([
            [NOTIFY, quiet],
            [WRITE, quiet],
          ]),
          device: {
            onDisconnect: (cb: () => void) => {
              disconnectCbs.push(cb);
            },
            fireDisconnect: () => {},
          },
          close: closeSpy,
        };
      }
      if (answerWritesWith !== null) {
        const answer = answerWritesWith;
        let onAnswer: ((d: Buffer) => void) | null = null;
        const disconnectCbs: Array<() => void> = [];
        const notify: BleChar = {
          async read() {
            return Buffer.alloc(0);
          },
          async write() {},
          async subscribe(onData) {
            onAnswer = onData;
            return () => {
              onAnswer = null;
            };
          },
        };
        const write: BleChar = {
          async read() {
            return Buffer.alloc(0);
          },
          async write() {
            setTimeout(() => onAnswer?.(answer), 80);
          },
          async subscribe() {
            return () => {};
          },
        };
        return {
          charMap: new Map<string, BleChar>([
            [NOTIFY, notify],
            [WRITE, write],
          ]),
          device: {
            onDisconnect: (cb: () => void) => {
              disconnectCbs.push(cb);
            },
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
      const onDisconnectCbs: Array<() => void> = [];
      const notifyChar: BleChar = {
        async read() {
          return Buffer.alloc(0);
        },
        async write() {},
        async subscribe(onData) {
          notifyCb = onData;
          setImmediate(() => {
            if (notifyCb) notifyCb(Buffer.from([0x01]));
            if (disconnectAfterNotify) {
              setImmediate(() => {
                for (const cb of onDisconnectCbs.splice(0)) cb();
              });
            }
          });
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
        device: {
          onDisconnect: (cb: () => void) => {
            onDisconnectCbs.push(cb);
          },
          fireDisconnect: () => {},
        },
        close: closeSpy,
      };
    }
  }
  return { EsphomeProxyPool: FakeEsphomeProxyPool };
});

const { ReadingWatcher } = await import('../../../src/ble/handler-esphome-proxy/watcher.js');
const { bleLog } = await import('../../../src/ble/types.js');

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

      // Both run: the abandoned wait is told to tear itself down, and the
      // session is closed. fireDisconnect goes first, though the order is not
      // load-bearing - see its doc comment in gatt.ts.
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

describe('ReadingWatcher GATT session timeout with stored records (#331)', () => {
  // A scale that hands over a weigh-in from its memory and then keeps the link
  // up with nobody weighing: the session ends on the idle timeout, and the
  // stored record has to reach the queue anyway. Adapters with a dedup mark
  // count it as reported once they hand it over.
  it('queues the stored record of a session that timed out', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T20:30:00Z'));
      const stored: ScaleReading = {
        weight: 76.55,
        impedance: 0,
        timestamp: new Date('2026-10-07T19:57:25Z'),
      };
      const adapter = {
        ...gattAdapter(),
        parseNotification: (): ScaleReading => ({ ...stored }),
      } as ScaleAdapter;
      const watcher = new ReadingWatcher(config, [adapter]);
      await watcher.start();
      const pool = (
        watcher as unknown as {
          pool: { emitAdvert: (info: BleDeviceInfo, mac: string) => void };
        }
      ).pool;
      pool.emitAdvert({ localName: 'GATT-scale', serviceUuids: [] }, 'AA:BB:CC:DD:EE:05');
      const next = watcher.nextReading();

      // Past the 60 s idle timeout, before the 90 s session cap.
      await vi.advanceTimersByTimeAsync(65_000);
      const raw = await Promise.race([next, Promise.resolve(null)]);
      expect(raw?.reading).toEqual(stored);
      expect(raw?.history ?? []).toEqual([]);

      await watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let the stored record drop a live weigh-in of nearly the same weight right after it', async () => {
    // The person stepped off before the final frame, so the session handed
    // over only the stored record, and stepped on again within the 30 s dedup
    // window. 76.55 and 76.52 both round to 76.5; keyed on weight alone the
    // live weigh-in was a "Dedup skip" and reached no exporter at all.
    vi.useFakeTimers();
    connectGattSpy.mockClear();
    try {
      vi.setSystemTime(new Date('2026-10-07T20:30:00Z'));
      const stored: ScaleReading = {
        weight: 76.55,
        impedance: 0,
        timestamp: new Date('2026-10-07T19:57:25Z'),
      };
      const adapter = {
        ...gattAdapter(),
        parseNotification: (): ScaleReading =>
          connectGattSpy.mock.calls.length > 1 ? { weight: 76.52, impedance: 0 } : { ...stored },
      } as ScaleAdapter;
      const watcher = new ReadingWatcher(config, [adapter]);
      await watcher.start();
      const pool = (
        watcher as unknown as {
          pool: { emitAdvert: (info: BleDeviceInfo, mac: string) => void };
        }
      ).pool;
      const mac = 'AA:BB:CC:DD:EE:06';
      pool.emitAdvert({ localName: 'GATT-scale', serviceUuids: [] }, mac);
      const first = watcher.nextReading();
      await vi.advanceTimersByTimeAsync(65_000);
      expect((await Promise.race([first, Promise.resolve(null)]))?.reading).toEqual(stored);

      // Ten seconds later, well inside the dedup window.
      await vi.advanceTimersByTimeAsync(10_000);
      pool.emitAdvert({ localName: 'GATT-scale', serviceUuids: [] }, mac);
      const second = watcher.nextReading();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connectGattSpy).toHaveBeenCalledTimes(2);
      const live = await Promise.race([second, Promise.resolve(null)]);
      expect(live?.reading).toEqual({ weight: 76.52, impedance: 0 });

      await watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keys a stored-only session by its record time, so only the same record again is a duplicate', async () => {
    // Three sessions a second apart, each handing over one stored record and
    // ending on the scale's disconnect: 76.55 and 76.52 kg share the 76.5
    // bucket but are two weigh-ins, and the third repeats the second.
    const records: ScaleReading[] = [
      { weight: 76.55, impedance: 0, timestamp: new Date('2026-10-07T19:57:25Z') },
      { weight: 76.52, impedance: 0, timestamp: new Date('2026-10-07T20:05:10Z') },
      { weight: 76.52, impedance: 0, timestamp: new Date('2026-10-07T20:05:10Z') },
    ];
    const lines: string[] = [];
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation((m) => void lines.push(String(m)));
    vi.useFakeTimers();
    connectGattSpy.mockClear();
    disconnectAfterNotify = true;
    try {
      vi.setSystemTime(new Date('2026-10-07T20:30:00Z'));
      const adapter = {
        ...gattAdapter(),
        parseNotification: (): ScaleReading => ({
          ...records[connectGattSpy.mock.calls.length - 1],
        }),
      } as ScaleAdapter;
      const watcher = new ReadingWatcher(config, [adapter]);
      await watcher.start();
      const pool = (
        watcher as unknown as {
          pool: { emitAdvert: (info: BleDeviceInfo, mac: string) => void };
        }
      ).pool;
      const mac = 'AA:BB:CC:DD:EE:07';
      const session = async () => {
        pool.emitAdvert({ localName: 'GATT-scale', serviceUuids: [] }, mac);
        const next = watcher.nextReading();
        await vi.advanceTimersByTimeAsync(1_000);
        return (await Promise.race([next, Promise.resolve(null)]))?.reading ?? null;
      };

      expect(await session()).toEqual(records[0]);
      expect(await session()).toEqual(records[1]);
      expect(await session()).toBeNull();
      expect(connectGattSpy).toHaveBeenCalledTimes(3);
      const skip = lines.find((l) => l.startsWith('Dedup skip:'));
      expect(skip ?? '(no line)').toMatch(/:76\.5@2026-10-07T20:05:10\.000Z$/);

      await watcher.stop();
    } finally {
      disconnectAfterNotify = false;
      vi.useRealTimers();
      debug.mockRestore();
    }
  });
});

describe('ReadingWatcher GATT failure logging (B-13)', () => {
  it('keeps reporting why a scale fails after the first warning', async () => {
    // The first failure for an address warns. Every later one used to say
    // nothing at all, at any level, so a scale that broke for good after one
    // transient failure left only "opening GATT via ESPHome proxy" in the log.
    const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const t0 = new Date('2026-10-16T08:00:00Z').getTime();
    vi.setSystemTime(t0);
    const watcher = new ReadingWatcher(config, [gattAdapter()]);
    await watcher.start();
    const pool = (
      watcher as unknown as {
        pool: { emitAdvert: (info: BleDeviceInfo, mac: string) => void };
      }
    ).pool;
    const info: BleDeviceInfo = { localName: 'GATT-scale', serviceUuids: [] };
    const mac = 'AA:BB:CC:DD:EE:04';
    const settle = () => new Promise((r) => setImmediate(r));
    const logged = (spy: typeof warn) => spy.mock.calls.map((c) => String(c[0])).join(' | ');

    try {
      failConnectWith = 'first-reason';
      pool.emitAdvert(info, mac);
      await settle();
      expect(logged(warn)).toContain('first-reason');

      failConnectWith = 'second-reason';
      pool.emitAdvert(info, mac);
      await settle();
      expect(logged(warn)).not.toContain('second-reason');
      expect(logged(debug)).toContain('second-reason');

      // A success clears the record, so the next failure outside the
      // post-reading window is news again.
      failConnectWith = null;
      pool.emitAdvert(info, mac);
      await watcher.nextReading();
      await settle();
      vi.setSystemTime(t0 + POST_READING_RECONNECT_MS + 1);
      failConnectWith = 'third-reason';
      pool.emitAdvert(info, mac);
      await settle();
      expect(logged(warn)).toContain('third-reason');
    } finally {
      failConnectWith = null;
      warn.mockRestore();
      debug.mockRestore();
      vi.useRealTimers();
      await watcher.stop();
    }
  });
});

/**
 * #466: after a reading the scale stays on and keeps advertising, so the next
 * advertisement opens a new session (on purpose: a second person stepping on
 * is read in it). Nobody does, the scale switches off, and that end used to be
 * a WARN "GATT read over the ESPHome proxy failed" after every weigh-in.
 */
describe('ReadingWatcher session after a reading (#466, D058)', () => {
  type Pool = { emitAdvert: (info: BleDeviceInfo, mac: string) => void };
  const poolOf = (w: unknown): Pool => (w as { pool: Pool }).pool;
  const ADVERT: BleDeviceInfo = { localName: 'GATT-scale', serviceUuids: [] };
  const NO_WEIGH_IN =
    /session opened \d+\.\d s after the last reading, while the scale was still on, ended without a new weigh-in/;
  const FAILED = 'GATT read over the ESPHome proxy failed';
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

  function spies() {
    return {
      warn: vi.spyOn(bleLog, 'warn').mockImplementation(() => {}),
      info: vi.spyOn(bleLog, 'info').mockImplementation(() => {}),
      debug: vi.spyOn(bleLog, 'debug').mockImplementation(() => {}),
    };
  }

  function reset(): void {
    failConnectWith = null;
    silentSession = false;
    hangSession = false;
    answerWritesWith = null;
    endSilentSession = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  }

  it('logs the silent session after a reading at info, not as a failure', async () => {
    connectGattSpy.mockClear();
    const log = spies();
    const mac = 'AA:BB:CC:DD:EE:40';
    const watcher = new ReadingWatcher(config, [gattAdapter()]);
    try {
      await watcher.start();
      poolOf(watcher).emitAdvert(ADVERT, mac);
      expect((await watcher.nextReading()).reading.weight).toBe(82);
      await settle();

      silentSession = true;
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await settle();
      expect(endSilentSession).not.toBeNull();
      endSilentSession!();
      await settle();

      // The reconnect itself stays: no hold-off after a reading.
      expect(connectGattSpy).toHaveBeenCalledTimes(2);
      expect(lines(log.warn).filter((l) => l.includes(FAILED))).toEqual([]);
      const told = lines(log.info).filter((l) => NO_WEIGH_IN.test(l));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain(`GattMock at ${mac}: session opened`);
      expect(told[0]).toContain('(Scale disconnected before reading completed)');
    } finally {
      reset();
      await watcher.stop();
    }
  });

  it('still reads a second weigh-in in the session after a reading', async () => {
    // That session is how a second person stepping on before the scale
    // switches off gets read. Another weight, so the 30 s dedup lets it by.
    connectGattSpy.mockClear();
    const log = spies();
    const mac = 'AA:BB:CC:DD:EE:45';
    const adapter = {
      ...gattAdapter(),
      parseNotification: (): ScaleReading => ({
        weight: connectGattSpy.mock.calls.length > 1 ? 64.5 : 82,
        impedance: 0,
      }),
    } as ScaleAdapter;
    const watcher = new ReadingWatcher(config, [adapter]);
    try {
      await watcher.start();
      poolOf(watcher).emitAdvert(ADVERT, mac);
      expect((await watcher.nextReading()).reading.weight).toBe(82);
      await settle();

      poolOf(watcher).emitAdvert(ADVERT, mac);
      expect((await watcher.nextReading()).reading.weight).toBe(64.5);
      expect(lines(log.info).filter((l) => NO_WEIGH_IN.test(l))).toEqual([]);
      expect(lines(log.warn)).toEqual([]);
    } finally {
      reset();
      await watcher.stop();
    }
  });

  it('still warns for a session opened after the window', async () => {
    const log = spies();
    const mac = 'AA:BB:CC:DD:EE:41';
    const t0 = new Date('2026-10-16T08:00:00Z').getTime();
    vi.setSystemTime(t0);
    const watcher = new ReadingWatcher(config, [gattAdapter()]);
    try {
      await watcher.start();
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await watcher.nextReading();
      await settle();

      vi.setSystemTime(t0 + POST_READING_RECONNECT_MS + 1);
      silentSession = true;
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await settle();
      endSilentSession!();
      await settle();

      const failed = lines(log.warn).filter((l) => l.includes(FAILED));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain('(Scale disconnected before reading completed)');
      expect(lines(log.info).filter((l) => NO_WEIGH_IN.test(l))).toEqual([]);
    } finally {
      reset();
      await watcher.stop();
    }
  });

  it('leaves the failure tracker alone, so a real failure after the window warns', async () => {
    const log = spies();
    const mac = 'AA:BB:CC:DD:EE:42';
    const t0 = new Date('2026-10-16T08:00:00Z').getTime();
    vi.setSystemTime(t0);
    const watcher = new ReadingWatcher(config, [gattAdapter()]);
    try {
      await watcher.start();
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await watcher.nextReading();
      await settle();

      failConnectWith = 'quiet-reason';
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await settle();
      expect(
        lines(log.info)
          .filter((l) => NO_WEIGH_IN.test(l))
          .join(' | '),
      ).toContain('quiet-reason');
      expect(lines(log.warn)).toEqual([]);

      vi.setSystemTime(t0 + 61_000);
      failConnectWith = 'later-reason';
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await settle();
      expect(lines(log.warn).join(' | ')).toContain('later-reason');
    } finally {
      reset();
      await watcher.stop();
    }
  });

  it('tells once per reading and logs the repeats at debug', async () => {
    const log = spies();
    const mac = 'AA:BB:CC:DD:EE:43';
    const watcher = new ReadingWatcher(config, [gattAdapter()]);
    try {
      await watcher.start();
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await watcher.nextReading();
      await settle();

      failConnectWith = 'slot-busy';
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await settle();
      failConnectWith = 'scale-gone';
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await settle();

      const told = lines(log.info).filter((l) => NO_WEIGH_IN.test(l));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain('(slot-busy)');
      expect(
        lines(log.debug)
          .filter((l) => NO_WEIGH_IN.test(l))
          .join(' | '),
      ).toContain('scale-gone');
      expect(lines(log.warn)).toEqual([]);
    } finally {
      reset();
      await watcher.stop();
    }
  });

  it('decides by when the session opened, not by when it ended', async () => {
    // Opened 1 s after the reading, ended by the 60 s idle timeout 61 s after
    // it: past the window by then, and still the reconnect to a scale still on.
    const log = spies();
    const mac = 'AA:BB:CC:DD:EE:44';
    vi.useFakeTimers();
    const watcher = new ReadingWatcher(config, [gattAdapter()]);
    try {
      await watcher.start();
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await vi.advanceTimersByTimeAsync(0);
      await watcher.nextReading();

      await vi.advanceTimersByTimeAsync(1000);
      hangSession = true;
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await vi.advanceTimersByTimeAsync(65_000);

      expect(lines(log.warn).filter((l) => l.includes(FAILED))).toEqual([]);
      const told = lines(log.info).filter((l) => NO_WEIGH_IN.test(l));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain(`(GATT reading timeout for ${mac})`);
    } finally {
      reset();
      await watcher.stop();
    }
  });

  it('treats the reconnects to a scale that stays on as one window, measured from the reading (#474)', async () => {
    // Each session after the reading runs 60 s and the scale is connected
    // again 2 s after it ends. The second and third opened 63 s and 125 s
    // after the reading; the second used to warn as a failure. The third
    // shows the window follows every such session, not only the first.
    const log = spies();
    const mac = 'AA:BB:CC:DD:EE:47';
    const t0 = new Date('2026-10-20T13:34:16Z').getTime();
    vi.setSystemTime(t0);
    const watcher = new ReadingWatcher(config, [gattAdapter()]);
    try {
      await watcher.start();
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await watcher.nextReading();
      await settle();

      silentSession = true;
      let end = t0;
      for (const gap of [1000, 2000, 2000]) {
        vi.setSystemTime(end + gap);
        poolOf(watcher).emitAdvert(ADVERT, mac);
        await settle();
        end = Date.now() + 60_000;
        vi.setSystemTime(end);
        endSilentSession!();
        await settle();
      }

      expect(lines(log.warn).filter((l) => l.includes(FAILED))).toEqual([]);
      expect(lines(log.info).filter((l) => NO_WEIGH_IN.test(l))).toHaveLength(1);
      expect(lines(log.debug).filter((l) => NO_WEIGH_IN.test(l))).toEqual([
        expect.stringContaining('session opened 63.0 s after the last reading'),
        expect.stringContaining('session opened 125.0 s after the last reading'),
      ]);

      // A session opened more than 60 s after the last of them warns again.
      vi.setSystemTime(end + POST_READING_RECONNECT_MS + 1);
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await settle();
      endSilentSession!();
      await settle();
      expect(lines(log.warn).filter((l) => l.includes(FAILED))).toHaveLength(1);
    } finally {
      reset();
      await watcher.stop();
    }
  });

  it('ends the session after a reading on the idle timeout when the scale only answers the unlock (#474)', async () => {
    // A Yunmai Mini 2 stays connectable after a weigh-in and answers each
    // GET_PROTOCOL_VERSION we write, every 5 s. Counted as activity, those
    // replies held the session open until the 90 s cap (D070).
    closeSpy.mockClear();
    const log = spies();
    const mac = 'AA:BB:CC:DD:EE:46';
    const adapter = {
      ...gattAdapter(),
      unlockCommand: [0x0d, 0x05, 0x13, 0x00, 0x16],
      unlockIntervalMs: 5000,
      parseNotification: (d: Buffer): ScaleReading | null =>
        d.length === 5 ? null : { weight: 82, impedance: 0 },
      isStatusFrame: (_c: string, d: Buffer) => d[3] === 0x05,
    } as ScaleAdapter;
    vi.useFakeTimers();
    const watcher = new ReadingWatcher(config, [adapter]);
    try {
      await watcher.start();
      poolOf(watcher).emitAdvert(ADVERT, mac);
      await vi.advanceTimersByTimeAsync(0);
      expect((await watcher.nextReading()).reading.weight).toBe(82);
      const closedAfterReading = closeSpy.mock.calls.length;

      await vi.advanceTimersByTimeAsync(1000);
      answerWritesWith = M1690_PROTOCOL_VERSION_REPLY;
      poolOf(watcher).emitAdvert(ADVERT, mac);
      // The idle timeout arms once connectGatt of this session returns.
      await vi.advanceTimersByTimeAsync(60_500);

      const told = lines(log.info).filter((l) => NO_WEIGH_IN.test(l));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain(`(GATT reading timeout for ${mac})`);
      expect(
        [...lines(log.info), ...lines(log.warn)].filter((l) => l.includes('session cap')),
      ).toEqual([]);
      expect(closeSpy.mock.calls.length).toBeGreaterThan(closedAfterReading);
    } finally {
      reset();
      await watcher.stop();
    }
  });
});

/**
 * The watcher is built and hot-reloaded from src/runtime/sources.ts. Before, a
 * reload that removed the Beurer PIN kept the old one because updateConfig
 * only assigned a truthy scaleAuth.
 */
describe('ReadingWatcher config: PIN removal, device name', () => {
  type Pool = { emitAdvert: (info: BleDeviceInfo, mac: string) => void };
  const poolOf = (w: unknown): Pool => (w as { pool: Pool }).pool;
  const ADVERT: BleDeviceInfo = { localName: 'GATT-scale', serviceUuids: [] };

  it('drops the PIN when a reload no longer carries one, and passes the device name', async () => {
    const seen: Array<{ pin?: number; name?: string }> = [];
    const adapter = {
      ...gattAdapter(),
      onConnected: async (ctx: Parameters<NonNullable<ScaleAdapter['onConnected']>>[0]) => {
        seen.push({ pin: ctx.scaleAuth?.pin, name: ctx.deviceName });
      },
    } as ScaleAdapter;
    const watcher = new ReadingWatcher(config, [adapter], undefined, undefined, { pin: 1234 });
    watcher.updateConfig({ adapters: [adapter], scaleAuth: undefined });
    await watcher.start();
    poolOf(watcher).emitAdvert(ADVERT, 'AA:BB:CC:DD:EE:12');
    await watcher.nextReading();
    expect(seen).toEqual([{ pin: undefined, name: 'GATT-scale' }]);
    await watcher.stop();
  });

  it('resolves the user profile again for every GATT session (#331)', async () => {
    const anchors: Array<number | undefined> = [];
    const adapter = {
      ...gattAdapter(),
      onConnected: async (ctx: Parameters<NonNullable<ScaleAdapter['onConnected']>>[0]) => {
        anchors.push(ctx.profile.lastKnownWeight);
      },
    } as ScaleAdapter;
    // The processor moves last_known_weight after every export; the watcher
    // must not keep the value it had when it was built.
    const weights = [70, 72.5];
    const profile = vi.fn(() => ({
      height: 180,
      age: 40,
      gender: 'male' as const,
      isAthlete: false,
      lastKnownWeight: weights.shift(),
    }));
    const watcher = new ReadingWatcher(config, [adapter], undefined, profile);
    await watcher.start();
    poolOf(watcher).emitAdvert(ADVERT, 'AA:BB:CC:DD:EE:13');
    await watcher.nextReading();
    poolOf(watcher).emitAdvert(ADVERT, 'AA:BB:CC:DD:EE:14');
    await watcher.nextReading();
    expect(anchors).toEqual([70, 72.5]);
    await watcher.stop();
  });
});

// #461: the proxy delivers the advertisement and its scan response as two
// events, and the one that matches (named) need not carry the manufacturer
// data. The bytes are the #461 Physiq advertisement (node-ble log); the split
// into a nameless event with them and a named one without is synthetic.
describe('ReadingWatcher manufacturer data handoff (#461)', () => {
  type Pool = { emitAdvert: (info: BleDeviceInfo, mac: string) => void };
  const poolOf = (w: unknown): Pool => (w as { pool: Pool }).pool;
  const MFG_461 = {
    id: 0xffff,
    data: Buffer.from('081401000025e0160005ff6108010015', 'hex'),
  };
  const MAC = 'FF:05:00:16:E0:25';

  function recordingAdapter(
    matched: BleDeviceInfo[],
    ctxMfg: Array<{ id: number; data: Buffer } | undefined>,
  ): ScaleAdapter {
    return {
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
  }

  it('hands the last seen manufacturer data to the session, not to the matcher', async () => {
    const matched: BleDeviceInfo[] = [];
    const ctxMfg: Array<{ id: number; data: Buffer } | undefined> = [];
    const watcher = new ReadingWatcher(config, [recordingAdapter(matched, ctxMfg)]);
    await watcher.start();
    poolOf(watcher).emitAdvert({ localName: '', serviceUuids: [], manufacturerData: MFG_461 }, MAC);
    poolOf(watcher).emitAdvert(
      { localName: 'GATT-scale', serviceUuids: [normalizeUuid('ffe0')] },
      MAC,
    );
    await watcher.nextReading();
    expect(ctxMfg).toEqual([MFG_461]);
    // Advertisement-time and post-discovery resolution both saw the named event
    // as it arrived, without the cached manufacturer data.
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.every((info) => info.manufacturerData === undefined)).toBe(true);
    await watcher.stop();
  });

  it('hands none when no event for that address carried any', async () => {
    const matched: BleDeviceInfo[] = [];
    const ctxMfg: Array<{ id: number; data: Buffer } | undefined> = [];
    const watcher = new ReadingWatcher(config, [recordingAdapter(matched, ctxMfg)]);
    await watcher.start();
    poolOf(watcher).emitAdvert({ localName: '', serviceUuids: [], manufacturerData: MFG_461 }, MAC);
    poolOf(watcher).emitAdvert({ localName: 'GATT-scale', serviceUuids: [] }, 'AA:BB:CC:DD:EE:31');
    await watcher.nextReading();
    expect(ctxMfg).toEqual([undefined]);
    await watcher.stop();
  });
});

// Characterization of the watcher session policy (arch wave 2): a 90 s cap
// that frames do not restart and a composition hold does not move; the cap
// hands the held weight over.
describe('ReadingWatcher GATT session cap', () => {
  type Pool = { emitAdvert: (info: BleDeviceInfo, mac: string) => void };
  const ADVERT: BleDeviceInfo = { localName: 'GATT-scale', serviceUuids: [] };

  async function session(
    adapter: ScaleAdapter,
    mac: string,
    drive: () => Promise<void>,
  ): Promise<{ warns: string[]; reading: ScaleReading | null; atMs: number }> {
    vi.useFakeTimers();
    scriptedSession = true;
    const warns: string[] = [];
    let t0 = 0;
    const warn = vi
      .spyOn(bleLog, 'warn')
      .mockImplementation((m) => void warns.push(`${Date.now() - t0} ms: ${String(m)}`));
    const watcher = new ReadingWatcher(config, [adapter]);
    try {
      await watcher.start();
      t0 = Date.now();
      let reading: ScaleReading | null = null;
      let atMs = -1;
      void watcher.nextReading().then((r) => {
        reading = r.reading;
        atMs = Date.now() - t0;
      });
      (watcher as unknown as { pool: Pool }).pool.emitAdvert(ADVERT, mac);
      await vi.advanceTimersByTimeAsync(0);
      await drive();
      return { warns, reading, atMs };
    } finally {
      await watcher.stop();
      scriptedSession = false;
      sendFrame = null;
      warn.mockRestore();
      vi.useRealTimers();
    }
  }

  it('ends a session that keeps sending rejected frames at 90 s', async () => {
    const mac = 'AA:BB:CC:DD:EE:60';
    const adapter = { ...gattAdapter(), parseNotification: () => null } as ScaleAdapter;
    const { warns } = await session(adapter, mac, async () => {
      for (let t = 0; t < 120_000; t += 30_000) {
        sendFrame?.(Buffer.from([0x01]));
        await vi.advanceTimersByTimeAsync(30_000);
      }
    });
    expect(warns).toEqual([
      `90000 ms: GattMock at ${mac}: GATT read over the ESPHome proxy failed ` +
        `(GATT session cap exceeded for ${mac}). Will retry on the next advertisement.`,
    ]);
  });

  it('hands a held weight over at the cap, which the hold does not move', async () => {
    const adapter = {
      ...gattAdapter(),
      completionHoldMs: 120_000,
      isFinal: () => false,
    } as ScaleAdapter;
    const { reading, atMs } = await session(adapter, 'AA:BB:CC:DD:EE:61', async () => {
      sendFrame?.(Buffer.from([0x01]));
      await vi.advanceTimersByTimeAsync(125_000);
    });
    expect(reading).toEqual({ weight: 82, impedance: 0 });
    expect(atMs).toBe(90_000);
  });
});
