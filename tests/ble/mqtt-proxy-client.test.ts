import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MqttProxyConfig } from '../../src/config/schema.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// Track connectAsync invocations so we can assert single-flight behaviour even
// across overlapping callers.
let connectCalls = 0;
let resolveConnect: ((client: unknown) => void) | null = null;

function makeMockClient(): { connected: boolean; endAsync: () => Promise<void> } {
  return { connected: true, endAsync: async () => undefined };
}

vi.mock('mqtt', () => ({
  connectAsync: vi.fn(() => {
    connectCalls += 1;
    return new Promise((resolve) => {
      resolveConnect = (c) => resolve(c);
    });
  }),
}));

const { getOrCreatePersistentClient, _resetProxyState } =
  await import('../../src/ble/handler-mqtt-proxy/client.js');

const CONFIG: MqttProxyConfig = {
  broker_url: 'mqtt://localhost:1883',
  device_id: 'esp32-test',
  topic_prefix: 'ble-proxy',
  username: null,
  password: null,
} as MqttProxyConfig;

beforeEach(() => {
  connectCalls = 0;
  resolveConnect = null;
  _resetProxyState();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function flushMicrotasks(): Promise<void> {
  // The IIFE inside getOrCreatePersistentClient awaits import('mqtt') before
  // calling connectAsync, so callers must yield to microtasks before observing
  // connectCalls. A small setTimeout(0) flush covers both ticks.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('getOrCreatePersistentClient', () => {
  it('coalesces concurrent first calls onto a single connectAsync', async () => {
    const a = getOrCreatePersistentClient(CONFIG);
    const b = getOrCreatePersistentClient(CONFIG);
    const c = getOrCreatePersistentClient(CONFIG);

    await flushMicrotasks();

    // All three callers should be waiting on the same in-flight connect.
    expect(connectCalls).toBe(1);
    expect(resolveConnect).not.toBeNull();

    const mockClient = makeMockClient();
    resolveConnect!(mockClient);

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBe(mockClient);
    expect(rb).toBe(mockClient);
    expect(rc).toBe(mockClient);
    expect(connectCalls).toBe(1);
  });

  it('returns the cached client on the second call when still connected', async () => {
    const first = getOrCreatePersistentClient(CONFIG);
    await flushMicrotasks();
    const mockClient = makeMockClient();
    resolveConnect!(mockClient);
    const a = await first;

    const b = await getOrCreatePersistentClient(CONFIG);
    expect(b).toBe(a);
    expect(connectCalls).toBe(1);
  });

  it('clears the pending promise on connect failure so the next call retries', async () => {
    let attempt = 0;
    const mqttMock = vi.mocked(await import('mqtt')).connectAsync;
    mqttMock.mockImplementation(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve(makeMockClient() as never);
    });

    try {
      await expect(getOrCreatePersistentClient(CONFIG)).rejects.toThrow('boom');
      const second = await getOrCreatePersistentClient(CONFIG);
      expect(second.connected).toBe(true);
      expect(attempt).toBe(2);
    } finally {
      // Restore the file-scope default impl so this override does not bleed
      // into tests appended below.
      mqttMock.mockReset();
      mqttMock.mockImplementation(() => {
        connectCalls += 1;
        return new Promise((resolve) => {
          // The fake client is a partial stand-in for MqttClient.
          resolveConnect = (c) => resolve(c as never);
        });
      });
    }
  });
});

describe('known-scale sets', () => {
  it('keeps at most 64 discovered MACs and drops the oldest', async () => {
    const { addDiscoveredMac, getDiscoveredMacs, hasDiscoveredMac } =
      await import('../../src/ble/handler-mqtt-proxy/client.js');
    const mac = (i: number) => `AA:BB:CC:DD:00:${i.toString(16).padStart(2, '0')}`;
    for (let i = 0; i < 100; i++) addDiscoveredMac(mac(i));
    expect(getDiscoveredMacs()).toHaveLength(64);
    expect(hasDiscoveredMac(mac(0))).toBe(false);
    expect(hasDiscoveredMac(mac(99))).toBe(true);
    // A scale that fell out comes back with its next reading.
    addDiscoveredMac(mac(0));
    expect(hasDiscoveredMac(mac(0))).toBe(true);
    expect(getDiscoveredMacs()).toHaveLength(64);
  });

  it('keeps at most 64 passive MACs and drops the oldest', async () => {
    const { addPassiveMac, getPassiveMacs, isPassiveMac } =
      await import('../../src/ble/handler-mqtt-proxy/client.js');
    const mac = (i: number) => `AA:BB:CC:DD:01:${i.toString(16).padStart(2, '0')}`;
    for (let i = 0; i < 100; i++) addPassiveMac(mac(i));
    expect(getPassiveMacs()).toHaveLength(64);
    expect(isPassiveMac(mac(0))).toBe(false);
    expect(isPassiveMac(mac(99))).toBe(true);
  });
});
