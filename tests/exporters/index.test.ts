import { describe, it, expect } from 'vitest';
import { createExporters } from '../../src/exporters/index.js';
import { GarminExporter } from '../../src/exporters/garmin.js';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import { WebhookExporter } from '../../src/exporters/webhook.js';
import { InfluxDbExporter } from '../../src/exporters/influxdb.js';
import { NtfyExporter } from '../../src/exporters/ntfy.js';
import { TelegramExporter } from '../../src/exporters/telegram.js';
import { IntervalsExporter } from '../../src/exporters/intervals.js';
import { RunalyzeExporter } from '../../src/exporters/runalyze.js';
import { WgerExporter } from '../../src/exporters/wger.js';
import { HealthLogExporter } from '../../src/exporters/healthlog.js';
import type { ExporterConfig } from '../../src/exporters/config.js';

describe('createExporters()', () => {
  it('creates GarminExporter for garmin', () => {
    const config: ExporterConfig = { exporters: ['garmin'] };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(GarminExporter);
    expect(exporters[0].name).toBe('garmin');
  });

  it('creates MqttExporter for mqtt', () => {
    const config: ExporterConfig = {
      exporters: ['mqtt'],
      mqtt: {
        brokerUrl: 'mqtt://localhost:1883',
        topic: 'test',
        qos: 1,
        retain: true,
        clientId: 'test',
        haDiscovery: true,
        haDeviceName: 'BLE Scale',
      },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(MqttExporter);
    expect(exporters[0].name).toBe('mqtt');
  });

  it('creates multiple exporters in order', () => {
    const config: ExporterConfig = {
      exporters: ['garmin', 'mqtt'],
      mqtt: {
        brokerUrl: 'mqtt://localhost:1883',
        topic: 'test',
        qos: 1,
        retain: true,
        clientId: 'test',
        haDiscovery: true,
        haDeviceName: 'BLE Scale',
      },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(2);
    expect(exporters[0]).toBeInstanceOf(GarminExporter);
    expect(exporters[1]).toBeInstanceOf(MqttExporter);
  });

  it('creates WebhookExporter for webhook', () => {
    const config: ExporterConfig = {
      exporters: ['webhook'],
      webhook: {
        url: 'https://example.com/hook',
        method: 'POST',
        headers: {},
        timeout: 10_000,
      },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(WebhookExporter);
    expect(exporters[0].name).toBe('webhook');
  });

  it('creates InfluxDbExporter for influxdb', () => {
    const config: ExporterConfig = {
      exporters: ['influxdb'],
      influxdb: {
        url: 'http://localhost:8086',
        token: 'my-token',
        org: 'my-org',
        bucket: 'my-bucket',
        measurement: 'body_composition',
      },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(InfluxDbExporter);
    expect(exporters[0].name).toBe('influxdb');
  });

  it('creates NtfyExporter for ntfy', () => {
    const config: ExporterConfig = {
      exporters: ['ntfy'],
      ntfy: {
        url: 'https://ntfy.sh',
        topic: 'my-scale',
        title: 'Scale Measurement',
        priority: 3,
      },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(NtfyExporter);
    expect(exporters[0].name).toBe('ntfy');
  });

  it('creates TelegramExporter for telegram', () => {
    const config: ExporterConfig = {
      exporters: ['telegram'],
      telegram: {
        botToken: '123456:ABC',
        chatId: '987654321',
        title: 'Scale Measurement',
        silent: false,
      },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(TelegramExporter);
    expect(exporters[0].name).toBe('telegram');
  });

  it('creates IntervalsExporter for intervals', () => {
    const config: ExporterConfig = {
      exporters: ['intervals'],
      intervals: {
        athleteId: 'i123456',
        apiKey: 'abcdef123',
      },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(IntervalsExporter);
    expect(exporters[0].name).toBe('intervals');
  });

  it('creates RunalyzeExporter for runalyze', () => {
    const config: ExporterConfig = {
      exporters: ['runalyze'],
      runalyze: { token: 'tok-abc123' },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(RunalyzeExporter);
    expect(exporters[0].name).toBe('runalyze');
  });

  it('creates WgerExporter for wger', () => {
    const config: ExporterConfig = {
      exporters: ['wger'],
      wger: { baseUrl: 'https://wger.example', token: 'tok-1', syncMeasurements: true },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(WgerExporter);
    expect(exporters[0].name).toBe('wger');
  });

  it('creates HealthLogExporter for healthlog', () => {
    const config: ExporterConfig = {
      exporters: ['healthlog'],
      healthlog: { baseUrl: 'https://healthlog.example', token: 'tok-1', syncMeasurements: true },
    };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(1);
    expect(exporters[0]).toBeInstanceOf(HealthLogExporter);
    expect(exporters[0].name).toBe('healthlog');
  });

  it('returns empty array for empty exporters list', () => {
    const config: ExporterConfig = { exporters: [] };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(0);
  });
});
