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
import { FileExporter } from '../../src/exporters/file.js';
import { StravaExporter } from '../../src/exporters/strava.js';
import { TelegramExporter } from '../../src/exporters/telegram.js';
import { IntervalsExporter } from '../../src/exporters/intervals.js';
import type { ExporterEntry } from '../../src/config/schema.js';

// ─── EXPORTER_REGISTRY ─────────────────────────────────────────────────────

describe('EXPORTER_REGISTRY', () => {
  it('contains 11 exporter entries', () => {
    expect(EXPORTER_REGISTRY).toHaveLength(11);
  });

  it('has entries for all known exporters', () => {
    const names = EXPORTER_REGISTRY.map((e) => e.schema.name);
    expect(names).toContain('garmin');
    expect(names).toContain('mqtt');
    expect(names).toContain('webhook');
    expect(names).toContain('influxdb');
    expect(names).toContain('ntfy');
    expect(names).toContain('file');
    expect(names).toContain('strava');
    expect(names).toContain('telegram');
    expect(names).toContain('intervals');
    expect(names).toContain('runalyze');
    expect(names).toContain('wger');
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
  it('derives 11 schemas from registry', () => {
    expect(EXPORTER_SCHEMAS).toHaveLength(11);
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

  // `org` is deliberately not required: InfluxDB v3 has no organizations, and
  // the v2-compatible write endpoint ignores the parameter.
  it('influxdb schema has 3 required fields, org not among them', () => {
    const influxdb = EXPORTER_SCHEMAS.find((s) => s.name === 'influxdb');
    const requiredFields = influxdb!.fields.filter((f) => f.required);
    expect(requiredFields).toHaveLength(3);
    const keys = requiredFields.map((f) => f.key);
    expect(keys).toContain('url');
    expect(keys).toContain('token');
    expect(keys).not.toContain('org');
    expect(keys).toContain('bucket');
  });

  it('ntfy schema has topic as only required field', () => {
    const ntfy = EXPORTER_SCHEMAS.find((s) => s.name === 'ntfy');
    const requiredFields = ntfy!.fields.filter((f) => f.required);
    expect(requiredFields).toHaveLength(1);
    expect(requiredFields[0].key).toBe('topic');
  });

  it('file schema supports both global and per-user', () => {
    const file = EXPORTER_SCHEMAS.find((s) => s.name === 'file');
    expect(file).toBeDefined();
    expect(file!.supportsGlobal).toBe(true);
    expect(file!.supportsPerUser).toBe(true);
  });

  it('file schema has file_path as required field', () => {
    const file = EXPORTER_SCHEMAS.find((s) => s.name === 'file');
    const requiredFields = file!.fields.filter((f) => f.required);
    expect(requiredFields).toHaveLength(1);
    expect(requiredFields[0].key).toBe('file_path');
  });

  it('strava schema supports per-user only', () => {
    const strava = EXPORTER_SCHEMAS.find((s) => s.name === 'strava');
    expect(strava).toBeDefined();
    expect(strava!.supportsGlobal).toBe(false);
    expect(strava!.supportsPerUser).toBe(true);
  });

  it('strava schema has client_id and client_secret as required fields', () => {
    const strava = EXPORTER_SCHEMAS.find((s) => s.name === 'strava');
    const requiredFields = strava!.fields.filter((f) => f.required);
    expect(requiredFields).toHaveLength(2);
    const keys = requiredFields.map((f) => f.key);
    expect(keys).toContain('client_id');
    expect(keys).toContain('client_secret');
  });

  it('telegram schema supports global only', () => {
    const telegram = EXPORTER_SCHEMAS.find((s) => s.name === 'telegram');
    expect(telegram).toBeDefined();
    expect(telegram!.supportsGlobal).toBe(true);
    expect(telegram!.supportsPerUser).toBe(false);
  });

  it('telegram schema has bot_token and chat_id as required fields', () => {
    const telegram = EXPORTER_SCHEMAS.find((s) => s.name === 'telegram');
    const requiredFields = telegram!.fields.filter((f) => f.required);
    expect(requiredFields).toHaveLength(2);
    const keys = requiredFields.map((f) => f.key);
    expect(keys).toContain('bot_token');
    expect(keys).toContain('chat_id');
  });

  it('intervals schema supports per-user only', () => {
    const intervals = EXPORTER_SCHEMAS.find((s) => s.name === 'intervals');
    expect(intervals).toBeDefined();
    expect(intervals!.supportsGlobal).toBe(false);
    expect(intervals!.supportsPerUser).toBe(true);
  });

  it('intervals schema has athlete_id and api_key as required fields', () => {
    const intervals = EXPORTER_SCHEMAS.find((s) => s.name === 'intervals');
    const requiredFields = intervals!.fields.filter((f) => f.required);
    expect(requiredFields).toHaveLength(2);
    const keys = requiredFields.map((f) => f.key);
    expect(keys).toContain('athlete_id');
    expect(keys).toContain('api_key');
  });

  it('runalyze schema supports per-user only', () => {
    const runalyze = EXPORTER_SCHEMAS.find((s) => s.name === 'runalyze');
    expect(runalyze).toBeDefined();
    expect(runalyze!.supportsGlobal).toBe(false);
    expect(runalyze!.supportsPerUser).toBe(true);
  });

  it('runalyze schema has token as the only required field', () => {
    const runalyze = EXPORTER_SCHEMAS.find((s) => s.name === 'runalyze');
    const requiredFields = runalyze!.fields.filter((f) => f.required);
    expect(requiredFields).toHaveLength(1);
    expect(requiredFields.map((f) => f.key)).toContain('token');
  });

  it('wger schema supports per-user only', () => {
    const wger = EXPORTER_SCHEMAS.find((s) => s.name === 'wger');
    expect(wger).toBeDefined();
    expect(wger!.supportsGlobal).toBe(false);
    expect(wger!.supportsPerUser).toBe(true);
  });

  it('wger schema has base_url and token as required fields', () => {
    const wger = EXPORTER_SCHEMAS.find((s) => s.name === 'wger');
    const requiredFields = wger!.fields.filter((f) => f.required);
    expect(requiredFields.map((f) => f.key).sort()).toEqual(['base_url', 'token']);
  });
});

// ─── KNOWN_EXPORTER_NAMES ──────────────────────────────────────────────────

describe('KNOWN_EXPORTER_NAMES', () => {
  it('is a Set with 11 entries', () => {
    expect(KNOWN_EXPORTER_NAMES).toBeInstanceOf(Set);
    expect(KNOWN_EXPORTER_NAMES.size).toBe(11);
  });

  it('contains all exporter names', () => {
    expect(KNOWN_EXPORTER_NAMES.has('garmin')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('mqtt')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('webhook')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('influxdb')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('ntfy')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('file')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('strava')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('telegram')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('intervals')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('runalyze')).toBe(true);
    expect(KNOWN_EXPORTER_NAMES.has('wger')).toBe(true);
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

  it('maps report_exports onto the notification exporters', () => {
    expect(createExporterFromEntry({ type: 'ntfy', topic: 't' }).reportsExports).toBe(false);
    expect(
      createExporterFromEntry({ type: 'ntfy', topic: 't', report_exports: true }).reportsExports,
    ).toBe(true);
    expect(
      createExporterFromEntry({
        type: 'telegram',
        bot_token: '1:a',
        chat_id: '2',
        report_exports: true,
      }).reportsExports,
    ).toBe(true);
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

  it('throws a clear error when a required field is missing', () => {
    const entry: ExporterEntry = { type: 'telegram', chat_id: '987654321' };
    expect(() => createExporterFromEntry(entry)).toThrow(
      'Exporter "telegram" is missing required field "bot_token"',
    );
  });

  it('throws a clear error for an intervals entry missing api_key', () => {
    const entry: ExporterEntry = { type: 'intervals', athlete_id: 'i123456' };
    expect(() => createExporterFromEntry(entry)).toThrow(
      'Exporter "intervals" is missing required field "api_key"',
    );
  });

  it('rejects an empty-string required field', () => {
    const entry: ExporterEntry = { type: 'webhook', url: '' };
    expect(() => createExporterFromEntry(entry)).toThrow(
      'Exporter "webhook" is missing required field "url"',
    );
  });

  it('does not require runtime-optional garmin fields', () => {
    // garmin email/password are wizard-required but optional at runtime
    // (cached tokens), so a bare garmin entry must still construct.
    expect(() => createExporterFromEntry({ type: 'garmin' })).not.toThrow();
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

  it('creates FileExporter from entry', () => {
    const entry: ExporterEntry = {
      type: 'file',
      file_path: '/tmp/measurements.csv',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(FileExporter);
    expect(exporter.name).toBe('file');
  });

  it('creates FileExporter with jsonl format', () => {
    const entry: ExporterEntry = {
      type: 'file',
      file_path: '/tmp/data.jsonl',
      format: 'jsonl',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(FileExporter);
  });

  it('creates StravaExporter from entry', () => {
    const entry: ExporterEntry = {
      type: 'strava',
      client_id: '12345',
      client_secret: 'secret',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(StravaExporter);
    expect(exporter.name).toBe('strava');
  });

  it('creates StravaExporter with custom token_dir', () => {
    const entry: ExporterEntry = {
      type: 'strava',
      client_id: '12345',
      client_secret: 'secret',
      token_dir: './custom-tokens',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(StravaExporter);
  });

  it('creates TelegramExporter from entry', () => {
    const entry: ExporterEntry = {
      type: 'telegram',
      bot_token: '123456:ABC-DEF',
      chat_id: '987654321',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(TelegramExporter);
    expect(exporter.name).toBe('telegram');
  });

  it('coerces a numeric telegram chat_id to a string', () => {
    const entry: ExporterEntry = {
      type: 'telegram',
      bot_token: '123456:ABC-DEF',
      chat_id: 987654321,
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(TelegramExporter);
  });

  it('creates IntervalsExporter from entry', () => {
    const entry: ExporterEntry = {
      type: 'intervals',
      athlete_id: 'i123456',
      api_key: 'abcdef123',
    };
    const exporter = createExporterFromEntry(entry);
    expect(exporter).toBeInstanceOf(IntervalsExporter);
    expect(exporter.name).toBe('intervals');
  });
});
