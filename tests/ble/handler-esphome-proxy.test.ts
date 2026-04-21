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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('_internals.formatMacAddress', () => {
  it('zero-pads and formats a uint64 MAC as XX:XX:XX:XX:XX:XX', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy.js');
    expect(mod._internals.formatMacAddress(0x1234567890ab)).toBe('12:34:56:78:90:AB');
    expect(mod._internals.formatMacAddress(0x0000000000ff)).toBe('00:00:00:00:00:FF');
  });
});

describe('_internals.parseManufacturerId', () => {
  it('parses the "0xAABB" legacy format', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy.js');
    expect(mod._internals.parseManufacturerId('0xee57')).toBe(0xee57);
  });

  it('parses the full-UUID format from ensureFullUuid', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy.js');
    expect(mod._internals.parseManufacturerId('0000ee57-0000-1000-8000-00805f9b34fb')).toBe(0xee57);
  });

  it('returns null for empty input', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy.js');
    expect(mod._internals.parseManufacturerId('')).toBeNull();
  });
});

describe('_internals.extractBytes', () => {
  it('prefers legacyDataList when present', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy.js');
    const buf = mod._internals.extractBytes({
      uuid: '0xee57',
      legacyDataList: [0x01, 0x02, 0x03],
    });
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
  });

  it('falls back to base64 `data` when legacy list is empty', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy.js');
    const buf = mod._internals.extractBytes({
      uuid: '0xee57',
      legacyDataList: [],
      data: Buffer.from([0xaa, 0xbb]).toString('base64'),
    });
    expect(buf).toEqual(Buffer.from([0xaa, 0xbb]));
  });

  it('returns empty Buffer when neither field carries bytes', async () => {
    const mod = await import('../../src/ble/handler-esphome-proxy.js');
    expect(mod._internals.extractBytes({ uuid: '0xee57' })).toEqual(Buffer.alloc(0));
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
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy.js');

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
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy.js');

    const promise = scanAndReadRaw({
      adapters: [adapter],
      profile,
      esphomeProxy: config,
      bleHandler: 'esphome-proxy',
    });

    await mockClient.waitForListener('ble');
    // Unknown manufacturer — ignored
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
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy.js');

    const promise = scanAndReadRaw({
      adapters: [adapter],
      profile,
      esphomeProxy: config,
      bleHandler: 'esphome-proxy',
      targetMac: '11:22:33:44:55:66',
    });

    await mockClient.waitForListener('ble');
    // Wrong MAC but matches adapter — should be ignored
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

  it('rejects when the scale is a GATT-only adapter (Phase 1 limitation)', async () => {
    const adapter = makeGattOnlyAdapter();
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy.js');

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
    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy.js');
    await expect(
      scanAndReadRaw({
        adapters: [makeBroadcastAdapter()],
        profile,
        bleHandler: 'esphome-proxy',
      }),
    ).rejects.toThrow(/esphome_proxy config is required/);
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

    const { scanAndReadRaw } = await import('../../src/ble/handler-esphome-proxy.js');
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
    const { ReadingWatcher } = await import('../../src/ble/handler-esphome-proxy.js');
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

  it('deduplicates identical broadcast readings within the dedup window', async () => {
    const adapter = makeBroadcastAdapter();
    const { ReadingWatcher } = await import('../../src/ble/handler-esphome-proxy.js');
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
    const { scanDevices } = await import('../../src/ble/handler-esphome-proxy.js');

    const promise = scanDevices([adapter], 50, config);
    await mockClient.waitForListener('ble');

    // Same address twice — should only appear once
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
