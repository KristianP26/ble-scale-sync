import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ScaleAdapter,
  ScaleReading,
  BodyComposition,
  UserProfile,
  BleDeviceInfo,
} from '../../src/interfaces/scale-adapter.js';
import type { MqttProxyConfig } from '../../src/config/schema.js';

// Suppress log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

// ─── Mock MQTT client ────────────────────────────────────────────────────────

interface MockMqttClient {
  connected: boolean;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  subscribeAsync: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  unsubscribeAsync: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  publishAsync: ReturnType<typeof vi.fn>;
  endAsync: ReturnType<typeof vi.fn>;
  _listeners: Map<string, Array<(topic: string, payload: Buffer) => void>>;
  _simulateMessage: (topic: string, payload: string | Buffer) => void;
}

function createMockMqttClient(): MockMqttClient {
  const listeners = new Map<string, Array<(topic: string, payload: Buffer) => void>>();

  const client: MockMqttClient = {
    connected: true,
    _listeners: listeners,
    on: vi.fn((event: string, handler: (topic: string, payload: Buffer) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
      return client;
    }),
    removeListener: vi.fn((event: string, handler: (topic: string, payload: Buffer) => void) => {
      const handlers = listeners.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
      return client;
    }),
    subscribe: vi.fn(() => client),
    subscribeAsync: vi.fn(async () => []),
    unsubscribe: vi.fn(() => client),
    unsubscribeAsync: vi.fn(async () => undefined),
    publish: vi.fn(() => client),
    publishAsync: vi.fn(async () => undefined),
    endAsync: vi.fn(async () => undefined),
    _simulateMessage(topic: string, payload: string | Buffer) {
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      const handlers = listeners.get('message') ?? [];
      for (const handler of [...handlers]) {
        handler(topic, buf);
      }
    },
  };

  return client;
}

// ─── Mock mqtt module ────────────────────────────────────────────────────────

let mockClient: MockMqttClient;

vi.mock('mqtt', () => ({
  connectAsync: vi.fn(async () => mockClient),
}));

// ─── Test data ───────────────────────────────────────────────────────────────

const MQTT_PROXY_CONFIG: MqttProxyConfig = {
  broker_url: 'mqtt://localhost:1883',
  device_id: 'esp32-test',
  topic_prefix: 'ble-proxy',
  username: null,
  password: null,
};

const PREFIX = 'ble-proxy/esp32-test';

const PROFILE: UserProfile = { height: 180, age: 30, gender: 'male', isAthlete: false };

const BODY_COMP: BodyComposition = {
  weight: 75.5,
  impedance: 500,
  bmi: 23.3,
  bodyFatPercent: 18.2,
  waterPercent: 55.1,
  boneMass: 3.1,
  muscleMass: 58.4,
  visceralFat: 5,
  physiqueRating: 5,
  bmr: 1650,
  metabolicAge: 28,
};

function createBroadcastAdapter(name = 'BroadcastScale'): ScaleAdapter {
  return {
    name,
    charNotifyUuid: '',
    charWriteUuid: '',
    unlockCommand: [],
    unlockIntervalMs: 0,
    matches: vi.fn((info: BleDeviceInfo) => info.manufacturerData?.id === 0xffff),
    parseBroadcast: vi.fn((data: Buffer) => {
      const weight = data.readUInt16LE(0) / 100;
      return { weight, impedance: 0 };
    }),
    parseNotification: vi.fn(() => null),
    isComplete: vi.fn(() => true),
    computeMetrics: vi.fn(() => BODY_COMP),
  };
}

/** Passive-scan adapter analogous to Mi Scale 2 (preferPassive + parseServiceData). */
function createPassiveAdapter(
  mode: 'complete' | 'partial-then-complete' | 'always-partial',
  name = 'PassiveScale',
): ScaleAdapter {
  let frameIdx = 0;
  return {
    name,
    charNotifyUuid: '',
    charWriteUuid: '',
    unlockCommand: [],
    unlockIntervalMs: 0,
    preferPassive: true,
    matches: vi.fn(
      (info: BleDeviceInfo) => Array.isArray(info.serviceData) && info.serviceData.length > 0,
    ),
    parseServiceData: vi.fn((_uuid: string, _data: Buffer) => {
      const i = frameIdx++;
      switch (mode) {
        case 'complete':
          return { weight: 70.0, impedance: 500 };
        case 'partial-then-complete':
          return i === 0 ? { weight: 70.0, impedance: 0 } : { weight: 70.0, impedance: 500 };
        case 'always-partial':
          return { weight: 70.0, impedance: 0 };
      }
    }),
    parseNotification: vi.fn(() => null),
    isComplete: vi.fn((r: ScaleReading) => r.weight > 0 && r.impedance > 0),
    computeMetrics: vi.fn(() => BODY_COMP),
  } as unknown as ScaleAdapter;
}

/** GATT-only adapter: matches by name, no parseBroadcast, uses notifications. */
const GATT_NOTIFY_UUID = '0000fff400001000800000805f9b34fb';
const GATT_WRITE_UUID = '0000fff100001000800000805f9b34fb';

function createGattAdapter(name = 'GattScale'): ScaleAdapter {
  let reading: ScaleReading | null = null;
  return {
    name,
    charNotifyUuid: GATT_NOTIFY_UUID,
    charWriteUuid: GATT_WRITE_UUID,
    unlockCommand: [0xa5, 0x01],
    unlockIntervalMs: 2000,
    matches: vi.fn((info: BleDeviceInfo) => info.localName === 'GattScale'),
    parseNotification: vi.fn((data: Buffer) => {
      // Simple protocol: 2-byte LE weight in centikg, 2-byte LE impedance
      if (data.length >= 4) {
        reading = { weight: data.readUInt16LE(0) / 100, impedance: data.readUInt16LE(2) };
        return reading;
      }
      return null;
    }),
    isComplete: vi.fn(() => reading !== null && reading.impedance > 0),
    computeMetrics: vi.fn(() => BODY_COMP),
  };
}

/**
 * Dual-mode adapter analogous to the real QN Scale: declares `parseBroadcast`
 * (for the AABB broadcast variant) AND exposes a GATT notify/write path. A
 * matched device that carries no broadcast data must fall through to GATT
 * rather than being silently skipped (#201).
 */
function createDualModeAdapter(name = 'DualScale'): ScaleAdapter {
  let gattReading: ScaleReading | null = null;
  return {
    name,
    charNotifyUuid: GATT_NOTIFY_UUID,
    charWriteUuid: GATT_WRITE_UUID,
    unlockCommand: [0xa5, 0x01],
    unlockIntervalMs: 2000,
    matches: vi.fn(
      (info: BleDeviceInfo) =>
        info.localName === 'DualScale' || info.manufacturerData?.id === 0xffff,
    ),
    parseBroadcast: vi.fn((data: Buffer) => ({
      weight: data.readUInt16LE(0) / 100,
      impedance: 0,
    })),
    parseNotification: vi.fn((data: Buffer) => {
      if (data.length >= 4) {
        gattReading = { weight: data.readUInt16LE(0) / 100, impedance: data.readUInt16LE(2) };
        return gattReading;
      }
      return null;
    }),
    isComplete: vi.fn((r: ScaleReading) => (r.impedance === 0 ? r.weight > 0 : r.impedance > 0)),
    computeMetrics: vi.fn(() => BODY_COMP),
  };
}

// ─── Import the module under test ────────────────────────────────────────────

// Must import AFTER vi.mock
const {
  scanAndReadRaw,
  scanAndRead,
  scanDevices,
  publishConfig,
  publishBeep,
  registerScaleMac,
  publishDisplayReading,
  publishDisplayResult,
  setDisplayUsers,
  AsyncQueue,
  ReadingWatcher,
  _resetProxyState,
} = await import('../../src/ble/handler-mqtt-proxy/index.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a manufacturer data hex string with weight encoded at offset 0. */
function mfrHex(weightCentkg: number): string {
  const buf = Buffer.alloc(4);
  buf.writeUInt16LE(weightCentkg, 0);
  return buf.toString('hex');
}

/**
 * Wire up the mock client to simulate ESP32 online + scan results with
 * broadcast manufacturer data.
 */
function wireBroadcastFlow(
  scanResults: Array<{
    address: string;
    name: string;
    rssi: number;
    services: string[];
    manufacturer_id?: number;
    manufacturer_data?: string;
  }>,
) {
  mockClient.subscribeAsync = vi.fn(async (topic: string) => {
    if (topic === `${PREFIX}/status`) {
      queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
    }
    if (topic === `${PREFIX}/scan/results`) {
      queueMicrotask(() =>
        mockClient._simulateMessage(`${PREFIX}/scan/results`, JSON.stringify(scanResults)),
      );
    }
    return [];
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetProxyState();
  mockClient = createMockMqttClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handler-mqtt-proxy', () => {
  describe('scanAndReadRaw', () => {
    it('broadcast happy path: scan → match → extract reading', async () => {
      const adapter = createBroadcastAdapter();

      wireBroadcastFlow([
        {
          address: 'AA:BB:CC:DD:EE:FF',
          name: '',
          rssi: -50,
          services: [],
          manufacturer_id: 0xffff,
          manufacturer_data: mfrHex(7550), // 75.50 kg
        },
      ]);

      const result = await scanAndReadRaw({
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      expect(result.reading.weight).toBe(75.5);
      expect(result.adapter.name).toBe('BroadcastScale');
      expect(adapter.matches).toHaveBeenCalled();
      expect(adapter.parseBroadcast).toHaveBeenCalled();

      // Should NOT have published any connect command
      const connectCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/connect`,
      );
      expect(connectCalls).toHaveLength(0);

      // Should have torn down MQTT client
      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('rejects when ESP32 is offline', async () => {
      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'offline'));
        }
        return [];
      });

      await expect(
        scanAndReadRaw({
          adapters: [createBroadcastAdapter()],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow('ESP32 proxy is offline');

      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('rejects when mqttProxy config is missing', async () => {
      await expect(
        scanAndReadRaw({
          adapters: [createBroadcastAdapter()],
          profile: PROFILE,
        }),
      ).rejects.toThrow('mqtt_proxy config is required');
    });

    it('falls back to GATT when adapter matches but no broadcast data', async () => {
      const adapter = createGattAdapter();

      // Wire up: online → scan results (no mfr data) → GATT connect response → notification
      // Key: connected response must be triggered by publishAsync(connect), not subscribeAsync(connected),
      // because mqttGattConnect registers the handler AFTER subscribing but BEFORE publishing.
      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                {
                  address: 'AA:BB:CC:DD:EE:FF',
                  name: 'GattScale',
                  rssi: -50,
                  services: [],
                  addr_type: 0,
                },
              ]),
            ),
          );
        }
        return [];
      });

      // Intercept publishAsync to simulate ESP32 GATT responses
      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/connected`,
              JSON.stringify({
                chars: [
                  { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
                  { uuid: GATT_WRITE_UUID, properties: ['write'] },
                ],
              }),
            ),
          );
        }
        // When unlock command is written, simulate a notification
        if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(7550, 0); // 75.50 kg
            buf.writeUInt16LE(500, 2); // impedance 500
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
          });
        }
        return origPublish(topic, payload);
      });

      const result = await scanAndReadRaw({
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      expect(result.reading.weight).toBe(75.5);
      expect(result.reading.impedance).toBe(500);
      expect(result.adapter.name).toBe('GattScale');

      // Should have published connect command
      const connectCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/connect`,
      );
      expect(connectCalls).toHaveLength(1);
      expect(JSON.parse(connectCalls[0][1] as string)).toEqual({
        address: 'AA:BB:CC:DD:EE:FF',
        addr_type: 0,
      });

      // Should have published disconnect
      const disconnectCalls = (
        mockClient.publishAsync as ReturnType<typeof vi.fn>
      ).mock.calls.filter((c: unknown[]) => c[0] === `${PREFIX}/disconnect`);
      expect(disconnectCalls).toHaveLength(1);
    });

    it('dual-mode adapter with no broadcast data falls back to GATT (#201)', async () => {
      // Regression: a QN-Scale-style adapter declares parseBroadcast but the
      // matched device advertises only a name + service UUID (no manufacturer
      // data). It must still reach the GATT path instead of being skipped.
      const adapter = createDualModeAdapter();

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                {
                  address: 'AA:BB:CC:DD:EE:FF',
                  name: 'DualScale',
                  rssi: -80,
                  services: ['ffe0'],
                  addr_type: 0,
                },
              ]),
            ),
          );
        }
        return [];
      });

      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/connected`,
              JSON.stringify({
                chars: [
                  { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
                  { uuid: GATT_WRITE_UUID, properties: ['write'] },
                ],
              }),
            ),
          );
        }
        if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(7550, 0); // 75.50 kg
            buf.writeUInt16LE(500, 2); // impedance 500
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
          });
        }
        return origPublish(topic, payload);
      });

      const result = await scanAndReadRaw({
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      expect(result.reading.weight).toBe(75.5);
      expect(result.reading.impedance).toBe(500);

      const connectCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/connect`,
      );
      expect(connectCalls).toHaveLength(1);
    });

    it('dual-mode adapter uses broadcast when manufacturer data is present', async () => {
      // The same adapter, when the device DOES broadcast a parseable frame,
      // must take the passive path and never open a GATT connection.
      const adapter = createDualModeAdapter();

      wireBroadcastFlow([
        {
          address: 'AA:BB:CC:DD:EE:FF',
          name: '',
          rssi: -50,
          services: [],
          manufacturer_id: 0xffff,
          manufacturer_data: mfrHex(7550),
        },
      ]);

      const result = await scanAndReadRaw({
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      expect(result.reading.weight).toBe(75.5);
      expect(adapter.parseBroadcast).toHaveBeenCalled();

      const connectCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/connect`,
      );
      expect(connectCalls).toHaveLength(0);
    });

    it('filters scan results by targetMac', async () => {
      const adapter = createBroadcastAdapter();

      wireBroadcastFlow([
        {
          address: '11:22:33:44:55:66',
          name: '',
          rssi: -50,
          services: [],
          manufacturer_id: 0xffff,
          manufacturer_data: mfrHex(6000), // 60.00 kg — wrong device
        },
        {
          address: 'AA:BB:CC:DD:EE:FF',
          name: '',
          rssi: -60,
          services: [],
          manufacturer_id: 0xffff,
          manufacturer_data: mfrHex(7550), // 75.50 kg — target device
        },
      ]);

      const result = await scanAndReadRaw({
        targetMac: 'AA:BB:CC:DD:EE:FF',
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      expect(result.reading.weight).toBe(75.5);
    });

    it('rejects when targetMac is not found in scan results', async () => {
      const adapter = createBroadcastAdapter();

      wireBroadcastFlow([
        {
          address: '11:22:33:44:55:66',
          name: '',
          rssi: -50,
          services: [],
          manufacturer_id: 0xffff,
          manufacturer_data: mfrHex(6000),
        },
      ]);

      await expect(
        scanAndReadRaw({
          targetMac: 'AA:BB:CC:DD:EE:FF',
          adapters: [adapter],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow('Target device AA:BB:CC:DD:EE:FF not found');
    });

    it('rejects when no scale is recognized', async () => {
      const adapter = createBroadcastAdapter();

      wireBroadcastFlow([
        {
          address: 'AA:BB:CC:DD:EE:FF',
          name: 'SomeOtherDevice',
          rssi: -50,
          services: [],
          // No manufacturer_id matching 0xffff
        },
      ]);

      await expect(
        scanAndReadRaw({
          adapters: [adapter],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow('No recognized scale found via ESP32 proxy');
    });
  });

  describe('scanAndRead', () => {
    it('calls computeMetrics on the broadcast reading', async () => {
      const adapter = createBroadcastAdapter();

      wireBroadcastFlow([
        {
          address: 'AA:BB:CC:DD:EE:FF',
          name: '',
          rssi: -50,
          services: [],
          manufacturer_id: 0xffff,
          manufacturer_data: mfrHex(7550),
        },
      ]);

      const result = await scanAndRead({
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      expect(result).toEqual(BODY_COMP);
      expect(adapter.computeMetrics).toHaveBeenCalledWith({ weight: 75.5, impedance: 0 }, PROFILE);
    });
  });

  describe('scanDevices', () => {
    it('parses results and matches adapters', async () => {
      const adapter = createBroadcastAdapter();

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                {
                  address: 'AA:BB:CC:DD:EE:FF',
                  name: '',
                  rssi: -50,
                  services: [],
                  manufacturer_id: 0xffff,
                  manufacturer_data: mfrHex(7550),
                },
                { address: '11:22:33:44:55:66', name: 'Unknown', rssi: -80, services: [] },
              ]),
            ),
          );
        }
        return [];
      });

      const results = await scanDevices([adapter], undefined, MQTT_PROXY_CONFIG);

      expect(results).toHaveLength(2);
      expect(results[0].address).toBe('AA:BB:CC:DD:EE:FF');
      expect(results[0].matchedAdapter).toBe('BroadcastScale');
      expect(results[1].address).toBe('11:22:33:44:55:66');
      expect(results[1].matchedAdapter).toBeUndefined();
      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('rejects when mqttProxy config is missing', async () => {
      await expect(scanDevices([createBroadcastAdapter()])).rejects.toThrow(
        'mqtt_proxy config is required',
      );
    });
  });

  describe('cleanup', () => {
    it('MQTT client always disconnected in finally', async () => {
      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'offline'));
        }
        return [];
      });

      await expect(
        scanAndReadRaw({
          adapters: [createBroadcastAdapter()],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow();

      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('cleans up message listeners on timeout', async () => {
      // Don't respond to status — let it timeout
      const result = scanAndReadRaw({
        adapters: [createBroadcastAdapter()],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      await expect(result).rejects.toThrow('ESP32 proxy did not respond');

      // All message listeners should be cleaned up
      const remaining = mockClient._listeners.get('message') ?? [];
      expect(remaining).toHaveLength(0);
    }, 35_000);
  });

  describe('publishConfig', () => {
    it('publishes scale MACs with retain flag', async () => {
      await publishConfig(MQTT_PROXY_CONFIG, ['ED:67:39:4B:27:FC']);

      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/config`,
        JSON.stringify({ scales: ['ED:67:39:4B:27:FC'] }),
        { retain: true },
      );
      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('publishes empty scales array', async () => {
      await publishConfig(MQTT_PROXY_CONFIG, []);

      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/config`,
        JSON.stringify({ scales: [] }),
        { retain: true },
      );
    });

    it('includes autoConnect:false when auto_connect is disabled', async () => {
      await publishConfig({ ...MQTT_PROXY_CONFIG, auto_connect: false }, ['AA:BB:CC:DD:EE:FF']);

      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/config`,
        JSON.stringify({ scales: ['AA:BB:CC:DD:EE:FF'], autoConnect: false }),
        { retain: true },
      );
    });

    it('omits autoConnect field when auto_connect is true (default)', async () => {
      await publishConfig({ ...MQTT_PROXY_CONFIG, auto_connect: true }, ['AA:BB:CC:DD:EE:FF']);

      const payload = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const parsed = JSON.parse(payload);
      expect(parsed).not.toHaveProperty('autoConnect');
    });
  });

  describe('registerScaleMac', () => {
    it('publishes discovered MAC to config topic', async () => {
      await registerScaleMac(MQTT_PROXY_CONFIG, 'FF:EE:DD:CC:BB:AA');

      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/config`,
        expect.stringContaining('FF:EE:DD:CC:BB:AA'),
        { retain: true },
      );
    });

    it('deduplicates MACs (case-insensitive)', async () => {
      // Register once
      await registerScaleMac(MQTT_PROXY_CONFIG, 'FF:EE:DD:CC:BB:AA');
      expect(mockClient.publishAsync).toHaveBeenCalledTimes(1);

      // Reset mock call count, then register same MAC in different case
      (mockClient.publishAsync as ReturnType<typeof vi.fn>).mockClear();
      await registerScaleMac(MQTT_PROXY_CONFIG, 'ff:ee:dd:cc:bb:aa');

      // Should not publish again — same MAC already known
      expect(mockClient.publishAsync).not.toHaveBeenCalled();
    });
  });

  describe('publishBeep', () => {
    it('publishes beep with freq, duration, and repeat', async () => {
      await publishBeep(MQTT_PROXY_CONFIG, 1200, 200, 2);

      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/beep`,
        JSON.stringify({ freq: 1200, duration: 200, repeat: 2 }),
      );
      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('publishes empty payload for default beep', async () => {
      await publishBeep(MQTT_PROXY_CONFIG);

      expect(mockClient.publishAsync).toHaveBeenCalledWith(`${PREFIX}/beep`, '');
    });

    it('publishes partial params (freq only)', async () => {
      await publishBeep(MQTT_PROXY_CONFIG, 600);

      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/beep`,
        JSON.stringify({ freq: 600 }),
      );
    });
  });

  describe('publishConfig with users', () => {
    it('includes users in config payload when provided', async () => {
      const users = [
        { slug: 'alice', name: 'Alice', weight_range: { min: 55, max: 65 } },
        { slug: 'bob', name: 'Bob', weight_range: { min: 75, max: 85 } },
      ];
      await publishConfig(MQTT_PROXY_CONFIG, ['AA:BB:CC:DD:EE:FF'], users);

      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/config`,
        JSON.stringify({ scales: ['AA:BB:CC:DD:EE:FF'], users }),
        { retain: true },
      );
    });

    it('omits users key when users array is empty', async () => {
      await publishConfig(MQTT_PROXY_CONFIG, ['AA:BB:CC:DD:EE:FF'], []);

      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/config`,
        JSON.stringify({ scales: ['AA:BB:CC:DD:EE:FF'] }),
        { retain: true },
      );
    });

    it('omits users key when not provided', async () => {
      await publishConfig(MQTT_PROXY_CONFIG, ['AA:BB:CC:DD:EE:FF']);

      const payload = JSON.parse(
        (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string,
      );
      expect(payload).not.toHaveProperty('users');
    });
  });

  describe('setDisplayUsers', () => {
    it('stores users for inclusion in registerScaleMac config publishes', async () => {
      setDisplayUsers([{ slug: 'alice', name: 'Alice', weight_range: { min: 55, max: 65 } }]);

      // registerScaleMac with a new MAC should include users in the config publish
      await registerScaleMac(MQTT_PROXY_CONFIG, '11:22:33:44:55:66');

      const payload = JSON.parse(
        (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string,
      );
      expect(payload.users).toEqual([
        { slug: 'alice', name: 'Alice', weight_range: { min: 55, max: 65 } },
      ]);

      // Clean up
      setDisplayUsers([]);
    });
  });

  describe('publishDisplayReading', () => {
    it('publishes reading to display/reading topic', async () => {
      await publishDisplayReading(MQTT_PROXY_CONFIG, 'alice', 'Alice', 58.23, 512, [
        'Garmin Connect',
        'MQTT',
      ]);

      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/display/reading`,
        JSON.stringify({
          slug: 'alice',
          name: 'Alice',
          weight: 58.23,
          exporters: ['Garmin Connect', 'MQTT'],
          impedance: 512,
        }),
      );
      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('omits impedance when undefined', async () => {
      await publishDisplayReading(MQTT_PROXY_CONFIG, 'alice', 'Alice', 58.23, undefined, ['MQTT']);

      const payload = JSON.parse(
        (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string,
      );
      expect(payload).not.toHaveProperty('impedance');
    });
  });

  describe('publishDisplayResult', () => {
    it('publishes result to display/result topic', async () => {
      await publishDisplayResult(MQTT_PROXY_CONFIG, 'alice', 'Alice', 58.23, [
        { name: 'Garmin Connect', ok: true },
        { name: 'MQTT', ok: true },
      ]);

      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/display/result`,
        JSON.stringify({
          slug: 'alice',
          name: 'Alice',
          weight: 58.23,
          exports: [
            { name: 'Garmin Connect', ok: true },
            { name: 'MQTT', ok: true },
          ],
        }),
      );
      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('includes failed exports with ok: false', async () => {
      await publishDisplayResult(MQTT_PROXY_CONFIG, 'bob', 'Bob', 80.5, [
        { name: 'Garmin Connect', ok: false },
        { name: 'MQTT', ok: true },
      ]);

      const payload = JSON.parse(
        (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string,
      );
      expect(payload.exports[0].ok).toBe(false);
      expect(payload.exports[1].ok).toBe(true);
    });
  });

  describe('AsyncQueue', () => {
    it('returns buffered items in FIFO order', async () => {
      const q = new AsyncQueue<number>();
      q.push(1);
      q.push(2);
      q.push(3);
      expect(await q.shift()).toBe(1);
      expect(await q.shift()).toBe(2);
      expect(await q.shift()).toBe(3);
    });

    it('blocks shift() until push()', async () => {
      const q = new AsyncQueue<string>();
      const promise = q.shift();
      // Should not resolve yet
      let resolved = false;
      promise.then(() => {
        resolved = true;
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      q.push('hello');
      expect(await promise).toBe('hello');
    });

    it('supports abort signal on shift()', async () => {
      const q = new AsyncQueue<number>();
      const ac = new AbortController();
      const promise = q.shift(ac.signal);
      ac.abort();
      await expect(promise).rejects.toThrow();
    });

    it('rejects immediately if signal already aborted', async () => {
      const q = new AsyncQueue<number>();
      const ac = new AbortController();
      ac.abort();
      await expect(q.shift(ac.signal)).rejects.toThrow();
    });

    it('tracks pending count', () => {
      const q = new AsyncQueue<number>();
      expect(q.pending).toBe(0);
      q.push(1);
      q.push(2);
      expect(q.pending).toBe(2);
    });
  });

  describe('ReadingWatcher', () => {
    it('start subscribes with QoS 1 and pushes matched readings to queue', async () => {
      const adapter = createBroadcastAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter]);

      await watcher.start();

      // Verify subscribeAsync was called with QoS 1 for scan results
      expect(mockClient.subscribeAsync).toHaveBeenCalledWith(`${PREFIX}/scan/results`, { qos: 1 });
      expect(mockClient.subscribeAsync).toHaveBeenCalledWith(`${PREFIX}/status`);

      // Simulate a scan result message
      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          {
            address: 'AA:BB:CC:DD:EE:FF',
            name: '',
            rssi: -50,
            services: [],
            manufacturer_id: 0xffff,
            manufacturer_data: mfrHex(7550),
          },
        ]),
      );

      const raw = await watcher.nextReading();
      expect(raw.reading.weight).toBe(75.5);
      expect(raw.adapter.name).toBe('BroadcastScale');
    });

    it('deduplicates readings within 30s window', async () => {
      const adapter = createBroadcastAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter]);
      await watcher.start();

      const scanMsg = JSON.stringify([
        {
          address: 'AA:BB:CC:DD:EE:FF',
          name: '',
          rssi: -50,
          services: [],
          manufacturer_id: 0xffff,
          manufacturer_data: mfrHex(7550),
        },
      ]);

      // First message should be queued
      mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);
      const raw = await watcher.nextReading();
      expect(raw.reading.weight).toBe(75.5);

      // Second identical message should be deduped (not queued)
      mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);

      // Send a different weight — should NOT be deduped
      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          {
            address: 'AA:BB:CC:DD:EE:FF',
            name: '',
            rssi: -50,
            services: [],
            manufacturer_id: 0xffff,
            manufacturer_data: mfrHex(8000), // 80.0 kg — different weight
          },
        ]),
      );

      const raw2 = await watcher.nextReading();
      expect(raw2.reading.weight).toBe(80.0);
    });

    it('logs parse errors instead of swallowing', async () => {
      const adapter = createBroadcastAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter]);
      await watcher.start();

      // Send invalid JSON
      mockClient._simulateMessage(`${PREFIX}/scan/results`, 'not-json');

      // Should not throw or crash — just log
      // Verify by sending a valid message after and confirming it's received
      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          {
            address: 'AA:BB:CC:DD:EE:FF',
            name: '',
            rssi: -50,
            services: [],
            manufacturer_id: 0xffff,
            manufacturer_data: mfrHex(7550),
          },
        ]),
      );

      const raw = await watcher.nextReading();
      expect(raw.reading.weight).toBe(75.5);
    });

    it('abort signal on nextReading()', async () => {
      const adapter = createBroadcastAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter]);
      await watcher.start();

      const ac = new AbortController();
      const promise = watcher.nextReading(ac.signal);
      ac.abort();
      await expect(promise).rejects.toThrow();
    });

    it('updateConfig changes adapter matching', async () => {
      const adapter1 = createBroadcastAdapter('Scale1');
      const adapter2 = createBroadcastAdapter('Scale2');

      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter1]);
      await watcher.start();

      // Update to use adapter2
      watcher.updateConfig([adapter2]);

      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          {
            address: 'AA:BB:CC:DD:EE:FF',
            name: '',
            rssi: -50,
            services: [],
            manufacturer_id: 0xffff,
            manufacturer_data: mfrHex(7550),
          },
        ]),
      );

      const raw = await watcher.nextReading();
      expect(raw.adapter.name).toBe('Scale2');
    });

    it('guards against double-start', async () => {
      const adapter = createBroadcastAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter]);

      await watcher.start();
      const callCount = mockClient.subscribeAsync.mock.calls.length;

      await watcher.start(); // should be a no-op
      expect(mockClient.subscribeAsync.mock.calls.length).toBe(callCount);
    });

    it('grace timer, complete-immediately: emits without arming the timer', async () => {
      const adapter = createPassiveAdapter('complete');
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter]);
      await watcher.start();

      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          {
            address: 'AA:BB:CC:DD:EE:FF',
            name: '',
            rssi: -50,
            services: [],
            service_data: [{ uuid: '0x181b', data: '0102030405' }],
          },
        ]),
      );

      const raw = await watcher.nextReading();
      expect(raw.adapter.name).toBe('PassiveScale');
      expect(raw.reading.impedance).toBe(500);
      expect(adapter.parseServiceData).toHaveBeenCalledTimes(1);
    });

    it('grace timer, partial-then-complete: complete frame cancels the timer', async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const adapter = createPassiveAdapter('partial-then-complete');
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter]);
      await watcher.start();

      const ad = JSON.stringify([
        {
          address: 'AA:BB:CC:DD:EE:FF',
          name: '',
          rssi: -50,
          services: [],
          service_data: [{ uuid: '0x181b', data: '0102030405' }],
        },
      ]);

      // Partial frame arms the timer
      mockClient._simulateMessage(`${PREFIX}/scan/results`, ad);
      const clearsAfterPartial = clearTimeoutSpy.mock.calls.length;
      // Complete frame within grace cancels and resolves
      mockClient._simulateMessage(`${PREFIX}/scan/results`, ad);

      const raw = await watcher.nextReading();
      expect(raw.reading.impedance).toBe(500);
      expect(adapter.parseServiceData).toHaveBeenCalledTimes(2);
      // Headline check: clearTimeout fired between the partial and the resolve.
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearsAfterPartial);
      clearTimeoutSpy.mockRestore();
    });

    it('grace timer, partial-then-timeout: weight-only fallback after IMPEDANCE_GRACE_MS', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      try {
        const adapter = createPassiveAdapter('always-partial');
        const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter]);
        await watcher.start();

        mockClient._simulateMessage(
          `${PREFIX}/scan/results`,
          JSON.stringify([
            {
              address: 'AA:BB:CC:DD:EE:FF',
              name: '',
              rssi: -50,
              services: [],
              service_data: [{ uuid: '0x181b', data: '0102030405' }],
            },
          ]),
        );

        const { IMPEDANCE_GRACE_MS } = await import('../../src/ble/types.js');
        await vi.advanceTimersByTimeAsync(IMPEDANCE_GRACE_MS + 100);

        const raw = await watcher.nextReading();
        expect(raw.reading.weight).toBe(70.0);
        expect(raw.reading.impedance).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('filters by targetMac', async () => {
      const adapter = createBroadcastAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], 'AA:BB:CC:DD:EE:FF');
      await watcher.start();

      // Send a result with wrong MAC — should not match
      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          {
            address: '11:22:33:44:55:66',
            name: '',
            rssi: -50,
            services: [],
            manufacturer_id: 0xffff,
            manufacturer_data: mfrHex(6000),
          },
        ]),
      );

      // Send a result with correct MAC — should match
      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          {
            address: 'AA:BB:CC:DD:EE:FF',
            name: '',
            rssi: -50,
            services: [],
            manufacturer_id: 0xffff,
            manufacturer_data: mfrHex(7550),
          },
        ]),
      );

      const raw = await watcher.nextReading();
      expect(raw.reading.weight).toBe(75.5);
    });
  });

  describe('GATT proxy', () => {
    /** Wire GATT flow: online → scan (GATT device) → connected → notification.
     *  Connected response is triggered by publishAsync(connect), not subscribeAsync,
     *  because mqttGattConnect sets up the handler AFTER subscribing but BEFORE publishing. */
    function wireGattFlow(opts?: { skipNotify?: boolean; addrType?: number }) {
      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                {
                  address: 'AA:BB:CC:DD:EE:FF',
                  name: 'GattScale',
                  rssi: -50,
                  services: [],
                  addr_type: opts?.addrType ?? 1,
                },
              ]),
            ),
          );
        }
        return [];
      });

      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/connected`,
              JSON.stringify({
                chars: [
                  { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
                  { uuid: GATT_WRITE_UUID, properties: ['write'] },
                ],
              }),
            ),
          );
        }
        if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}` && !opts?.skipNotify) {
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(7550, 0);
            buf.writeUInt16LE(500, 2);
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
          });
        }
        return origPublish(topic, payload);
      });
    }

    it('sends addr_type from scan result in connect payload', async () => {
      const adapter = createGattAdapter();
      wireGattFlow();

      await scanAndReadRaw({
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      const connectCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/connect`,
      );
      expect(JSON.parse(connectCalls[0][1] as string).addr_type).toBe(1);
    });

    it('always disconnects after GATT reading (even on error)', async () => {
      const adapter = createGattAdapter();

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                { address: 'AA:BB:CC:DD:EE:FF', name: 'GattScale', rssi: -50, services: [] },
              ]),
            ),
          );
        }
        return [];
      });

      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/connected`,
              JSON.stringify({ chars: [{ uuid: GATT_NOTIFY_UUID, properties: ['notify'] }] }),
            ),
          );
          // After connect, simulate unexpected BLE disconnected event → error path
          setTimeout(() => mockClient._simulateMessage(`${PREFIX}/disconnected`, ''), 50);
        }
        return origPublish(topic, payload);
      });

      await expect(
        scanAndReadRaw({
          adapters: [adapter],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow();

      // Should still have sent disconnect
      const disconnectCalls = (
        mockClient.publishAsync as ReturnType<typeof vi.fn>
      ).mock.calls.filter((c: unknown[]) => c[0] === `${PREFIX}/disconnect`);
      expect(disconnectCalls).toHaveLength(1);
    });

    it('ReadingWatcher handles GATT scale via handleGattReading', async () => {
      const adapter = createGattAdapter();
      const config = { ...MQTT_PROXY_CONFIG, auto_connect: false };
      const watcher = new ReadingWatcher(config, [adapter], undefined, PROFILE);
      await watcher.start();

      // The watcher's message handler calls handleGattReading which uses
      // publishAsync to send the connect command. Wire up publish-based responses.
      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/connected`,
              JSON.stringify({
                chars: [
                  { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
                  { uuid: GATT_WRITE_UUID, properties: ['write'] },
                ],
              }),
            ),
          );
        }
        if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(8000, 0); // 80.00 kg
            buf.writeUInt16LE(450, 2); // impedance 450
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
          });
        }
        return origPublish(topic, payload);
      });

      // Simulate scan result with no broadcast data → triggers GATT fallback
      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          {
            address: 'AA:BB:CC:DD:EE:FF',
            name: 'GattScale',
            rssi: -50,
            services: [],
            addr_type: 0,
          },
        ]),
      );

      const raw = await watcher.nextReading();
      expect(raw.reading.weight).toBe(80.0);
      expect(raw.reading.impedance).toBe(450);
      expect(raw.adapter.name).toBe('GattScale');
    });

    it('rejects with ESP32 error instead of timeout when connect fails', async () => {
      const adapter = createGattAdapter();

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                {
                  address: 'AA:BB:CC:DD:EE:FF',
                  name: 'GattScale',
                  rssi: -50,
                  services: [],
                  addr_type: 0,
                },
              ]),
            ),
          );
        }
        return [];
      });

      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          // Simulate ESP32 failing to connect — publishes error instead of connected
          queueMicrotask(() =>
            mockClient._simulateMessage(`${PREFIX}/error`, 'Connection failed: device not found'),
          );
        }
        return origPublish(topic, payload);
      });

      await expect(
        scanAndReadRaw({
          adapters: [adapter],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow('ESP32 error: Connection failed: device not found');
    });

    it('broadcast scales still work unchanged (no regression)', async () => {
      const broadcastAdapter = createBroadcastAdapter();
      const gattAdapter = createGattAdapter();

      wireBroadcastFlow([
        {
          address: 'AA:BB:CC:DD:EE:FF',
          name: '',
          rssi: -50,
          services: [],
          manufacturer_id: 0xffff,
          manufacturer_data: mfrHex(7550),
        },
      ]);

      const result = await scanAndReadRaw({
        adapters: [broadcastAdapter, gattAdapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      // Should use broadcast path, not GATT
      expect(result.reading.weight).toBe(75.5);
      expect(result.adapter.name).toBe('BroadcastScale');

      // No connect command should have been published
      const connectCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/connect`,
      );
      expect(connectCalls).toHaveLength(0);
    });

    it('ReadingWatcher GATT-connects a dual-mode scale with no broadcast data (#201)', async () => {
      // Continuous-mode regression: the QN-Scale appears in a scan batch with a
      // name but no manufacturer data. The watcher must open a GATT connection
      // instead of silently skipping it because the adapter declares parseBroadcast.
      const adapter = createDualModeAdapter();
      const config = { ...MQTT_PROXY_CONFIG, auto_connect: false };
      const watcher = new ReadingWatcher(config, [adapter], undefined, PROFILE);
      await watcher.start();

      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/connected`,
              JSON.stringify({
                chars: [
                  { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
                  { uuid: GATT_WRITE_UUID, properties: ['write'] },
                ],
              }),
            ),
          );
        }
        if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(8000, 0); // 80.00 kg
            buf.writeUInt16LE(450, 2); // impedance 450
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
          });
        }
        return origPublish(topic, payload);
      });

      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          {
            address: 'AA:BB:CC:DD:EE:FF',
            name: 'DualScale',
            rssi: -80,
            services: ['ffe0'],
            addr_type: 0,
          },
        ]),
      );

      const raw = await watcher.nextReading();
      expect(raw.reading.weight).toBe(80.0);
      expect(raw.reading.impedance).toBe(450);

      const connectCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/connect`,
      );
      expect(connectCalls).toHaveLength(1);
    });

    it('ReadingWatcher retries GATT after a failed connect (#201)', async () => {
      // Regression: a failed mqttGattConnect must clear gattInProgress so the
      // next scan batch can retry. Before the fix, the flag leaked `true` and
      // every later GATT attempt was skipped until the 90s stale-reset.
      const adapter = createDualModeAdapter();
      const config = { ...MQTT_PROXY_CONFIG, auto_connect: false };
      const watcher = new ReadingWatcher(config, [adapter], undefined, PROFILE);
      await watcher.start();

      let connectCount = 0;
      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          connectCount++;
          if (connectCount === 1) {
            // First attempt: ESP32 reports a connect failure.
            queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/error`, 'connect failed'));
          } else {
            // Second attempt: succeeds.
            queueMicrotask(() =>
              mockClient._simulateMessage(
                `${PREFIX}/connected`,
                JSON.stringify({
                  chars: [
                    { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
                    { uuid: GATT_WRITE_UUID, properties: ['write'] },
                  ],
                }),
              ),
            );
          }
        }
        if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(8000, 0); // 80.00 kg
            buf.writeUInt16LE(450, 2); // impedance 450
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
          });
        }
        return origPublish(topic, payload);
      });

      const scanMsg = JSON.stringify([
        {
          address: 'AA:BB:CC:DD:EE:FF',
          name: 'DualScale',
          rssi: -80,
          services: ['ffe0'],
          addr_type: 0,
        },
      ]);

      // First batch → GATT connect #1 fails.
      mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);
      // Let the failure settle so gattInProgress is reset.
      await new Promise((r) => setTimeout(r, 50));
      // Second batch → GATT connect #2 must be attempted (not skipped).
      mockClient._simulateMessage(`${PREFIX}/scan/results`, scanMsg);

      const raw = await watcher.nextReading();
      expect(raw.reading.weight).toBe(80.0);
      expect(connectCount).toBe(2);
    });

    it('surfaces a placeholder when the ESP32 error payload is empty (#201)', async () => {
      const adapter = createGattAdapter();

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                { address: 'AA:BB:CC:DD:EE:FF', name: 'GattScale', rssi: -50, services: [] },
              ]),
            ),
          );
        }
        return [];
      });

      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          // ESP32 reports an error with an empty payload (old firmware / a
          // MicroPython exception whose str() is empty).
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/error`, ''));
        }
        return origPublish(topic, payload);
      });

      await expect(
        scanAndReadRaw({
          adapters: [adapter],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow('ESP32 error: (no detail)');
    });

    it('ReadingWatcher handles autonomous GATT connect from ESP32 (#201)', async () => {
      const adapter = createGattAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], undefined, PROFILE);
      await watcher.start();

      // Simulate the write response: when the host writes the unlock command,
      // the scale sends a notification with weight+impedance.
      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(9000, 0); // 90.00 kg
            buf.writeUInt16LE(520, 2); // impedance 520
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
          });
        }
        return origPublish(topic, payload);
      });

      // ESP32 autonomously connected and publishes the connected payload
      mockClient._simulateMessage(
        `${PREFIX}/connected`,
        JSON.stringify({
          autonomous: true,
          address: 'AA:BB:CC:DD:EE:FF',
          chars: [
            { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
            { uuid: GATT_WRITE_UUID, properties: ['write'] },
          ],
        }),
      );

      const raw = await watcher.nextReading();
      expect(raw.reading.weight).toBe(90.0);
      expect(raw.reading.impedance).toBe(520);
      expect(raw.adapter.name).toBe('GattScale');

      // No connect command should have been published (ESP32 did it autonomously)
      const connectCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/connect`,
      );
      expect(connectCalls).toHaveLength(0);
    });

    it('ReadingWatcher ignores autonomous connect when no adapter matches', async () => {
      // Adapter only matches by name 'GattScale', but the autonomous connect
      // comes from a different device with no name info.
      const adapter = createGattAdapter();
      // Override matches to never match
      (adapter.matches as ReturnType<typeof vi.fn>).mockReturnValue(false);
      // Override charNotifyUuid to a UUID that won't match
      (adapter as { charNotifyUuid: string }).charNotifyUuid =
        '00001234-0000-1000-8000-00805f9b34fb';
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], undefined, PROFILE);
      await watcher.start();

      // Clear any previous calls
      (mockClient.publishAsync as ReturnType<typeof vi.fn>).mockClear();

      // Simulate autonomous connect with unknown chars
      mockClient._simulateMessage(
        `${PREFIX}/connected`,
        JSON.stringify({
          autonomous: true,
          address: 'FF:FF:FF:FF:FF:FF',
          chars: [{ uuid: '0000abcd-0000-1000-8000-00805f9b34fb', properties: ['notify'] }],
        }),
      );

      // Give time for the handler to process
      await new Promise((r) => setTimeout(r, 50));

      // Should have published a disconnect command since no adapter matched
      const disconnectCalls = (
        mockClient.publishAsync as ReturnType<typeof vi.fn>
      ).mock.calls.filter((c: unknown[]) => c[0] === `${PREFIX}/disconnect`);
      // handleAutonomousConnect: 1 disconnect (no adapter matched) + 1 from finally block
      expect(disconnectCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('ReadingWatcher skips autonomous connect when gattInProgress', async () => {
      const adapter = createGattAdapter();
      const config = { ...MQTT_PROXY_CONFIG, auto_connect: false };
      const watcher = new ReadingWatcher(config, [adapter], undefined, PROFILE);
      await watcher.start();

      // First: trigger a regular GATT connect that will hang (no response)
      const origPublish = mockClient.publishAsync;
      let connectReceived = false;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          connectReceived = true;
          // Don't respond — leaves gattInProgress = true
        }
        return origPublish(topic, payload);
      });

      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          { address: 'AA:BB:CC:DD:EE:FF', name: 'GattScale', rssi: -50, services: [] },
        ]),
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(connectReceived).toBe(true);

      // Clear mock call history before the autonomous connect attempt
      (mockClient.publishAsync as ReturnType<typeof vi.fn>).mockClear();

      // Now simulate autonomous connect while GATT is in progress — should be skipped
      mockClient._simulateMessage(
        `${PREFIX}/connected`,
        JSON.stringify({
          autonomous: true,
          address: 'BB:CC:DD:EE:FF:00',
          chars: [{ uuid: GATT_NOTIFY_UUID, properties: ['notify'] }],
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      // No disconnect should have been published for the skipped autonomous connect
      const disconnectCalls = (
        mockClient.publishAsync as ReturnType<typeof vi.fn>
      ).mock.calls.filter((c: unknown[]) => c[0] === `${PREFIX}/disconnect`);
      expect(disconnectCalls).toHaveLength(0);
    });

    it('combined scan/results then autonomous connected succeeds without race (#201)', async () => {
      const adapter = createGattAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], undefined, PROFILE);
      await watcher.start();

      // Simulate the write response for the autonomous GATT session
      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(8050, 0); // 80.50 kg
            buf.writeUInt16LE(480, 2); // impedance 480
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID}`, buf);
          });
        }
        return origPublish(topic, payload);
      });

      // Step 1: ESP32 publishes scan/results with a GATT-only scale
      // (this is the exact sequence that caused the race: scan/results first,
      // then connected with autonomous: true)
      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          { address: 'AA:BB:CC:DD:EE:FF', name: 'GattScale', rssi: -50, services: [] },
        ]),
      );

      // Step 2: immediately after, ESP32 publishes autonomous connected
      mockClient._simulateMessage(
        `${PREFIX}/connected`,
        JSON.stringify({
          autonomous: true,
          address: 'AA:BB:CC:DD:EE:FF',
          chars: [
            { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
            { uuid: GATT_WRITE_UUID, properties: ['write'] },
          ],
        }),
      );

      const raw = await watcher.nextReading();
      expect(raw.reading.weight).toBe(80.5);
      expect(raw.reading.impedance).toBe(480);
      expect(raw.adapter.name).toBe('GattScale');

      // No host-initiated connect command should have been published
      const connectCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/connect`,
      );
      expect(connectCalls).toHaveLength(0);
    });

    it('scan/results falls back to host-initiated GATT when auto_connect is false', async () => {
      const adapter = createGattAdapter();
      const config = { ...MQTT_PROXY_CONFIG, auto_connect: false };
      const watcher = new ReadingWatcher(config, [adapter], undefined, PROFILE);
      await watcher.start();

      // Intercept the connect command to verify it's published
      const origPublish = mockClient.publishAsync;
      let connectReceived = false;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        if (topic === `${PREFIX}/connect`) {
          connectReceived = true;
        }
        return origPublish(topic, payload);
      });

      // Simulate scan/results with a GATT-only scale
      mockClient._simulateMessage(
        `${PREFIX}/scan/results`,
        JSON.stringify([
          { address: 'AA:BB:CC:DD:EE:FF', name: 'GattScale', rssi: -50, services: [] },
        ]),
      );

      await new Promise((r) => setTimeout(r, 50));
      // With auto_connect disabled, the host should have initiated a connect
      expect(connectReceived).toBe(true);
    });

    it('autonomous connect matches adapter when ESP32 reports UUID in different case', async () => {
      const adapter = createGattAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], undefined, PROFILE);
      await watcher.start();

      // Override matches to NOT match by device info (autonomous has no name)
      (adapter.matches as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const origPublish = mockClient.publishAsync;
      mockClient.publishAsync = vi.fn(async (topic: string, payload?: string | Buffer) => {
        // The ESP32 reports UUIDs in uppercase, so the MQTT write topic uses
        // the original case. Match case-insensitively.
        if (topic.toLowerCase() === `${PREFIX}/write/${GATT_WRITE_UUID}`) {
          queueMicrotask(() => {
            const buf = Buffer.alloc(4);
            buf.writeUInt16LE(7500, 0);
            buf.writeUInt16LE(500, 2);
            // Notify topic also uses original case from ESP32
            mockClient._simulateMessage(`${PREFIX}/notify/${GATT_NOTIFY_UUID.toUpperCase()}`, buf);
          });
        }
        return origPublish(topic, payload);
      });

      // ESP32 reports UUID in uppercase — should still match via normalizeUuid
      mockClient._simulateMessage(
        `${PREFIX}/connected`,
        JSON.stringify({
          autonomous: true,
          address: 'AA:BB:CC:DD:EE:FF',
          chars: [
            { uuid: GATT_NOTIFY_UUID.toUpperCase(), properties: ['notify'] },
            { uuid: GATT_WRITE_UUID.toUpperCase(), properties: ['write'] },
          ],
        }),
      );

      const raw = await watcher.nextReading();
      expect(raw.reading.weight).toBe(75.0);
    });

    it('host-initiated connect ignores autonomous connected payload', async () => {
      // Non-autonomous connected messages (no `autonomous: true`) should not
      // trigger handleAutonomousConnect.
      const adapter = createGattAdapter();
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], undefined, PROFILE);
      await watcher.start();

      mockClient._simulateMessage(
        `${PREFIX}/connected`,
        JSON.stringify({
          address: 'AA:BB:CC:DD:EE:FF',
          chars: [
            { uuid: GATT_NOTIFY_UUID, properties: ['notify'] },
            { uuid: GATT_WRITE_UUID, properties: ['write'] },
          ],
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      // No disconnect should be published — the watcher should ignore this message
      const disconnectCalls = (
        mockClient.publishAsync as ReturnType<typeof vi.fn>
      ).mock.calls.filter((c: unknown[]) => c[0] === `${PREFIX}/disconnect`);
      expect(disconnectCalls).toHaveLength(0);
    });
  });
});
