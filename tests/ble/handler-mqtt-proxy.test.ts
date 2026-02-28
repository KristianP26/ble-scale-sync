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
} = await import('../../src/ble/handler-mqtt-proxy.js');

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
      const watcher = new ReadingWatcher(MQTT_PROXY_CONFIG, [adapter], undefined, PROFILE);
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
  });
});
