import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type {
  ScaleAdapter,
  ScaleReading,
  BodyComposition,
  UserProfile,
  BleDeviceInfo,
} from '../../src/interfaces/scale-adapter.js';
import type { EsphomeProxyConfig } from '../../src/config/schema.js';

// Suppress log output
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

// ─── Mock ESPHome client ─────────────────────────────────────────────────────

class MockEsphomeClient extends EventEmitter {
  connected = false;
  connect = vi.fn(() => {
    // Simulate successful auth on next tick
    setImmediate(() => {
      this.connected = true;
      this.emit('connected');
    });
  });
  disconnect = vi.fn(() => {
    this.connected = false;
    this.emit('disconnected');
  });
  /** Wait until the handler has attached a listener for `event`. */
  waitForListener = (event: string, timeoutMs = 2000): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (this.listenerCount(event) > 0) return resolve();
      const deadline = Date.now() + timeoutMs;
      const tick = (): void => {
        if (this.listenerCount(event) > 0) return resolve();
        if (Date.now() > deadline) {
          return reject(new Error(`Timed out waiting for listener on "${event}"`));
        }
        setTimeout(tick, 5);
      };
      setTimeout(tick, 5);
    });
  };
  /** Simulate a BLE advertisement push from the proxy. */
  pushBle(msg: Record<string, unknown>): void {
    this.emit('ble', msg);
  }
}

let mockClient: MockEsphomeClient;

vi.mock('@2colors/esphome-native-api', () => ({
  Client: class {
    constructor() {
      return mockClient;
    }
  },
}));

// ─── Test data ───────────────────────────────────────────────────────────────

const config: EsphomeProxyConfig = {
  host: 'esphome.local',
  port: 6053,
  client_info: 'ble-scale-sync',
} as EsphomeProxyConfig;

const profile: UserProfile = { height: 175, age: 30, gender: 'male', isAthlete: false };

function makeBroadcastAdapter(): ScaleAdapter {
  return {
    name: 'MockBroadcast',
    matches: vi.fn(
      (info: BleDeviceInfo) => info.manufacturerData?.id === 0xee57,
    ) as ScaleAdapter['matches'],
    parseBroadcast: vi.fn((data: Buffer): ScaleReading | null =>
      data.length >= 2 ? { weight: 75.5, impedance: 400 } : null,
    ) as ScaleAdapter['parseBroadcast'],
    isComplete: (r: ScaleReading): boolean => r.weight > 0,
    computeMetrics: (r: ScaleReading): BodyComposition => ({
      weight: r.weight,
      impedance: r.impedance,
    }),
    parseNotification: () => null,
    // broadcast-only scale: no GATT UUIDs
    charNotifyUuid: undefined as unknown as string,
    charWriteUuid: undefined as unknown as string,
    unlockCommand: [],
    unlockIntervalMs: 0,
  } as unknown as ScaleAdapter;
}

/**
 * Passive-scan adapter (e.g. Mi Scale 2): preferPassive=true, parses
 * service-data UUID 0x181B. Returns weight-only on the first frame and
 * weight+impedance on subsequent frames. Emulates the Xiaomi flow where the
 * scale streams partial frames during BIA. The behaviour is configurable per
 * test via `mode` so a single adapter can model the three branches.
 */
function makePassiveAdapter(
  mode: 'complete' | 'partial-then-complete' | 'always-partial',
): ScaleAdapter {
  let frameIdx = 0;
  return {
    name: 'MockPassive',
    preferPassive: true,
    matches: vi.fn(
      (info: BleDeviceInfo) => Array.isArray(info.serviceData) && info.serviceData.length > 0,
    ) as ScaleAdapter['matches'],
    parseServiceData: vi.fn((_uuid: string, _data: Buffer): ScaleReading | null => {
      const i = frameIdx++;
      switch (mode) {
        case 'complete':
          return { weight: 70.0, impedance: 500 };
        case 'partial-then-complete':
          return i === 0 ? { weight: 70.0, impedance: 0 } : { weight: 70.0, impedance: 500 };
        case 'always-partial':
          return { weight: 70.0, impedance: 0 };
      }
    }) as ScaleAdapter['parseServiceData'],
    isComplete: (r: ScaleReading): boolean => r.weight > 0 && r.impedance > 0,
    computeMetrics: (r: ScaleReading): BodyComposition => ({
      weight: r.weight,
      impedance: r.impedance,
    }),
    parseNotification: () => null,
    charNotifyUuid: undefined as unknown as string,
    charWriteUuid: undefined as unknown as string,
    unlockCommand: [],
    unlockIntervalMs: 0,
  } as unknown as ScaleAdapter;
}

function makeGattOnlyAdapter(): ScaleAdapter {
  return {
    name: 'MockGattOnly',
    matches: vi.fn((info: BleDeviceInfo) => info.localName === 'GATT-scale'),
    isComplete: (r: ScaleReading): boolean => r.weight > 0,
    computeMetrics: (r: ScaleReading): BodyComposition => ({
      weight: r.weight,
      impedance: r.impedance,
    }),
    parseNotification: () => null,
    charNotifyUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
    charWriteUuid: '0000ffe2-0000-1000-8000-00805f9b34fb',
    unlockCommand: [],
    unlockIntervalMs: 1000,
  } as unknown as ScaleAdapter;
}

/**
 * Dual-mode adapter: parseBroadcast is defined but returns null for this frame
 * (e.g. QN Elis 1 / ES-30M beacon). charNotifyUuid is set, so the handler
 * should emit the Phase 2 GATT warning instead of silently dropping.
 */
function makeDualModeAdapter(): ScaleAdapter {
  return {
    name: 'MockDualMode',
    matches: vi.fn((info: BleDeviceInfo) => info.localName === 'DualMode-scale'),
    parseBroadcast: vi.fn((): ScaleReading | null => null) as ScaleAdapter['parseBroadcast'],
    isComplete: (r: ScaleReading): boolean => r.weight > 0,
    computeMetrics: (r: ScaleReading): BodyComposition => ({
      weight: r.weight,
      impedance: r.impedance,
    }),
    parseNotification: () => null,
    charNotifyUuid: '0000fff1-0000-1000-8000-00805f9b34fb',
    charWriteUuid: '0000fff2-0000-1000-8000-00805f9b34fb',
    unlockCommand: [],
    unlockIntervalMs: 0,
  } as unknown as ScaleAdapter;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('_internals.formatMacAddress', () => {
  it('zero-pads and formats a uint64 MAC as XX:XX:XX:XX:XX:XX', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy/index.js');
    expect(mod._internals.formatMacAddress(0x1234567890ab)).toBe('12:34:56:78:90:AB');
    expect(mod._internals.formatMacAddress(0x0000000000ff)).toBe('00:00:00:00:00:FF');
  });
});

describe('_internals.parseManufacturerId', () => {
  it('parses the "0xAABB" legacy format', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy/index.js');
    expect(mod._internals.parseManufacturerId('0xee57')).toBe(0xee57);
  });

  it('parses the full-UUID format from ensureFullUuid', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy/index.js');
    expect(mod._internals.parseManufacturerId('0000ee57-0000-1000-8000-00805f9b34fb')).toBe(0xee57);
  });

  it('returns null for empty input', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy/index.js');
    expect(mod._internals.parseManufacturerId('')).toBeNull();
  });
});

describe('_internals.extractBytes', () => {
  it('prefers legacyDataList when present', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy/index.js');
    const buf = mod._internals.extractBytes({
      uuid: '0xee57',
      legacyDataList: [0x01, 0x02, 0x03],
    });
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
  });

  it('falls back to base64 `data` when legacy list is empty', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy/index.js');
    const buf = mod._internals.extractBytes({
      uuid: '0xee57',
      legacyDataList: [],
      data: Buffer.from([0xaa, 0xbb]).toString('base64'),
    });
    expect(buf).toEqual(Buffer.from([0xaa, 0xbb]));
  });

  it('returns empty Buffer when neither field carries bytes', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy/index.js');
    expect(mod._internals.extractBytes({ uuid: '0xee57' })).toEqual(Buffer.alloc(0));
  });
});

describe('transport capability summary (#116)', () => {
  beforeEach(() => {
    mockClient = new MockEsphomeClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const summaryLines = (logSpy: ReturnType<typeof vi.spyOn>): string[] =>
    logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /ESPHome proxy transport ready \(broadcast \+ GATT\)/.test(s));

  it('scanAndReadRaw logs a broadcast + GATT summary, no Phase 1 wording', async () => {
    const broadcast = makeBroadcastAdapter();
    const gattOnly = makeGattOnlyAdapter();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy/index.js');

    const promise = scanAndReadRaw({
      adapters: [broadcast, gattOnly],
      profile,
      esphomeProxy: config,
      bleHandler: 'esphome-proxy',
    });

    await mockClient.waitForListener('ble');

    const summary = summaryLines(logSpy);
    expect(summary.length).toBe(1);
    expect(summary[0]).toMatch(/Broadcast adapters: MockBroadcast/);
    expect(summary[0]).toMatch(/GATT adapters \(connected on demand\): MockGattOnly/);
    expect(summary[0]).not.toMatch(/broadcast-only/);
    expect(summary[0]).not.toMatch(/Phase 1/);

    // Unblock the pending promise with a matching broadcast advertisement
    mockClient.pushBle({
      address: 0x112233445566,
      name: 'MyScale',
      rssi: -60,
      manufacturerDataList: [{ uuid: '0xee57', legacyDataList: [0x01, 0x02], data: '' }],
    });
    await promise;
    logSpy.mockRestore();
  });

  it('ReadingWatcher.start logs the broadcast + GATT summary once', async () => {
    const broadcast = makeBroadcastAdapter();
    const gattOnly = makeGattOnlyAdapter();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ReadingWatcher } = await import('../../src/ble/handler-esphome-proxy/index.js');
    const watcher = new ReadingWatcher(config, [broadcast, gattOnly]);

    const startPromise = watcher.start();
    await mockClient.waitForListener('ble');
    await startPromise;

    const summary = summaryLines(logSpy);
    expect(summary.length).toBe(1);
    expect(summary[0]).toMatch(/MockBroadcast/);
    expect(summary[0]).toMatch(/MockGattOnly/);

    logSpy.mockRestore();
    await watcher.stop();
  });

  it('omits the GATT section when every configured adapter is broadcast-capable', async () => {
    const broadcast = makeBroadcastAdapter();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ReadingWatcher } = await import('../../src/ble/handler-esphome-proxy/index.js');
    const watcher = new ReadingWatcher(config, [broadcast]);

    const startPromise = watcher.start();
    await mockClient.waitForListener('ble');
    await startPromise;

    const summary = summaryLines(logSpy);
    expect(summary.length).toBe(1);
    expect(summary[0]).toMatch(/Broadcast adapters: MockBroadcast/);
    expect(summary[0]).not.toMatch(/GATT adapters/);

    logSpy.mockRestore();
    await watcher.stop();
  });
});

describe('scanAndReadRaw', () => {
  beforeEach(() => {
    mockClient = new MockEsphomeClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves with a broadcast reading when a matching adapter parses it', async () => {
    const adapter = makeBroadcastAdapter();
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy/index.js');

    const promise = scanAndReadRaw({
      adapters: [adapter],
      profile,
      esphomeProxy: config,
      bleHandler: 'esphome-proxy',
    });

    // Wait a tick for connection, then push an ad
    await mockClient.waitForListener('ble');
    mockClient.pushBle({
      address: 0x1234567890ab,
      name: 'MyScale',
      rssi: -60,
      serviceUuidsList: [],
      serviceDataList: [],
      manufacturerDataList: [{ uuid: '0xee57', legacyDataList: [0x01, 0x02, 0x03], data: '' }],
      addressType: 0,
    });

    const result = await promise;
    expect(result.adapter.name).toBe('MockBroadcast');
    expect(result.reading.weight).toBe(75.5);
    expect(mockClient.disconnect).toHaveBeenCalled();
  });

  it('ignores non-matching advertisements and waits for a match', async () => {
    const adapter = makeBroadcastAdapter();
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy/index.js');

    const promise = scanAndReadRaw({
      adapters: [adapter],
      profile,
      esphomeProxy: config,
      bleHandler: 'esphome-proxy',
    });

    await mockClient.waitForListener('ble');
    // Unknown manufacturer, should be ignored
    mockClient.pushBle({
      address: 0xaabbccddeeff,
      name: 'SomeOtherDevice',
      rssi: -70,
      serviceUuidsList: [],
      serviceDataList: [],
      manufacturerDataList: [{ uuid: '0x1234', legacyDataList: [0x00], data: '' }],
      addressType: 0,
    });
    // Matching ad
    mockClient.pushBle({
      address: 0x112233445566,
      name: 'MyScale',
      rssi: -60,
      serviceUuidsList: [],
      serviceDataList: [],
      manufacturerDataList: [{ uuid: '0xee57', legacyDataList: [0x01, 0x02, 0x03], data: '' }],
      addressType: 0,
    });

    const result = await promise;
    expect(result.reading.weight).toBe(75.5);
  });

  it('filters by targetMac when provided', async () => {
    const adapter = makeBroadcastAdapter();
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy/index.js');

    const promise = scanAndReadRaw({
      adapters: [adapter],
      profile,
      esphomeProxy: config,
      bleHandler: 'esphome-proxy',
      targetMac: '11:22:33:44:55:66',
    });

    await mockClient.waitForListener('ble');
    // Wrong MAC but matches adapter; should be ignored
    mockClient.pushBle({
      address: 0x1234567890ab,
      name: 'MyScale',
      rssi: -60,
      serviceUuidsList: [],
      serviceDataList: [],
      manufacturerDataList: [{ uuid: '0xee57', legacyDataList: [0x01, 0x02], data: '' }],
      addressType: 0,
    });
    // Correct MAC + matches
    mockClient.pushBle({
      address: 0x112233445566,
      name: 'MyScale',
      rssi: -60,
      serviceUuidsList: [],
      serviceDataList: [],
      manufacturerDataList: [{ uuid: '0xee57', legacyDataList: [0x0a, 0x0b], data: '' }],
      addressType: 0,
    });

    const result = await promise;
    expect(result.reading.weight).toBe(75.5);
    // parseBroadcast only called for the MAC-filtered entry
    expect((adapter.matches as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      1,
    );
  });

  it('rejects when a GATT scale cannot be connected on any proxy', async () => {
    const adapter = makeGattOnlyAdapter();
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy/index.js');

    const promise = scanAndReadRaw({
      adapters: [adapter],
      profile,
      esphomeProxy: config,
      bleHandler: 'esphome-proxy',
    });

    await mockClient.waitForListener('ble');
    mockClient.pushBle({
      address: 0xaabbccddeeff,
      name: 'GATT-scale',
      rssi: -60,
      serviceUuidsList: [],
      serviceDataList: [],
      manufacturerDataList: [],
      addressType: 0,
    });

    await expect(promise).rejects.toThrow(/GATT/);
    expect(mockClient.disconnect).toHaveBeenCalled();
  });

  it('throws when esphome_proxy config is missing', async () => {
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy/index.js');
    await expect(
      scanAndReadRaw({
        adapters: [makeBroadcastAdapter()],
        profile,
        bleHandler: 'esphome-proxy',
      }),
    ).rejects.toThrow(/esphome_proxy config is required/);
  });
});

// 12 s impedance grace timer for passive-scan adapters (Mi Scale 2 etc.).
// See #163. These tests lock the three branches of the partial-frame path.
describe('scanAndReadRaw, grace timer (passive scan)', () => {
  beforeEach(() => {
    mockClient = new MockEsphomeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function pushPassiveAd(): void {
    mockClient.pushBle({
      address: 0x112233445566,
      name: '',
      rssi: -55,
      serviceUuidsList: [],
      serviceDataList: [{ uuid: '0x181b', legacyDataList: [0x01, 0x02, 0x03, 0x04], data: '' }],
      manufacturerDataList: [],
      addressType: 0,
    });
  }

  it('complete-immediately: emits as soon as the first frame is complete (no timer)', async () => {
    const adapter = makePassiveAdapter('complete');
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy/index.js');

    const promise = scanAndReadRaw({
      adapters: [adapter],
      profile,
      esphomeProxy: config,
      bleHandler: 'esphome-proxy',
    });

    await mockClient.waitForListener('ble');
    pushPassiveAd();

    const result = await promise;
    expect(result.adapter.name).toBe('MockPassive');
    expect(result.reading.weight).toBe(70.0);
    expect(result.reading.impedance).toBe(500);
    // Only one parseServiceData call; the timer never fired
    expect(adapter.parseServiceData).toHaveBeenCalledTimes(1);
  });

  it('partial-then-complete: cancels the grace timer when a complete frame arrives', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const adapter = makePassiveAdapter('partial-then-complete');
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy/index.js');

    const promise = scanAndReadRaw({
      adapters: [adapter],
      profile,
      esphomeProxy: config,
      bleHandler: 'esphome-proxy',
    });

    await mockClient.waitForListener('ble');
    // First frame: weight-only, grace timer arms
    pushPassiveAd();
    const clearsAfterPartial = clearTimeoutSpy.mock.calls.length;
    // Second frame within grace window: weight+impedance, should win and clear the timer
    pushPassiveAd();

    const result = await promise;
    expect(result.reading.impedance).toBe(500);
    expect(adapter.parseServiceData).toHaveBeenCalledTimes(2);
    // Headline check: clearTimeout fired between partial and resolve, proving
    // the grace timer was cancelled rather than racing the complete frame.
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearsAfterPartial);
    clearTimeoutSpy.mockRestore();
  });

  it('partial-then-timeout: emits the weight-only fallback after IMPEDANCE_GRACE_MS', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const adapter = makePassiveAdapter('always-partial');
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy/index.js');
    const { IMPEDANCE_GRACE_MS } = await import('../../src/ble/types.js');

    const promise = scanAndReadRaw({
      adapters: [adapter],
      profile,
      esphomeProxy: config,
      bleHandler: 'esphome-proxy',
    });

    // Flush microtasks + setImmediate so MockEsphomeClient connects and the
    // 'ble' listener is attached. setImmediate is not faked, so this just
    // works without timer manipulation.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    pushPassiveAd();
    // Advance past grace window: timer fires, weight-only fallback resolves.
    await vi.advanceTimersByTimeAsync(IMPEDANCE_GRACE_MS + 100);

    const result = await promise;
    expect(result.reading.weight).toBe(70.0);
    expect(result.reading.impedance).toBe(0);
  });
});

describe('waitForConnected via scanAndReadRaw', () => {
  beforeEach(() => {
    mockClient = new MockEsphomeClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when the client emits an error before connecting', async () => {
    // Override the default connect to emit error instead of connected
    mockClient.connect = vi.fn(() => {
      setImmediate(() => {
        mockClient.emit('error', new Error('ECONNREFUSED: proxy down'));
      });
    });

    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy/index.js');
    await expect(
      scanAndReadRaw({
        adapters: [makeBroadcastAdapter()],
        profile,
        esphomeProxy: config,
        bleHandler: 'esphome-proxy',
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('ReadingWatcher', () => {
  beforeEach(() => {
    mockClient = new MockEsphomeClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues broadcast readings for consumption via nextReading()', async () => {
    const adapter = makeBroadcastAdapter();
    const { ReadingWatcher } = await import('../../src/ble/handler-esphome-proxy/index.js');
    const watcher = new ReadingWatcher(config, [adapter]);

    const startPromise = watcher.start();
    await mockClient.waitForListener('ble');
    await startPromise;

    mockClient.pushBle({
      address: 0x112233445566,
      name: 'MyScale',
      rssi: -55,
      manufacturerDataList: [{ uuid: '0xee57', legacyDataList: [0x01, 0x02, 0x03], data: '' }],
    });

    const reading = await watcher.nextReading();
    expect(reading.adapter.name).toBe('MockBroadcast');
    expect(reading.reading.weight).toBe(75.5);
    await watcher.stop();
  });

  it('warns once per address when a dual-mode adapter matches but the broadcast frame is not weight-bearing (e.g. Elis 1 MAC beacon)', async () => {
    const adapter = makeDualModeAdapter();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ReadingWatcher } = await import('../../src/ble/handler-esphome-proxy/index.js');
    const watcher = new ReadingWatcher(config, [adapter]);

    const startPromise = watcher.start();
    await mockClient.waitForListener('ble');
    await startPromise;

    // Push two ads from the same scale. Second should not re-warn (LRU-deduped).
    const ad = {
      address: 0xff04002255_0f,
      name: 'DualMode-scale',
      rssi: -60,
      manufacturerDataList: [
        { uuid: '0xffff', legacyDataList: [0x0c, 0xcb, 0x01, 0x00], data: '' },
      ],
    };
    mockClient.pushBle(ad);
    mockClient.pushBle(ad);

    const gattWarn = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /Phase 1 is broadcast-only/i.test(s));
    expect(gattWarn.length).toBe(1);
    expect(gattWarn[0]).toMatch(/MockDualMode/);
    expect(gattWarn[0]).toMatch(/GATT/);

    warnSpy.mockRestore();
    await watcher.stop();
  });

  it('deduplicates identical broadcast readings within the dedup window', async () => {
    const adapter = makeBroadcastAdapter();
    const { ReadingWatcher } = await import('../../src/ble/handler-esphome-proxy/index.js');
    const watcher = new ReadingWatcher(config, [adapter]);

    const startPromise = watcher.start();
    await mockClient.waitForListener('ble');
    await startPromise;

    // Same address + weight twice in quick succession
    for (let i = 0; i < 2; i++) {
      mockClient.pushBle({
        address: 0x112233445566,
        name: 'MyScale',
        rssi: -55,
        manufacturerDataList: [{ uuid: '0xee57', legacyDataList: [0x01, 0x02, 0x03], data: '' }],
      });
    }

    const first = await watcher.nextReading();
    expect(first.reading.weight).toBe(75.5);
    // Second push should have been deduplicated, so the queue has no more readings.
    // Race it against a short timeout to confirm nothing arrives.
    const ac = new AbortController();
    const raceResult = await Promise.race([
      watcher.nextReading(ac.signal).then(() => 'got-reading'),
      new Promise((r) => setTimeout(() => r('no-reading'), 50)),
    ]);
    ac.abort();
    expect(raceResult).toBe('no-reading');
    await watcher.stop();
  });
});

describe('scanDevices', () => {
  beforeEach(() => {
    mockClient = new MockEsphomeClient();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('collects unique devices seen during the scan window', async () => {
    const adapter = makeBroadcastAdapter();
    const { scanDevices } = await import('../../src/ble/handler-esphome-proxy/index.js');

    const promise = scanDevices([adapter], 50, config);
    await mockClient.waitForListener('ble');

    // Same address twice; should only appear once
    mockClient.pushBle({
      address: 0x112233445566,
      name: 'MyScale',
      rssi: -60,
      manufacturerDataList: [{ uuid: '0xee57', legacyDataList: [0x01, 0x02], data: '' }],
    });
    mockClient.pushBle({
      address: 0x112233445566,
      name: 'MyScale',
      rssi: -60,
      manufacturerDataList: [{ uuid: '0xee57', legacyDataList: [0x01, 0x02], data: '' }],
    });
    // Different address, unknown
    mockClient.pushBle({
      address: 0xaabbccddeeff,
      name: 'OtherDevice',
      rssi: -70,
      manufacturerDataList: [{ uuid: '0x0000', legacyDataList: [0x00], data: '' }],
    });

    const results = await promise;
    expect(results).toHaveLength(2);
    const matched = results.find((r) => r.matchedAdapter === 'MockBroadcast');
    expect(matched?.address).toBe('11:22:33:44:55:66');
    expect(mockClient.disconnect).toHaveBeenCalled();
  });
});
