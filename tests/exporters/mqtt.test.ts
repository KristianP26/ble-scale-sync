import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import type { MqttConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

const samplePayload: BodyComposition = {
  weight: 80,
  impedance: 500,
  bmi: 23.9,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 62.4,
  visceralFat: 8,
  physiqueRating: 5,
  bmr: 1750,
  metabolicAge: 30,
};

const defaultConfig: MqttConfig = {
  brokerUrl: 'mqtt://localhost:1883',
  topic: 'scale/body-composition',
  qos: 1,
  retain: true,
  clientId: 'ble-scale-sync',
  haDiscovery: false,
};

const { mockPublishAsync, mockEndAsync, mockConnectAsync } = vi.hoisted(() => {
  const mockPublishAsync = vi.fn().mockResolvedValue(undefined);
  const mockEndAsync = vi.fn().mockResolvedValue(undefined);
  const mockConnectAsync = vi.fn().mockResolvedValue({
    publishAsync: mockPublishAsync,
    endAsync: mockEndAsync,
  });
  return { mockPublishAsync, mockEndAsync, mockConnectAsync };
});

vi.mock('mqtt', () => ({
  connectAsync: mockConnectAsync,
}));

describe('MqttExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectAsync.mockResolvedValue({
      publishAsync: mockPublishAsync,
      endAsync: mockEndAsync,
    });
    mockPublishAsync.mockResolvedValue(undefined);
    mockEndAsync.mockResolvedValue(undefined);
  });

  it('has name "mqtt"', () => {
    const exporter = new MqttExporter(defaultConfig);
    expect(exporter.name).toBe('mqtt');
  });

  it('publishes payload as JSON to configured topic', async () => {
    const exporter = new MqttExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockConnectAsync).toHaveBeenCalledWith('mqtt://localhost:1883', {
      clientId: 'ble-scale-sync',
      username: undefined,
      password: undefined,
      connectTimeout: 10_000,
    });
    expect(mockPublishAsync).toHaveBeenCalledWith(
      'scale/body-composition',
      JSON.stringify(samplePayload),
      { qos: 1, retain: true },
    );
    expect(mockEndAsync).toHaveBeenCalled();
  });

  it('passes username and password when configured', async () => {
    const config: MqttConfig = {
      ...defaultConfig,
      username: 'user',
      password: 'pass',
    };
    const exporter = new MqttExporter(config);
    await exporter.export(samplePayload);

    expect(mockConnectAsync).toHaveBeenCalledWith(
      'mqtt://localhost:1883',
      expect.objectContaining({ username: 'user', password: 'pass' }),
    );
  });

  it('returns failure after retries when connect fails', async () => {
    mockConnectAsync.mockRejectedValue(new Error('connection refused'));
    const exporter = new MqttExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('connection refused');
    // 1 initial + 2 retries = 3 attempts
    expect(mockConnectAsync).toHaveBeenCalledTimes(3);
  });

  it('returns failure after retries when publish fails', async () => {
    mockPublishAsync.mockRejectedValue(new Error('publish timeout'));
    const exporter = new MqttExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('publish timeout');
    expect(mockPublishAsync).toHaveBeenCalledTimes(3);
  });

  it('always calls endAsync even if publish fails', async () => {
    mockPublishAsync.mockRejectedValue(new Error('fail'));
    const exporter = new MqttExporter(defaultConfig);
    await exporter.export(samplePayload);

    // endAsync should have been called on each attempt
    expect(mockEndAsync).toHaveBeenCalledTimes(3);
  });

  it('uses custom topic and qos', async () => {
    const config: MqttConfig = {
      ...defaultConfig,
      topic: 'home/weight',
      qos: 0,
      retain: false,
    };
    const exporter = new MqttExporter(config);
    await exporter.export(samplePayload);

    expect(mockPublishAsync).toHaveBeenCalledWith('home/weight', expect.any(String), {
      qos: 0,
      retain: false,
    });
  });

  describe('Home Assistant discovery', () => {
    it('publishes discovery payloads before data when haDiscovery is true', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      // 11 discovery topics + 1 data topic = 12 publishAsync calls
      expect(mockPublishAsync).toHaveBeenCalledTimes(12);

      // First call should be a discovery config topic
      const firstCall = mockPublishAsync.mock.calls[0];
      expect(firstCall[0]).toMatch(/^homeassistant\/sensor\/ble-scale-sync\//);
      expect(firstCall[2]).toEqual({ qos: 1, retain: true });

      // Last call should be the actual data
      const lastCall = mockPublishAsync.mock.calls[11];
      expect(lastCall[0]).toBe('scale/body-composition');
      expect(lastCall[1]).toBe(JSON.stringify(samplePayload));
    });

    it('sends correct discovery payload structure for weight', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightCall = mockPublishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
      );
      expect(weightCall).toBeDefined();

      const payload = JSON.parse(weightCall![1] as string);
      expect(payload).toMatchObject({
        name: 'Weight',
        unique_id: 'ble-scale-sync_weight',
        state_topic: 'scale/body-composition',
        value_template: '{{ value_json.weight }}',
        state_class: 'measurement',
        unit_of_measurement: 'kg',
        device_class: 'weight',
        device: {
          identifiers: ['ble-scale-sync'],
          name: 'BLE Scale',
        },
      });
    });

    it('uses configured topic as state_topic in discovery', async () => {
      const config: MqttConfig = {
        ...defaultConfig,
        topic: 'home/my-scale',
        haDiscovery: true,
      };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const bmiCall = mockPublishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/bmi/config',
      );
      const payload = JSON.parse(bmiCall![1] as string);
      expect(payload.state_topic).toBe('home/my-scale');
    });

    it('does not publish discovery when haDiscovery is false', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: false };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      // Only the data publish, no discovery
      expect(mockPublishAsync).toHaveBeenCalledTimes(1);
      expect(mockPublishAsync.mock.calls[0][0]).toBe('scale/body-composition');
    });

    it('shares device object across all discovery payloads', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const discoveryCalls = mockPublishAsync.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).startsWith('homeassistant/'),
      );
      expect(discoveryCalls.length).toBe(11);

      const devices = discoveryCalls.map((c: unknown[]) => JSON.parse(c[1] as string).device);
      // All device objects should be identical
      for (const dev of devices) {
        expect(dev).toEqual(devices[0]);
      }
    });
  });
});
