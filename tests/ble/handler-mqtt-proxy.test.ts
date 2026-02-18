import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeUuid } from '../../src/ble/types.js';
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
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  subscribeAsync: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  publishAsync: ReturnType<typeof vi.fn>;
  endAsync: ReturnType<typeof vi.fn>;
  _listeners: Map<string, Array<(topic: string, payload: Buffer) => void>>;
  _simulateMessage: (topic: string, payload: string | Buffer) => void;
}

function createMockMqttClient(): MockMqttClient {
  const listeners = new Map<string, Array<(topic: string, payload: Buffer) => void>>();

  const client: MockMqttClient = {
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

function createMockAdapter(name = 'TestScale'): ScaleAdapter {
  let callCount = 0;
  return {
    name,
    charNotifyUuid: 'FFF1',
    charWriteUuid: 'FFF2',
    unlockCommand: [0x01, 0x02],
    unlockIntervalMs: 2000,
    matches: vi.fn((info: BleDeviceInfo) => info.localName === name),
    parseNotification: vi.fn((_data: Buffer): ScaleReading | null => {
      callCount++;
      if (callCount >= 2) {
        return { weight: 75.5, impedance: 500 };
      }
      return { weight: 75.5, impedance: 0 };
    }),
    isComplete: vi.fn((reading: ScaleReading) => reading.impedance > 0),
    computeMetrics: vi.fn(() => BODY_COMP),
  };
}

// ─── Import the module under test ────────────────────────────────────────────

// Must import AFTER vi.mock
const { scanAndReadRaw, scanAndRead, scanDevices, publishConfig, publishBeep, registerScaleMac } =
  await import('../../src/ble/handler-mqtt-proxy.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wire up the mock client so that subscribeAsync/publishAsync simulate
 * the ESP32 response sequence for a full scan-connect-notify flow.
 */
function wireFullFlow(
  scanResults: Array<{ address: string; name: string; rssi: number; services: string[] }>,
  chars: Array<{ uuid: string; properties: string[] }>,
) {
  mockClient.subscribeAsync = vi.fn(async (topic: string) => {
    if (topic === `${PREFIX}/status`) {
      queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
    }
    if (topic === `${PREFIX}/scan/results`) {
      // ESP32 scans autonomously — simulate results arriving after subscribe
      queueMicrotask(() =>
        mockClient._simulateMessage(`${PREFIX}/scan/results`, JSON.stringify(scanResults)),
      );
    }
    if (topic.includes('/notify/')) {
      // Simulate two notifications: first partial, then complete
      setTimeout(() => mockClient._simulateMessage(topic, Buffer.from([0x01, 0x02])), 10);
      setTimeout(() => mockClient._simulateMessage(topic, Buffer.from([0x03, 0x04])), 20);
    }
    return [];
  });

  mockClient.publishAsync = vi.fn(async (topic: string, _payload?: unknown) => {
    if (topic === `${PREFIX}/connect`) {
      queueMicrotask(() =>
        mockClient._simulateMessage(`${PREFIX}/connected`, JSON.stringify({ chars })),
      );
    }
    return undefined;
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockClient = createMockMqttClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handler-mqtt-proxy', () => {
  describe('scanAndReadRaw', () => {
    it('happy path: online → scan → match → connect → notify → complete reading → disconnect', async () => {
      const adapter = createMockAdapter();

      wireFullFlow(
        [{ address: 'AA:BB:CC:DD:EE:FF', name: 'TestScale', rssi: -50, services: ['FFF0'] }],
        [
          { uuid: 'FFF1', properties: ['notify'] },
          { uuid: 'FFF2', properties: ['write'] },
        ],
      );

      const result = await scanAndReadRaw({
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      expect(result.reading.weight).toBe(75.5);
      expect(result.reading.impedance).toBe(500);
      expect(result.adapter.name).toBe('TestScale');
      expect(adapter.matches).toHaveBeenCalled();
      expect(adapter.parseNotification).toHaveBeenCalled();
      expect(adapter.isComplete).toHaveBeenCalled();

      // Should have sent disconnect
      expect(mockClient.publishAsync).toHaveBeenCalledWith(`${PREFIX}/disconnect`, '');

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
          adapters: [createMockAdapter()],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow('ESP32 proxy is offline');

      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('rejects when mqttProxy config is missing', async () => {
      await expect(
        scanAndReadRaw({
          adapters: [createMockAdapter()],
          profile: PROFILE,
        }),
      ).rejects.toThrow('mqtt_proxy config is required');
    });

    it('mid-read disconnect fires onDisconnect', async () => {
      const adapter = createMockAdapter();
      // Make adapter never complete so we can test disconnect
      (adapter.isComplete as ReturnType<typeof vi.fn>).mockReturnValue(false);

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                { address: 'AA:BB:CC:DD:EE:FF', name: 'TestScale', rssi: -50, services: ['FFF0'] },
              ]),
            ),
          );
        }
        if (topic.includes('/notify/')) {
          // Send one notification then disconnect
          setTimeout(() => mockClient._simulateMessage(topic, Buffer.from([0x01])), 10);
          setTimeout(() => mockClient._simulateMessage(`${PREFIX}/disconnected`, ''), 30);
        }
        return [];
      });

      mockClient.publishAsync = vi.fn(async (topic: string, _payload?: unknown) => {
        if (topic === `${PREFIX}/connect`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/connected`,
              JSON.stringify({
                chars: [
                  { uuid: 'FFF1', properties: ['notify'] },
                  { uuid: 'FFF2', properties: ['write'] },
                ],
              }),
            ),
          );
        }
        return undefined;
      });

      await expect(
        scanAndReadRaw({
          adapters: [adapter],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow('disconnected before reading completed');
    });

    it('ESP32 LWT offline during read fires onDisconnect', async () => {
      const adapter = createMockAdapter();
      (adapter.isComplete as ReturnType<typeof vi.fn>).mockReturnValue(false);

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                { address: 'AA:BB:CC:DD:EE:FF', name: 'TestScale', rssi: -50, services: ['FFF0'] },
              ]),
            ),
          );
        }
        if (topic.includes('/notify/')) {
          setTimeout(() => mockClient._simulateMessage(topic, Buffer.from([0x01])), 10);
          setTimeout(() => {
            // ESP32 goes offline (LWT fires)
            mockClient._simulateMessage(`${PREFIX}/status`, 'offline');
          }, 30);
        }
        return [];
      });

      mockClient.publishAsync = vi.fn(async (topic: string, _payload?: unknown) => {
        if (topic === `${PREFIX}/connect`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/connected`,
              JSON.stringify({
                chars: [
                  { uuid: 'FFF1', properties: ['notify'] },
                  { uuid: 'FFF2', properties: ['write'] },
                ],
              }),
            ),
          );
        }
        return undefined;
      });

      await expect(
        scanAndReadRaw({
          adapters: [adapter],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow('disconnected before reading completed');
    });

    it('connects to targetMac directly when provided', async () => {
      const adapter = createMockAdapter();
      // For targetMac flow, match by char UUIDs instead of name
      (adapter.matches as ReturnType<typeof vi.fn>).mockImplementation((info: BleDeviceInfo) => {
        return info.serviceUuids.some((u) => u === normalizeUuid('FFF1'));
      });

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic.includes('/notify/')) {
          setTimeout(() => mockClient._simulateMessage(topic, Buffer.from([0x01])), 10);
          setTimeout(() => mockClient._simulateMessage(topic, Buffer.from([0x02])), 20);
        }
        return [];
      });

      mockClient.publishAsync = vi.fn(async (topic: string, payload?: unknown) => {
        if (topic === `${PREFIX}/connect`) {
          const parsed = JSON.parse(String(payload));
          expect(parsed.address).toBe('AA:BB:CC:DD:EE:FF');
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/connected`,
              JSON.stringify({
                chars: [
                  { uuid: 'FFF1', properties: ['notify'] },
                  { uuid: 'FFF2', properties: ['write'] },
                ],
              }),
            ),
          );
        }
        return undefined;
      });

      const result = await scanAndReadRaw({
        targetMac: 'AA:BB:CC:DD:EE:FF',
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      expect(result.reading.weight).toBe(75.5);
      // Should NOT have subscribed to scan/results (we already know the MAC)
      const scanSubs = (mockClient.subscribeAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/scan/results`,
      );
      expect(scanSubs).toHaveLength(0);
    });

    it('returns broadcast reading without GATT connection', async () => {
      const broadcastAdapter: ScaleAdapter = {
        name: 'Broadcast',
        charNotifyUuid: '',
        charWriteUuid: '',
        unlockCommand: [],
        unlockIntervalMs: 0,
        matches: vi.fn((info: BleDeviceInfo) => {
          return info.manufacturerData?.id === 0xffff;
        }),
        parseBroadcast: vi.fn((data: Buffer) => {
          const weight = data.readUInt16LE(17) / 100;
          return { weight, impedance: 0 };
        }),
        parseNotification: vi.fn(() => null),
        isComplete: vi.fn(() => true),
        computeMetrics: vi.fn(() => BODY_COMP),
      };

      // Scan result with manufacturer data
      const mfrPayload = Buffer.alloc(20);
      mfrPayload[0] = 0xaa;
      mfrPayload[1] = 0xbb;
      mfrPayload.writeUInt16LE(8635, 17); // 86.35 kg

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
                  manufacturer_data: mfrPayload.toString('hex'),
                },
              ]),
            ),
          );
        }
        return [];
      });

      mockClient.publishAsync = vi.fn(async () => undefined);

      const result = await scanAndReadRaw({
        adapters: [broadcastAdapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      expect(result.reading.weight).toBe(86.35);
      expect(result.reading.impedance).toBe(0);
      expect(result.adapter.name).toBe('Broadcast');
      // Should NOT have sent connect (broadcast = no GATT)
      const connectCalls = (mockClient.publishAsync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === `${PREFIX}/connect`,
      );
      expect(connectCalls).toHaveLength(0);
    });

    it('rejects when no scale is recognized', async () => {
      const adapter = createMockAdapter('UnknownBrand');

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                { address: 'AA:BB:CC:DD:EE:FF', name: 'SomeOtherDevice', rssi: -50, services: [] },
              ]),
            ),
          );
        }
        return [];
      });

      await expect(
        scanAndReadRaw({
          adapters: [adapter],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow('No recognized scale found via ESP32 proxy');
    });
  });

  describe('BleChar.write', () => {
    it('publishes to correct write topic', async () => {
      const adapter = createMockAdapter();

      // Setup adapter to call write during onConnected
      adapter.onConnected = async (ctx) => {
        await ctx.write('FFF2', Buffer.from([0xaa, 0xbb]));
      };

      wireFullFlow(
        [{ address: 'AA:BB:CC:DD:EE:FF', name: 'TestScale', rssi: -50, services: ['FFF0'] }],
        [
          { uuid: 'FFF1', properties: ['notify'] },
          { uuid: 'FFF2', properties: ['write'] },
        ],
      );

      await scanAndReadRaw({
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      // Check that publishAsync was called with the write topic
      expect(mockClient.publishAsync).toHaveBeenCalledWith(
        `${PREFIX}/write/${normalizeUuid('FFF2')}`,
        Buffer.from([0xaa, 0xbb]),
      );
    });
  });

  describe('BleChar.read', () => {
    it('publishes command and awaits response', async () => {
      const adapter = createMockAdapter();

      adapter.onConnected = async (ctx) => {
        const data = await ctx.read('FFF2');
        expect(data.toString()).toBe('hello');
      };

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                { address: 'AA:BB:CC:DD:EE:FF', name: 'TestScale', rssi: -50, services: ['FFF0'] },
              ]),
            ),
          );
        }
        // When read response topic is subscribed, simulate the response
        if (topic.includes('/read/') && topic.includes('/response')) {
          queueMicrotask(() => mockClient._simulateMessage(topic, Buffer.from('hello')));
        }
        if (topic.includes('/notify/')) {
          setTimeout(() => mockClient._simulateMessage(topic, Buffer.from([0x01])), 50);
          setTimeout(() => mockClient._simulateMessage(topic, Buffer.from([0x02])), 60);
        }
        return [];
      });

      mockClient.publishAsync = vi.fn(async (topic: string, _payload?: unknown) => {
        if (topic === `${PREFIX}/connect`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/connected`,
              JSON.stringify({
                chars: [
                  { uuid: 'FFF1', properties: ['notify'] },
                  { uuid: 'FFF2', properties: ['write', 'read'] },
                ],
              }),
            ),
          );
        }
        return undefined;
      });

      await scanAndReadRaw({
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });
    });
  });

  describe('scanAndRead', () => {
    it('calls computeMetrics on the raw reading', async () => {
      const adapter = createMockAdapter();

      wireFullFlow(
        [{ address: 'AA:BB:CC:DD:EE:FF', name: 'TestScale', rssi: -50, services: [] }],
        [
          { uuid: 'FFF1', properties: ['notify'] },
          { uuid: 'FFF2', properties: ['write'] },
        ],
      );

      const result = await scanAndRead({
        adapters: [adapter],
        profile: PROFILE,
        mqttProxy: MQTT_PROXY_CONFIG,
      });

      expect(result).toEqual(BODY_COMP);
      expect(adapter.computeMetrics).toHaveBeenCalledWith(
        { weight: 75.5, impedance: 500 },
        PROFILE,
      );
    });
  });

  describe('scanDevices', () => {
    it('parses results and matches adapters', async () => {
      const adapter = createMockAdapter();

      mockClient.subscribeAsync = vi.fn(async (topic: string) => {
        if (topic === `${PREFIX}/status`) {
          queueMicrotask(() => mockClient._simulateMessage(`${PREFIX}/status`, 'online'));
        }
        if (topic === `${PREFIX}/scan/results`) {
          queueMicrotask(() =>
            mockClient._simulateMessage(
              `${PREFIX}/scan/results`,
              JSON.stringify([
                { address: 'AA:BB:CC:DD:EE:FF', name: 'TestScale', rssi: -50, services: ['FFF0'] },
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
      expect(results[0].name).toBe('TestScale');
      expect(results[0].matchedAdapter).toBe('TestScale');
      expect(results[1].address).toBe('11:22:33:44:55:66');
      expect(results[1].matchedAdapter).toBeUndefined();
      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('rejects when mqttProxy config is missing', async () => {
      await expect(scanDevices([createMockAdapter()])).rejects.toThrow(
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
          adapters: [createMockAdapter()],
          profile: PROFILE,
          mqttProxy: MQTT_PROXY_CONFIG,
        }),
      ).rejects.toThrow();

      expect(mockClient.endAsync).toHaveBeenCalled();
    });

    it('cleans up message listeners on timeout', async () => {
      // Don't respond to status — let it timeout
      const result = scanAndReadRaw({
        adapters: [createMockAdapter()],
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
      await registerScaleMac(MQTT_PROXY_CONFIG, 'ff:ee:dd:cc:bb:aa');

      // Should not publish again — same MAC was registered in previous test
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
});
