import { describe, it, expect } from 'vitest';
import { createExporters } from '../../src/exporters/index.js';
import { GarminExporter } from '../../src/exporters/garmin.js';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import { WebhookExporter } from '../../src/exporters/webhook.js';
import { InfluxDbExporter } from '../../src/exporters/influxdb.js';
import { NtfyExporter } from '../../src/exporters/ntfy.js';
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

  it('returns empty array for empty exporters list', () => {
    const config: ExporterConfig = { exporters: [] };
    const exporters = createExporters(config);
    expect(exporters).toHaveLength(0);
  });
});
