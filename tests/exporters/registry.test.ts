import { describe, it, expect } from 'vitest';
import {
  EXPORTER_REGISTRY,
  EXPORTER_SCHEMAS,
  KNOWN_EXPORTER_NAMES,
  createExporterFromEntry,
} from '../../src/exporters/registry.js';
import { GarminExporter } from '../../src/exporters/garmin.js';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import { WebhookExporter } from '../../src/exporters/webhook.js';
import { InfluxDbExporter } from '../../src/exporters/influxdb.js';
import { NtfyExporter } from '../../src/exporters/ntfy.js';
import type { ExporterEntry } from '../../src/config/schema.js';

// ─── EXPORTER_REGISTRY ─────────────────────────────────────────────────────

describe('EXPORTER_REGISTRY', () => {
  it('contains 5 exporter entries', () => {
    expect(EXPORTER_REGISTRY).toHaveLength(5);
  });

  it('has entries for all known exporters', () => {
    const names = EXPORTER_REGISTRY.map((e) => e.schema.name);
    expect(names).toContain('garmin');
    expect(names).toContain('mqtt');
    expect(names).toContain('webhook');
    expect(names).toContain('influxdb');
    expect(names).toContain('ntfy');
  });

  it('each entry has a schema and factory', () => {
    for (const entry of EXPORTER_REGISTRY) {
      expect(entry.schema).toBeDefined();
      expect(entry.schema.name).toBeDefined();
      expect(entry.schema.displayName).toBeDefined();
      expect(entry.schema.description).toBeDefined();
      expect(entry.schema.fields).toBeInstanceOf(Array);
      expect(typeof entry.factory).toBe('function');
    }
  });
});

// ─── EXPORTER_SCHEMAS ──────────────────────────────────────────────────────

describe('EXPORTER_SCHEMAS', () => {
  it('derives 5 schemas from registry', () => {
    expect(EXPORTER_SCHEMAS).toHaveLength(5);
  });

  it('each schema has required fields', () => {
    for (const schema of EXPORTER_SCHEMAS) {
      expect(schema.name).toBeDefined();
      expect(schema.displayName).toBeDefined();
      expect(schema.description).toBeDefined();
      expect(schema.fields).toBeInstanceOf(Array);
      expect(typeof schema.supportsGlobal).toBe('boolean');
      expect(typeof schema.supportsPerUser).toBe('boolean');
    }
  });

  it('garmin schema supports per-user only', () => {
    const garmin = EXPORTER_SCHEMAS.find((s) => s.name === 'garmin');
    expect(garmin).toBeDefined();
    expect(garmin!.supportsGlobal).toBe(false);
    expect(garmin!.supportsPerUser).toBe(true);
  });

  it('garmin schema has Python dependency', () => {
    const garmin = EXPORTER_SCHEMAS.find((s) => s.name === 'garmin');
    expect(garmin!.dependencies).toBeDefined();
    expect(garmin!.dependencies).toHaveLength(1);
    expect(garmin!.dependencies![0].name).toBe('Python 3');
  });

  it('mqtt schema supports global only', () => {
    const mqtt = EXPORTER_SCHEMAS.find((s) => s.name === 'mqtt');
    expect(mqtt).toBeDefined();
    expect(mqtt!.supportsGlobal).toBe(true);
    expect(mqtt!.supportsPerUser).toBe(false);
  });

  it('mqtt schema has required broker_url field', () => {
    const mqtt = EXPORTER_SCHEMAS.find((s) => s.name === 'mqtt');
    const brokerField = mqtt!.fields.find((f) => f.key === 'broker_url');
    expect(brokerField).toBeDefined();
    expect(brokerField!.required).toBe(true);
  });

  it('webhook schema has url as required field', () => {
    const webhook = EXPORTER_SCHEMAS.find((s) => s.name === 'webhook');
    const urlField = webhook!.fields.find((f) => f.key === 'url');
    expect(urlField).toBeDefined();
    expect(urlField!.required).toBe(true);
  });

  it('influxdb schema has 4 required fields', () => {
    const influxdb = EXPORTER_SCHEMAS.find((s) => s.name === 'influxdb');
    const requiredFields = influxdb!.fields.filter((f) => f.required);
    expect(requiredFields).toHaveLength(4);
    const keys = requiredFields.map((f) => f.key);
    expect(keys).toContain('url');
    expect(keys).toContain('token');
    expect(keys).toContain('org');
    expect(keys).toContain('bucket');
  });

  it('ntfy schema has topic as only required field', () => {
    const ntfy = EXPORTER_SCHEMAS.find((s) => s.name === 'ntfy');
    const requiredFields = ntfy!.fields.filter((f) => f.required);
    expect(requiredFields).toHaveLength(1);
    expect(requiredFields[0].key).toBe('topic');
  });
});

// ─── KNOWN_EXPORTER_NAMES ──────────────────────────────────────────────────

describe('KNOWN_EXPORTER_NAMES', () => {
  it('is a Set with 5 entries', () => {
    expect(KNOWN_EXPORTER_NAMES).toBeInstanceOf(Set);
    expect(KNOWN_EXPORTER_NAMES.size).toBe(5);
  });

  it('contains all exporter names', () => {
    expect(KNOWN_EXPORTER_NAMES.has('garmin')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('mqtt')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('webhook')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('influxdb')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('ntfy')).toBe(true);
  });
});

// ─── createExporterFromEntry() ─────────────────────────────────────────────

describe('createExporterFromEntry()', () => {
  it('creates GarminExporter from entry', () => {
    const entry: ExporterEntry = { type: 'garmin' };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(GarminExporter);
    expect(exporter.name).toBe('garmin');
  });

  it('creates GarminExporter with config fields', () => {
    const entry: ExporterEntry = {
      type: 'garmin',
      email: 'test@example.com',
      password: 'secret',
      token_dir: './tokens/test',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(GarminExporter);
  });

  it('creates MqttExporter from entry', () => {
    const entry: ExporterEntry = {
      type: 'mqtt',
      broker_url: 'mqtt://localhost:1883',
      topic: 'test/topic',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(MqttExporter);
    expect(exporter.name).toBe('mqtt');
  });

  it('creates WebhookExporter from entry', () => {
    const entry: ExporterEntry = {
      type: 'webhook',
      url: 'https://example.com/hook',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(WebhookExporter);
    expect(exporter.name).toBe('webhook');
  });

  it('creates InfluxDbExporter from entry', () => {
    const entry: ExporterEntry = {
      type: 'influxdb',
      url: 'http://localhost:8086',
      token: 'my-token',
      org: 'my-org',
      bucket: 'my-bucket',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(InfluxDbExporter);
    expect(exporter.name).toBe('influxdb');
  });

  it('creates NtfyExporter from entry', () => {
    const entry: ExporterEntry = {
      type: 'ntfy',
      topic: 'my-scale',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(NtfyExporter);
    expect(exporter.name).toBe('ntfy');
  });

  it('throws on unknown exporter type', () => {
    const entry: ExporterEntry = { type: 'unknown' };
    expect(() => createExporterFromEntry(entry)).toThrow("Unknown exporter type 'unknown'");
  });

  it('error message includes known exporter names', () => {
    const entry: ExporterEntry = { type: 'bad' };
    expect(() => createExporterFromEntry(entry)).toThrow('garmin');
    expect(() => createExporterFromEntry(entry)).toThrow('mqtt');
  });

  it('applies defaults for optional MQTT fields', () => {
    const entry: ExporterEntry = {
      type: 'mqtt',
      broker_url: 'mqtt://localhost:1883',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(MqttExporter);
    // Verify it was created successfully with defaults (no throw)
  });

  it('applies defaults for optional ntfy fields', () => {
    const entry: ExporterEntry = {
      type: 'ntfy',
      topic: 'test',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(NtfyExporter);
  });
});
