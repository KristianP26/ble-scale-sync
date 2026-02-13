import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('MqttExporter multi-user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectAsync.mockResolvedValue({
      publishAsync: mockPublishAsync,
      endAsync: mockEndAsync,
    });
    mockPublishAsync.mockResolvedValue(undefined);
    mockEndAsync.mockResolvedValue(undefined);
  });

  // ─── Topic routing ──────────────────────────────────────────────────────

  describe('topic routing', () => {
    it('publishes to {topic}/{slug} when context has userSlug', async () => {
      const exporter = new MqttExporter(defaultConfig);
      await exporter.export(samplePayload, userContext);

      expect(mockPublishAsync).toHaveBeenCalledWith(
        'scale/body-composition/dad',
        JSON.stringify(samplePayload),
        { qos: 1, retain: true },
      );
    });

    it('publishes to base topic when no context', async () => {
      const exporter = new MqttExporter(defaultConfig);
      await exporter.export(samplePayload);

      expect(mockPublishAsync).toHaveBeenCalledWith(
        'scale/body-composition',
        JSON.stringify(samplePayload),
        { qos: 1, retain: true },
      );
    });

    it('publishes to base topic when context has no userSlug', async () => {
      const exporter = new MqttExporter(defaultConfig);
      await exporter.export(samplePayload, { userName: 'Dad' });

      expect(mockPublishAsync).toHaveBeenCalledWith(
        'scale/body-composition',
        JSON.stringify(samplePayload),
        { qos: 1, retain: true },
      );
    });
  });

  // ─── HA Discovery per user ────────────────────────────────────────────

  describe('HA discovery per user', () => {
    const haConfig: MqttConfig = { ...defaultConfig, haDiscovery: true };

    it('uses per-user device identifiers when context has userSlug', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload, userContext);

      const weightCall = mockPublishAsync.mock.calls.find(
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

      const weightCall = mockPublishAsync.mock.calls.find((c: unknown[]) =>
        (c[0] as string).includes('ble-scale-sync-dad/weight/config'),
      );
      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.device.name).toBe('BLE Scale (Dad)');
    });

    it('uses per-user state_topic in discovery', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload, userContext);

      const weightCall = mockPublishAsync.mock.calls.find((c: unknown[]) =>
        (c[0] as string).includes('ble-scale-sync-dad/weight/config'),
      );
      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.state_topic).toBe('scale/body-composition/dad');
    });

    it('uses per-user availability topic in discovery', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload, userContext);

      const weightCall = mockPublishAsync.mock.calls.find((c: unknown[]) =>
        (c[0] as string).includes('ble-scale-sync-dad/weight/config'),
      );
      const payload = JSON.parse(weightCall![1] as string);
      expect(payload.availability).toEqual([{ topic: 'scale/body-composition/dad/status' }]);
    });

    it('publishes per-user status online', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload, userContext);

      const statusCall = mockPublishAsync.mock.calls.find(
        (c: unknown[]) => c[0] === 'scale/body-composition/dad/status' && c[1] === 'online',
      );
      expect(statusCall).toBeDefined();
    });

    it('falls back to default device when no context', async () => {
      const exporter = new MqttExporter(haConfig);
      await exporter.export(samplePayload);

      const weightCall = mockPublishAsync.mock.calls.find(
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

      expect(mockConnectAsync).toHaveBeenCalledWith(
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

      expect(mockConnectAsync).toHaveBeenCalledWith(
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

      const connectOpts = mockConnectAsync.mock.calls[0][1];
      expect(connectOpts.will).toBeUndefined();
    });
  });

  // ─── Different users produce different topics ──────────────────────────

  describe('multiple users', () => {
    it('publishes to different topics for different users', async () => {
      const exporter = new MqttExporter(defaultConfig);

      await exporter.export(samplePayload, { userName: 'Dad', userSlug: 'dad' });
      expect(mockPublishAsync).toHaveBeenCalledWith(
        'scale/body-composition/dad',
        expect.any(String),
        expect.any(Object),
      );

      vi.clearAllMocks();
      mockConnectAsync.mockResolvedValue({
        publishAsync: mockPublishAsync,
        endAsync: mockEndAsync,
      });

      await exporter.export(samplePayload, { userName: 'Mom', userSlug: 'mom' });
      expect(mockPublishAsync).toHaveBeenCalledWith(
        'scale/body-composition/mom',
        expect.any(String),
        expect.any(Object),
      );
    });
  });
});
