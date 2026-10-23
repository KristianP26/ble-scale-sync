import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const MEASURED_AT = new Date('2026-10-20T21:30:00Z');
// A literal, not MEASURED_AT.toISOString(), so the tests pin the format.
const MEASURED_AT_ISO = '2026-10-20T21:30:00.000Z';
const STATE_JSON = JSON.stringify({ timestamp: MEASURED_AT_ISO, ...samplePayload });

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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has name "mqtt"', () => {
    const exporter = new MqttExporter(defaultConfig);
    expect(exporter.name).toBe('mqtt');
  });

  it('publishes payload as JSON to configured topic', async () => {
    const exporter = new MqttExporter(defaultConfig);
    const result = await exporter.export(samplePayload, { timestamp: MEASURED_AT });

    expect(result.success).toBe(true);
    expect(fakeMqtt.connect).toHaveBeenCalledWith('mqtt://localhost:1883', {
      clientId: 'ble-scale-sync',
      username: undefined,
      password: undefined,
      connectTimeout: 10_000,
    });
    expect(fakeMqtt.publishAsync).toHaveBeenCalledWith('scale/body-composition', STATE_JSON, {
      qos: 1,
      retain: true,
    });
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

  describe('measurement time (#478)', () => {
    it('publishes the measurement time from the context, not the time of the publish', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
      const exporter = new MqttExporter(defaultConfig);
      await exporter.export(samplePayload, { timestamp: MEASURED_AT });

      const { timestamp, ...rest } = JSON.parse(fakeMqtt.publishAsync.mock.calls[0][1] as string);
      expect(timestamp).toBe(MEASURED_AT_ISO);
      expect(rest).toEqual(samplePayload);
    });

    it('falls back to the time of the export without a measurement time', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MEASURED_AT);
      const exporter = new MqttExporter(defaultConfig);
      await exporter.export(samplePayload);

      const state = JSON.parse(fakeMqtt.publishAsync.mock.calls[0][1] as string);
      expect(state.timestamp).toBe(MEASURED_AT_ISO);
    });

    it('sends the same timestamp on every retry of one export', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MEASURED_AT);
      // The first attempt fails seven seconds later; the retry must still send
      // the time the export started with, not the time it was retried at.
      fakeMqtt.publishAsync.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date('2026-10-20T21:30:07Z'));
        throw new Error('publish refused');
      });
      const exporter = new MqttExporter(defaultConfig);
      const result = await exporter.export(samplePayload);

      expect(result.success).toBe(true);
      expect(
        fakeMqtt.publishAsync.mock.calls.map(
          (c: unknown[]) => JSON.parse(c[1] as string).timestamp,
        ),
      ).toEqual([MEASURED_AT_ISO, MEASURED_AT_ISO]);
    });
  });

  describe('Home Assistant discovery', () => {
    it('publishes discovery payloads + status + data when haDiscovery is true', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload, { timestamp: MEASURED_AT });

      // 12 discovery topics + 1 status publish + 1 data topic = 14 publishAsync calls
      expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(14);

      // First call should be a discovery config topic
      const firstCall = fakeMqtt.publishAsync.mock.calls[0];
      expect(firstCall[0]).toMatch(/^homeassistant\/sensor\/ble-scale-sync\//);
      expect(firstCall[2]).toEqual({ qos: 1, retain: true });

      // Second to last call should be the status publish
      const statusCall = fakeMqtt.publishAsync.mock.calls[12];
      expect(statusCall[0]).toBe('scale/body-composition/status');
      expect(statusCall[1]).toBe('online');

      // Last call should be the actual data
      const lastCall = fakeMqtt.publishAsync.mock.calls[13];
      expect(lastCall[0]).toBe('scale/body-composition');
      expect(lastCall[1]).toBe(STATE_JSON);
    });

    it('adds a Last Weigh-in timestamp sensor, the only one without a state class', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload);

      const configs = new Map(
        fakeMqtt.publishAsync.mock.calls
          .filter((c: unknown[]) => (c[0] as string).startsWith('homeassistant/'))
          .map((c: unknown[]) => [c[0] as string, JSON.parse(c[1] as string)]),
      );
      const timestampTopic = 'homeassistant/sensor/ble-scale-sync/timestamp/config';
      const sensor = configs.get(timestampTopic);
      expect(sensor).toBeDefined();
      expect(sensor).toMatchObject({
        name: 'Last Weigh-in',
        unique_id: 'ble-scale-sync_timestamp',
        state_topic: 'scale/body-composition',
        value_template: '{{ value_json.timestamp }}',
        device_class: 'timestamp',
        availability: [{ topic: 'scale/body-composition/status' }],
        device: { identifiers: ['ble-scale-sync'] },
      });
      // HA rejects a unit and warns about a state class on a timestamp sensor.
      for (const key of [
        'state_class',
        'unit_of_measurement',
        'suggested_display_precision',
        'entity_category',
        'icon',
      ]) {
        expect(sensor).not.toHaveProperty(key);
      }

      // The exception is the timestamp sensor alone, and none of them forces
      // an update: a replayed retained message must not look like a weigh-in.
      for (const [topic, payload] of configs) {
        if (topic !== timestampTopic) expect(payload.state_class).toBe('measurement');
        expect(payload).not.toHaveProperty('force_update');
      }
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
      expect(discoveryCalls.length).toBe(12);

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

      // Call index 12 (after 12 discovery payloads) should be the status publish
      const statusCall = fakeMqtt.publishAsync.mock.calls[12];
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

    describe('a metric only some weigh-ins carry (#497)', () => {
      const SKELETAL_TOPIC = 'homeassistant/sensor/ble-scale-sync/skeletalMusclePercent/config';

      function discovery(): Map<string, Record<string, unknown>> {
        return new Map(
          fakeMqtt.publishAsync.mock.calls
            .filter((c: unknown[]) => (c[0] as string).startsWith('homeassistant/'))
            .map((c: unknown[]) => [c[0] as string, JSON.parse(c[1] as string)]),
        );
      }

      function discoveryLog(spy: { mock: { calls: unknown[][] } }): string[] {
        return spy.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes('Published HA discovery'));
      }

      it('publishes its sensor with a payload that has it: 13 configs, status, data', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          const exporter = new MqttExporter({ ...defaultConfig, haDiscovery: true });
          const data = { ...samplePayload, skeletalMusclePercent: 47.8 };
          await exporter.export(data, { timestamp: MEASURED_AT });

          expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(15);
          const sensor = discovery().get(SKELETAL_TOPIC);
          expect(sensor).toEqual({
            name: 'Skeletal Muscle',
            unique_id: 'ble-scale-sync_skeletalMusclePercent',
            state_topic: 'scale/body-composition',
            value_template:
              "{{ value_json.skeletalMusclePercent if value_json.skeletalMusclePercent is defined else 'None' }}",
            state_class: 'measurement',
            availability: [{ topic: 'scale/body-composition/status' }],
            device: expect.objectContaining({ identifiers: ['ble-scale-sync'] }),
            unit_of_measurement: '%',
            icon: 'mdi:arm-flex',
            suggested_display_precision: 1,
          });
          const state = JSON.parse(fakeMqtt.publishAsync.mock.calls[14][1] as string);
          expect(state.skeletalMusclePercent).toBe(47.8);
          expect(discoveryLog(log)).toEqual([
            expect.stringContaining('Published HA discovery for 13 sensors.'),
          ]);
        } finally {
          log.mockRestore();
        }
      });

      // A setup whose scale never measures it gets no entity at all, and the
      // twelve sensors every payload feeds keep their plain templates.
      it('publishes no sensor for it with a payload without it, and leaves the others as they were', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          const exporter = new MqttExporter({ ...defaultConfig, haDiscovery: true });
          await exporter.export(samplePayload, { timestamp: MEASURED_AT });

          expect(fakeMqtt.publishAsync).toHaveBeenCalledTimes(14);
          const configs = discovery();
          expect(configs.has(SKELETAL_TOPIC)).toBe(false);
          expect([...configs.values()].map((c) => c.value_template).sort()).toEqual(
            [...Object.keys(samplePayload), 'timestamp'].map((k) => `{{ value_json.${k} }}`).sort(),
          );
          expect(discoveryLog(log)).toEqual([
            expect.stringContaining('Published HA discovery for 12 sensors.'),
          ]);
        } finally {
          log.mockRestore();
        }
      });
    });
  });
});
