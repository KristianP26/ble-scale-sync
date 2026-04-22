import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { bootstrapMqttProxy } from '../../src/ble/mqtt-proxy-bootstrap.js';
import type { MqttProxyConfig } from '../../src/config/schema.js';

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

function baseConfig(overrides: Partial<MqttProxyConfig> = {}): MqttProxyConfig {
  return {
    device_id: 'esp32-ble-proxy',
    topic_prefix: 'ble-proxy',
    embedded_broker_port: 0, // ephemeral
    embedded_broker_bind: '127.0.0.1',
    ...overrides,
  };
}

describe('bootstrapMqttProxy', () => {
  it('is a no-op when broker_url is already configured', async () => {
    const mqttProxy = baseConfig({ broker_url: 'mqtt://192.168.1.10:1883' });
    const result = await bootstrapMqttProxy(mqttProxy);
    expect(result.embeddedBroker).toBeNull();
    expect(result.mqttProxy.broker_url).toBe('mqtt://192.168.1.10:1883');
  });

  it('starts the embedded broker when broker_url is absent', async () => {
    const mqttProxy = baseConfig();
    const result = await bootstrapMqttProxy(mqttProxy);
    try {
      expect(result.embeddedBroker).not.toBeNull();
      expect(result.mqttProxy.broker_url).toMatch(/^mqtt:\/\/127\.0\.0\.1:\d+$/);
      expect(result.mqttProxy.broker_url).toBe(result.embeddedBroker!.url);
    } finally {
      if (result.embeddedBroker) await result.embeddedBroker.close();
    }
  });

  it('propagates credentials from config to the embedded broker', async () => {
    const mqttProxy = baseConfig({ username: 'alice', password: 'secret' });
    const result = await bootstrapMqttProxy(mqttProxy);
    try {
      expect(result.embeddedBroker).not.toBeNull();
      const { connectAsync } = await import('mqtt');
      await expect(
        connectAsync(result.mqttProxy.broker_url!, {
          clientId: 'auth-check',
          clean: true,
          reconnectPeriod: 0,
          connectTimeout: 1500,
          // no credentials -> must be rejected
        }),
      ).rejects.toThrow();
    } finally {
      if (result.embeddedBroker) await result.embeddedBroker.close();
    }
  });
});
