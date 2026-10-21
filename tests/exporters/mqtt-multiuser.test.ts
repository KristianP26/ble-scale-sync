import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import type { MqttConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';
import type { ExportContext } from '../../src/interfaces/exporter.js';

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

const userContext: ExportContext = {
  userName: 'Dad',
  userSlug: 'dad',
  timestamp: MEASURED_AT,
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

describe('MqttExporter multi-user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeMqtt.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Topic routing ──────────────────────────────────────────────────────

  describe('topic routing', () => {
    it('publishes to {topic}/{slug} when context has userSlug', async () => {
      const exporter = new MqttExporter(defaultConfig);
      await exporter.export(samplePayload, userContext);

      expect(fakeMqtt.publishAsync).toHaveBeenCalledWith('scale/body-composition/dad', STATE_JSON, {
        qos: 1,
        retain: true,
      });
    });

    it('publishes to base topic when no context', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MEASURED_AT);
      const exporter = new MqttExporter(defaultConfig);
      await exporter.export(samplePayload);

      expect(fakeMqtt.publishAsync).toHaveBeenCalledWith('scale/body-composition', STATE_JSON, {
        qos: 1,
        retain: true,
      });
    });

    // The context also has no timestamp, so this is the one case where a
    // context is present but the publish time has to stand in for it.
    it('publishes to base topic when context has no userSlug', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MEASURED_AT);
      const exporter = new MqttExporter(defaultConfig);
      await exporter.export(samplePayload, { userName: 'Dad' });

      expect(fakeMqtt.publishAsync).toHaveBeenCalledWith('scale/body-composition', STATE_JSON, {
        qos: 1,
        retain: true,
      });
    });
  });

  // ─── HA Discovery per user ────────────────────────────────────────────

  describe('HA discovery per user', () => {
    const haConfig: MqttConfig = { ...defaultConfig, haDiscovery: true };

    it('uses per-user device identifiers when context has userSlug', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload, userContext);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync-dad/weight/config',
      );
      expect(weightCall).toBeDefined();

      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.unique_id).toBe('ble-scale-sync-dad_weight');
      expect(payload.device.identifiers).toEqual(['ble-scale-sync-dad']);
    });

    it('includes user name in device name', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload, userContext);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find((c: unknown[]) =>
        (c[0] as string).includes('ble-scale-sync-dad/weight/config'),
      );
      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.device.name).toBe('BLE Scale (Dad)');
    });

    it('uses per-user state_topic in discovery', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload, userContext);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find((c: unknown[]) =>
        (c[0] as string).includes('ble-scale-sync-dad/weight/config'),
      );
      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.state_topic).toBe('scale/body-composition/dad');
    });

    it('uses per-user availability topic in discovery', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload, userContext);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find((c: unknown[]) =>
        (c[0] as string).includes('ble-scale-sync-dad/weight/config'),
      );
      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.availability).toEqual([{ topic: 'scale/body-composition/dad/status' }]);
    });

    it('publishes per-user status online', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload, userContext);

      const statusCall = fakeMqtt.publishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'scale/body-composition/dad/status' && c[1] === 'online',
      );
      expect(statusCall).toBeDefined();
    });

    it("gives each user a timestamp sensor on that user's device", async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload, userContext);

      const timestampCall = fakeMqtt.publishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync-dad/timestamp/config',
      );
      expect(timestampCall).toBeDefined();

      const payload = JSON.parse(timestampCall![1] as string);
      expect(payload).toMatchObject({
        unique_id: 'ble-scale-sync-dad_timestamp',
        state_topic: 'scale/body-composition/dad',
        availability: [{ topic: 'scale/body-composition/dad/status' }],
        device: { identifiers: ['ble-scale-sync-dad'], name: 'BLE Scale (Dad)' },
      });
    });

    it('falls back to default device when no context', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload);

      const weightCall = fakeMqtt.publishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'homeassistant/sensor/ble-scale-sync/weight/config',
      );
      expect(weightCall).toBeDefined();

      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.unique_id).toBe('ble-scale-sync_weight');
      expect(payload.device.identifiers).toEqual(['ble-scale-sync']);
      expect(payload.device.name).toBe('BLE Scale');
    });
  });

  // ─── LWT per user ────────────────────────────────────────────────────

  describe('LWT per user', () => {
    it('sets per-user LWT when context has userSlug and HA is enabled', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: true };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload, userContext);

      expect(fakeMqtt.connect).toHaveBeenCalledWith(
        'mqtt://localhost:1883',
        expect.objectContaining({
          will: {
            topic: 'scale/body-composition/dad/status',
            payload: Buffer.from('offline'),
            qos: 1,
            retain: true,
          },
        }),
      );
    });

    it('sets base LWT when no context and HA is enabled', async () => {
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

    it('does not include LWT when HA is disabled', async () => {
      const config: MqttConfig = { ...defaultConfig, haDiscovery: false };
      const exporter = new MqttExporter(config);
      await exporter.export(samplePayload, userContext);

      const connectOpts = fakeMqtt.connect.mock.calls[0][1];
      expect(connectOpts.will).toBeUndefined();
    });
  });

  // ─── Different users produce different topics ──────────────────────────

  describe('multiple users', () => {
    it('publishes to different topics for different users', async () => {
      const exporter = new MqttExporter(defaultConfig);

      await exporter.export(samplePayload, { userName: 'Dad', userSlug: 'dad' });
      expect(fakeMqtt.publishAsync).toHaveBeenCalledWith(
        'scale/body-composition/dad',
        expect.any(String),
        expect.any(Object),
      );

      fakeMqtt.reset();

      await exporter.export(samplePayload, { userName: 'Mom', userSlug: 'mom' });
      expect(fakeMqtt.publishAsync).toHaveBeenCalledWith(
        'scale/body-composition/mom',
        expect.any(String),
        expect.any(Object),
      );
    });
  });
});
