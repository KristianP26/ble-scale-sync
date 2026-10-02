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
  haDeviceName: 'BLE Scale',
};

// The exporter uses `mqtt.connect()`, which returns the client synchronously
// and signals readiness with a 'connect' event, so the fake has to model that
// rather than resolve a ready client. See tests/helpers/fake-mqtt.ts.
const { fakeMqtt } = await vi.hoisted(async () => {
  const { createFakeMqtt } = await import('../helpers/fake-mqtt.js');
  return { fakeMqtt: createFakeMqtt() };
});

vi.mock('mqtt', () => ({
  connect: fakeMqtt.connect,
}));

describe('MqttExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeMqtt.reset();
  });

  it('has name "mqtt"', () => {
    const exporter = new MqttExporter(defaultConfig);
    expect(exporter.name).toBe('mqtt');
  });

  it('publishes payload as JSON to configured topic', async () => {
    const exporter = new MqttExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(fakeMqtt.connect).toHaveBeenCalledWith('mqtt://localhost:1883', {
      clientId: 'ble-scale-sync',
      username: undefined,
      password: undefined,
      connectTimeout: 10_000,
    });
    expect(fakeMqtt.publishAsync).toHaveBeenCalledWith(
      'scale/body-composition',
      JSON.stringify(samplePayload),
      { qos: 1, retain: true },
    );
    expect(fakeMqtt.endAsync).toHaveBeenCalled();
  });

  it('passes username and password when configured', async () => {
    const config: MqttConfig = {
      ...defaultConfig,
      username: 'user',
      password: 'pass',
    };
    const exporter = new MqttExporter(config);
    await exporter.export(samplePayload);

    expect(fakeMqtt.connect).toHaveBeenCalledWith(
      'mqtt://localhost:1883',
      expect.objectContaining({ username: 'user', password: 'pass' }),
    );
  });

  it('returns failure after retries when connect fails', async () => {
    fakeMqtt.setBehaviour({ kind: 'error', error: new Error('connection refused') });
    const exporter = new MqttExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('connection refused');
    // 1 initial + 2 retries = 3 attempts
    expect(fakeMqtt.connect).toHaveBeenCalledTimes(3);
  });

  it('returns failure after retries when publish fails', async () => {
    fakeMqtt.publishAsync.mockRejectedValue(new Error('publish timeout'));
    const exporter = new MqttExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('publish timeout');
    expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(3);
  });

  it('always calls endAsync even if publish fails', async () => {
    fakeMqtt.publishAsync.mockRejectedValue(new Error('fail'));
    const exporter = new MqttExporter(defaultConfig);
    await exporter.export(samplePayload);

    // endAsync should have been called on each attempt
    expect(fakeMqtt.endAsync).toHaveBeenCalledTimes(3);
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

    expect(fakeMqtt.publishAsync).toHaveBeenCalledWith('home/weight', expect.any(String), {
      qos: 0,
      retain: false,
    });
  });

  describe('Home Assistant discovery', () => {
    it('publishes discovery payloads + status + data when haDiscovery is true', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      // 11 discovery topics + 1 status publish + 1 data topic = 13 publishAsync calls
      expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(13);

      // First call should be a discovery config topic
      const firstCall = fakeMqtt.publishAsync.mock.calls[0];
      expect(firstCall[0]).toMatch(/^homeassistant\/sensor\/ble-scale-sync\//);
      expect(firstCall[2]).toEqual({ qos: 1, retain: true });

      // Second to last call should be the status publish
      const statusCall = fakeMqtt.publishAsync.mock.calls[11];
      expect(statusCall[0]).toBe('scale/body-composition/status');
      expect(statusCall[1]).toBe('online');

      // Last call should be the actual data
      const lastCall = fakeMqtt.publishAsync.mock.calls[12];
      expect(lastCall[0]).toBe('scale/body-composition');
      expect(lastCall[1]).toBe(JSON.stringify(samplePayload));
    });

    it('sends correct discovery payload structure for weight', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find(
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
        suggested_display_precision: 2,
        availability: [{ topic: 'scale/body-composition/status' }],
        device: {
          identifiers: ['ble-scale-sync'],
          name: 'BLE Scale',
          sw_version: expect.any(String),
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

      const bmiCall = fakeMqtt.publishAsync.mock.calls.find(
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
      expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(1);
      expect(fakeMqtt.publishAsync.mock.calls[0][0]).toBe('scale/body-composition');
    });

    it('shares device object across all discovery payloads', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const discoveryCalls = fakeMqtt.publishAsync.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).startsWith('homeassistant/'),
      );
      expect(discoveryCalls.length).toBe(11);

      const devices = discoveryCalls.map((c: unknown[]) => JSON.parse(c[1] as string).device);
      // All device objects should be identical
      for (const dev of devices) {
        expect(dev).toEqual(devices[0]);
      }
    });

    it('includes availability topic in discovery payloads', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const discoveryCalls = fakeMqtt.publishAsync.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).startsWith('homeassistant/'),
      );
      for (const call of discoveryCalls) {
        const payload = JSON.parse(call[1] as string);
        expect(payload.availability).toEqual([{ topic: 'scale/body-composition/status' }]);
      }
    });

    it('publishes online status after discovery', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      // Call index 11 (after 11 discovery payloads) should be the status publish
      const statusCall = fakeMqtt.publishAsync.mock.calls[11];
      expect(statusCall[0]).toBe('scale/body-composition/status');
      expect(statusCall[1]).toBe('online');
      expect(statusCall[2]).toEqual({ qos: 1, retain: true });
    });

    it('includes sw_version in device object', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
      );
      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.device.sw_version).toBeDefined();
      expect(typeof payload.device.sw_version).toBe('string');
    });

    it('sets precision 2 for weight and 1 for bmi', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightPayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
        )![1] as string,
      );
      expect(weightPayload.suggested_display_precision).toBe(2);

      const bmiPayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/bmi/config',
        )![1] as string,
      );
      expect(bmiPayload.suggested_display_precision).toBe(1);
    });

    it('does not set precision for impedance', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const impedancePayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/impedance/config',
        )![1] as string,
      );
      expect(impedancePayload.suggested_display_precision).toBeUndefined();
    });

    it('sets entity_category for impedance and physiqueRating', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const impedancePayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/impedance/config',
        )![1] as string,
      );
      expect(impedancePayload.entity_category).toBe('diagnostic');

      const physiquePayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/physiqueRating/config',
        )![1] as string,
      );
      expect(physiquePayload.entity_category).toBe('diagnostic');
    });

    it('does not set entity_category for weight', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightPayload = JSON.parse(
        fakeMqtt.publishAsync.mock.calls.find(
          (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
        )![1] as string,
      );
      expect(weightPayload.entity_category).toBeUndefined();
    });

    it('uses configurable haDeviceName', async () => {
      const config: MqttConfig = {
        ...defaultConfig,
        haDiscovery: true,
        haDeviceName: 'My Custom Scale',
      };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
      );
      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.device.name).toBe('My Custom Scale');
    });

    it('includes LWT in connect options when haDiscovery is true', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      expect(fakeMqtt.connect).toHaveBeenCalledWith(
        'mqtt://localhost:1883',
        expect.objectContaining({
          will: {
            topic: 'scale/body-composition/status',
            payload: Buffer.from('offline'),
            qos: 1,
            retain: true,
          },
        }),
      );
    });

    it('does not include LWT when haDiscovery is false', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: false };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const connectOpts = fakeMqtt.connect.mock.calls[0][1];
      expect(connectOpts.will).toBeUndefined();
    });
  });
});
