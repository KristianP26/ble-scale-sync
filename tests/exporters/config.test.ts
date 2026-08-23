import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadExporterConfig } from '../../src/exporters/config.js';

describe('loadExporterConfig()', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('EXPORTERS parsing', () => {
    it('defaults to garmin when EXPORTERS is not set', () => {
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['garmin']);
      expect(cfg.mqtt).toBeUndefined();
    });

    it('parses single exporter', () => {
      vi.stubEnv('EXPORTERS', 'garmin');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['garmin']);
    });

    it('parses multiple exporters', () => {
      vi.stubEnv('EXPORTERS', 'garmin,mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['garmin', 'mqtt']);
    });

    it('trims whitespace around names', () => {
      vi.stubEnv('EXPORTERS', ' garmin , mqtt ');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['garmin', 'mqtt']);
    });

    it('is case-insensitive', () => {
      vi.stubEnv('EXPORTERS', 'GARMIN,MQTT');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['garmin', 'mqtt']);
    });

    it('deduplicates exporters', () => {
      vi.stubEnv('EXPORTERS', 'garmin,garmin');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['garmin']);
    });

    it('rejects unknown exporter names', () => {
      vi.stubEnv('EXPORTERS', 'garmin,foobar');
      expect(() => loadExporterConfig()).toThrow(/Unknown exporter 'foobar'/);
    });

    it('supports mqtt-only', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      const cfg = loadExporterConfig();
      expect(cfg.exporters).toEqual(['mqtt']);
    });
  });

  describe('MQTT config', () => {
    it('requires MQTT_BROKER_URL when mqtt is enabled', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      expect(() => loadExporterConfig()).toThrow(/MQTT_BROKER_URL is required/);
    });

    it('uses defaults for optional MQTT vars', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://broker.local:1883');
      const cfg = loadExporterConfig();
      expect(cfg.mqtt).toEqual({
        brokerUrl: 'mqtt://broker.local:1883',
        topic: 'scale/body-composition',
        qos: 1,
        retain: true,
        username: undefined,
        password: undefined,
        clientId: 'ble-scale-sync',
        haDiscovery: true,
        haDeviceName: 'BLE Scale',
      });
    });

    it('parses all MQTT env vars', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://broker.local:1883');
      vi.stubEnv('MQTT_TOPIC', 'home/scale');
      vi.stubEnv('MQTT_QOS', '2');
      vi.stubEnv('MQTT_RETAIN', 'false');
      vi.stubEnv('MQTT_USERNAME', 'user');
      vi.stubEnv('MQTT_PASSWORD', 'pass');
      vi.stubEnv('MQTT_CLIENT_ID', 'my-scale');
      vi.stubEnv('MQTT_HA_DISCOVERY', 'false');
      const cfg = loadExporterConfig();
      expect(cfg.mqtt).toEqual({
        brokerUrl: 'mqtt://broker.local:1883',
        topic: 'home/scale',
        qos: 2,
        retain: false,
        username: 'user',
        password: 'pass',
        clientId: 'my-scale',
        haDiscovery: false,
        haDeviceName: 'BLE Scale',
      });
    });

    it('rejects invalid MQTT_QOS', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      vi.stubEnv('MQTT_QOS', '5');
      expect(() => loadExporterConfig()).toThrow(/MQTT_QOS must be 0, 1, or 2/);
    });

    it('rejects invalid MQTT_RETAIN', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      vi.stubEnv('MQTT_RETAIN', 'maybe');
      expect(() => loadExporterConfig()).toThrow(/MQTT_RETAIN must be true\/false/);
    });

    it('parses custom MQTT_HA_DEVICE_NAME', () => {
      vi.stubEnv('EXPORTERS', 'mqtt');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://broker.local:1883');
      vi.stubEnv('MQTT_HA_DEVICE_NAME', 'My Custom Scale');
      const cfg = loadExporterConfig();
      expect(cfg.mqtt!.haDeviceName).toBe('My Custom Scale');
    });

    it('does not parse MQTT config when mqtt is not enabled', () => {
      vi.stubEnv('EXPORTERS', 'garmin');
      vi.stubEnv('MQTT_BROKER_URL', 'mqtt://localhost:1883');
      const cfg = loadExporterConfig();
      expect(cfg.mqtt).toBeUndefined();
    });
  });

  describe('Webhook config', () => {
    it('requires WEBHOOK_URL when webhook is enabled', () => {
      vi.stubEnv('EXPORTERS', 'webhook');
      expect(() => loadExporterConfig()).toThrow(/WEBHOOK_URL is required/);
    });

    it('uses defaults for optional webhook vars', () => {
      vi.stubEnv('EXPORTERS', 'webhook');
      vi.stubEnv('WEBHOOK_URL', 'https://example.com/hook');
      const cfg = loadExporterConfig();
      expect(cfg.webhook).toEqual({
        url: 'https://example.com/hook',
        method: 'POST',
        headers: {},
        timeout: 10_000,
      });
    });

    it('parses custom method and timeout', () => {
      vi.stubEnv('EXPORTERS', 'webhook');
      vi.stubEnv('WEBHOOK_URL', 'https://example.com/hook');
      vi.stubEnv('WEBHOOK_METHOD', 'put');
      vi.stubEnv('WEBHOOK_TIMEOUT', '5000');
      const cfg = loadExporterConfig();
      expect(cfg.webhook!.method).toBe('PUT');
      expect(cfg.webhook!.timeout).toBe(5000);
    });

    it('parses valid headers', () => {
      vi.stubEnv('EXPORTERS', 'webhook');
      vi.stubEnv('WEBHOOK_URL', 'https://example.com/hook');
      vi.stubEnv('WEBHOOK_HEADERS', 'X-Api-Key: secret123, Authorization: Bearer tok');
      const cfg = loadExporterConfig();
      expect(cfg.webhook!.headers).toEqual({
        'X-Api-Key': 'secret123',
        Authorization: 'Bearer tok',
      });
    });

    it('parses custom method and headers', () => {
      vi.stubEnv('EXPORTERS', 'webhook');
      vi.stubEnv('WEBHOOK_URL', 'https://example.com/hook');
      vi.stubEnv('WEBHOOK_METHOD', 'PUT');
      vi.stubEnv('WEBHOOK_HEADERS', 'X-Key: val1, Auth: Bearer tok');
      const cfg = loadExporterConfig();
      expect(cfg.webhook!.method).toBe('PUT');
      expect(cfg.webhook!.headers).toEqual({
        'X-Key': 'val1',
        Auth: 'Bearer tok',
      });
    });

    it('handles invalid header entries gracefully', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('EXPORTERS', 'webhook');
      vi.stubEnv('WEBHOOK_URL', 'https://example.com/hook');
      vi.stubEnv('WEBHOOK_HEADERS', 'invalid, X-Good: value');
      const cfg = loadExporterConfig();
      expect(cfg.webhook!.headers).toEqual({ 'X-Good': 'value' });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring invalid header'));
      warnSpy.mockRestore();
    });

    it('skips invalid headers with warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubEnv('EXPORTERS', 'webhook');
      vi.stubEnv('WEBHOOK_URL', 'https://example.com/hook');
      vi.stubEnv('WEBHOOK_HEADERS', 'X-Api-Key: secret, bad-header');
      const cfg = loadExporterConfig();
      expect(cfg.webhook!.headers).toEqual({ 'X-Api-Key': 'secret' });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring invalid header'));
      warnSpy.mockRestore();
    });

    it('does not parse webhook config when webhook is not enabled', () => {
      vi.stubEnv('EXPORTERS', 'garmin');
      vi.stubEnv('WEBHOOK_URL', 'https://example.com/hook');
      const cfg = loadExporterConfig();
      expect(cfg.webhook).toBeUndefined();
    });
  });

  describe('InfluxDB config', () => {
    it('requires INFLUXDB_URL when influxdb is enabled', () => {
      vi.stubEnv('EXPORTERS', 'influxdb');
      expect(() => loadExporterConfig()).toThrow(/INFLUXDB_URL is required/);
    });

    it('requires INFLUXDB_TOKEN when influxdb is enabled', () => {
      vi.stubEnv('EXPORTERS', 'influxdb');
      vi.stubEnv('INFLUXDB_URL', 'http://localhost:8086');
      expect(() => loadExporterConfig()).toThrow(/INFLUXDB_TOKEN is required/);
    });

    it('requires INFLUXDB_ORG when influxdb is enabled', () => {
      vi.stubEnv('EXPORTERS', 'influxdb');
      vi.stubEnv('INFLUXDB_URL', 'http://localhost:8086');
      vi.stubEnv('INFLUXDB_TOKEN', 'my-token');
      expect(() => loadExporterConfig()).toThrow(/INFLUXDB_ORG is required/);
    });

    it('requires INFLUXDB_BUCKET when influxdb is enabled', () => {
      vi.stubEnv('EXPORTERS', 'influxdb');
      vi.stubEnv('INFLUXDB_URL', 'http://localhost:8086');
      vi.stubEnv('INFLUXDB_TOKEN', 'my-token');
      vi.stubEnv('INFLUXDB_ORG', 'my-org');
      expect(() => loadExporterConfig()).toThrow(/INFLUXDB_BUCKET is required/);
    });

    it('uses defaults for optional influxdb vars', () => {
      vi.stubEnv('EXPORTERS', 'influxdb');
      vi.stubEnv('INFLUXDB_URL', 'http://localhost:8086');
      vi.stubEnv('INFLUXDB_TOKEN', 'my-token');
      vi.stubEnv('INFLUXDB_ORG', 'my-org');
      vi.stubEnv('INFLUXDB_BUCKET', 'my-bucket');
      const cfg = loadExporterConfig();
      expect(cfg.influxdb).toEqual({
        url: 'http://localhost:8086',
        token: 'my-token',
        org: 'my-org',
        bucket: 'my-bucket',
        measurement: 'body_composition',
      });
    });

    it('parses custom measurement name', () => {
      vi.stubEnv('EXPORTERS', 'influxdb');
      vi.stubEnv('INFLUXDB_URL', 'http://localhost:8086');
      vi.stubEnv('INFLUXDB_TOKEN', 'my-token');
      vi.stubEnv('INFLUXDB_ORG', 'my-org');
      vi.stubEnv('INFLUXDB_BUCKET', 'my-bucket');
      vi.stubEnv('INFLUXDB_MEASUREMENT', 'scale_data');
      const cfg = loadExporterConfig();
      expect(cfg.influxdb!.measurement).toBe('scale_data');
    });

    it('does not parse influxdb config when influxdb is not enabled', () => {
      vi.stubEnv('EXPORTERS', 'garmin');
      vi.stubEnv('INFLUXDB_URL', 'http://localhost:8086');
      const cfg = loadExporterConfig();
      expect(cfg.influxdb).toBeUndefined();
    });
  });

  describe('Ntfy config', () => {
    it('requires NTFY_TOPIC when ntfy is enabled', () => {
      vi.stubEnv('EXPORTERS', 'ntfy');
      expect(() => loadExporterConfig()).toThrow(/NTFY_TOPIC is required/);
    });

    it('uses defaults for optional ntfy vars', () => {
      vi.stubEnv('EXPORTERS', 'ntfy');
      vi.stubEnv('NTFY_TOPIC', 'my-scale');
      const cfg = loadExporterConfig();
      expect(cfg.ntfy).toEqual({
        url: 'https://ntfy.sh',
        topic: 'my-scale',
        title: 'Scale Measurement',
        priority: 3,
        token: undefined,
        username: undefined,
        password: undefined,
        reportExports: false,
      });
    });

    it('parses all ntfy env vars', () => {
      vi.stubEnv('EXPORTERS', 'ntfy');
      vi.stubEnv('NTFY_URL', 'https://my-ntfy.example.com');
      vi.stubEnv('NTFY_TOPIC', 'health');
      vi.stubEnv('NTFY_TITLE', 'Weight Update');
      vi.stubEnv('NTFY_PRIORITY', '5');
      vi.stubEnv('NTFY_TOKEN', 'tk_abc');
      vi.stubEnv('NTFY_REPORT_EXPORTS', 'true');
      const cfg = loadExporterConfig();
      expect(cfg.ntfy).toEqual({
        url: 'https://my-ntfy.example.com',
        topic: 'health',
        title: 'Weight Update',
        priority: 5,
        token: 'tk_abc',
        username: undefined,
        password: undefined,
        reportExports: true,
      });
    });

    it('rejects invalid NTFY_REPORT_EXPORTS', () => {
      vi.stubEnv('EXPORTERS', 'ntfy');
      vi.stubEnv('NTFY_TOPIC', 'my-scale');
      vi.stubEnv('NTFY_REPORT_EXPORTS', 'maybe');
      expect(() => loadExporterConfig()).toThrow(/NTFY_REPORT_EXPORTS must be true\/false/);
    });

    it('parses custom priority', () => {
      vi.stubEnv('EXPORTERS', 'ntfy');
      vi.stubEnv('NTFY_TOPIC', 'my-scale');
      vi.stubEnv('NTFY_PRIORITY', '5');
      const cfg = loadExporterConfig();
      expect(cfg.ntfy!.priority).toBe(5);
    });

    it('rejects invalid NTFY_PRIORITY', () => {
      vi.stubEnv('EXPORTERS', 'ntfy');
      vi.stubEnv('NTFY_TOPIC', 'my-scale');
      vi.stubEnv('NTFY_PRIORITY', '6');
      expect(() => loadExporterConfig()).toThrow(/NTFY_PRIORITY must be 1-5/);
    });

    it('rejects non-integer priority', () => {
      vi.stubEnv('EXPORTERS', 'ntfy');
      vi.stubEnv('NTFY_TOPIC', 'my-scale');
      vi.stubEnv('NTFY_PRIORITY', '2.5');
      expect(() => loadExporterConfig()).toThrow(/NTFY_PRIORITY must be 1-5/);
    });

    it('rejects non-numeric NTFY_PRIORITY', () => {
      vi.stubEnv('EXPORTERS', 'ntfy');
      vi.stubEnv('NTFY_TOPIC', 'my-scale');
      vi.stubEnv('NTFY_PRIORITY', 'high');
      expect(() => loadExporterConfig()).toThrow(/NTFY_PRIORITY must be 1-5/);
    });

    it('does not parse ntfy config when ntfy is not enabled', () => {
      vi.stubEnv('EXPORTERS', 'garmin');
      vi.stubEnv('NTFY_TOPIC', 'my-scale');
      const cfg = loadExporterConfig();
      expect(cfg.ntfy).toBeUndefined();
    });
  });

  describe('Telegram config', () => {
    it('requires TELEGRAM_BOT_TOKEN when telegram is enabled', () => {
      vi.stubEnv('EXPORTERS', 'telegram');
      expect(() => loadExporterConfig()).toThrow(/TELEGRAM_BOT_TOKEN is required/);
    });

    it('requires TELEGRAM_CHAT_ID when telegram is enabled', () => {
      vi.stubEnv('EXPORTERS', 'telegram');
      vi.stubEnv('TELEGRAM_BOT_TOKEN', '123456:ABC');
      expect(() => loadExporterConfig()).toThrow(/TELEGRAM_CHAT_ID is required/);
    });

    it('uses defaults for optional telegram vars', () => {
      vi.stubEnv('EXPORTERS', 'telegram');
      vi.stubEnv('TELEGRAM_BOT_TOKEN', '123456:ABC');
      vi.stubEnv('TELEGRAM_CHAT_ID', '987654321');
      const cfg = loadExporterConfig();
      expect(cfg.telegram).toEqual({
        botToken: '123456:ABC',
        chatId: '987654321',
        title: 'Scale Measurement',
        silent: false,
        reportExports: false,
      });
    });

    it('parses all telegram env vars', () => {
      vi.stubEnv('EXPORTERS', 'telegram');
      vi.stubEnv('TELEGRAM_BOT_TOKEN', '123456:ABC');
      vi.stubEnv('TELEGRAM_CHAT_ID', '987654321');
      vi.stubEnv('TELEGRAM_TITLE', 'Weight Update');
      vi.stubEnv('TELEGRAM_SILENT', 'true');
      vi.stubEnv('TELEGRAM_REPORT_EXPORTS', 'true');
      const cfg = loadExporterConfig();
      expect(cfg.telegram).toEqual({
        botToken: '123456:ABC',
        chatId: '987654321',
        title: 'Weight Update',
        silent: true,
        reportExports: true,
      });
    });

    it('rejects invalid TELEGRAM_REPORT_EXPORTS', () => {
      vi.stubEnv('EXPORTERS', 'telegram');
      vi.stubEnv('TELEGRAM_BOT_TOKEN', '123456:ABC');
      vi.stubEnv('TELEGRAM_CHAT_ID', '987654321');
      vi.stubEnv('TELEGRAM_REPORT_EXPORTS', 'maybe');
      expect(() => loadExporterConfig()).toThrow(/TELEGRAM_REPORT_EXPORTS must be true\/false/);
    });

    it('rejects invalid TELEGRAM_SILENT', () => {
      vi.stubEnv('EXPORTERS', 'telegram');
      vi.stubEnv('TELEGRAM_BOT_TOKEN', '123456:ABC');
      vi.stubEnv('TELEGRAM_CHAT_ID', '987654321');
      vi.stubEnv('TELEGRAM_SILENT', 'maybe');
      expect(() => loadExporterConfig()).toThrow(/TELEGRAM_SILENT must be true\/false/);
    });

    it('does not parse telegram config when telegram is not enabled', () => {
      vi.stubEnv('EXPORTERS', 'garmin');
      vi.stubEnv('TELEGRAM_BOT_TOKEN', '123456:ABC');
      const cfg = loadExporterConfig();
      expect(cfg.telegram).toBeUndefined();
    });
  });

  describe('Intervals.icu config', () => {
    it('requires INTERVALS_ATHLETE_ID when intervals is enabled', () => {
      vi.stubEnv('EXPORTERS', 'intervals');
      expect(() => loadExporterConfig()).toThrow(/INTERVALS_ATHLETE_ID is required/);
    });

    it('requires INTERVALS_API_KEY when intervals is enabled', () => {
      vi.stubEnv('EXPORTERS', 'intervals');
      vi.stubEnv('INTERVALS_ATHLETE_ID', 'i123456');
      expect(() => loadExporterConfig()).toThrow(/INTERVALS_API_KEY is required/);
    });

    it('parses intervals env vars', () => {
      vi.stubEnv('EXPORTERS', 'intervals');
      vi.stubEnv('INTERVALS_ATHLETE_ID', 'i123456');
      vi.stubEnv('INTERVALS_API_KEY', 'abcdef123');
      const cfg = loadExporterConfig();
      expect(cfg.intervals).toEqual({
        athleteId: 'i123456',
        apiKey: 'abcdef123',
      });
    });

    it('does not parse intervals config when intervals is not enabled', () => {
      vi.stubEnv('EXPORTERS', 'garmin');
      vi.stubEnv('INTERVALS_ATHLETE_ID', 'i123456');
      const cfg = loadExporterConfig();
      expect(cfg.intervals).toBeUndefined();
    });
  });

  describe('Runalyze config', () => {
    it('requires RUNALYZE_TOKEN when runalyze is enabled', () => {
      vi.stubEnv('EXPORTERS', 'runalyze');
      expect(() => loadExporterConfig()).toThrow(/RUNALYZE_TOKEN is required/);
    });

    it('parses runalyze env vars', () => {
      vi.stubEnv('EXPORTERS', 'runalyze');
      vi.stubEnv('RUNALYZE_TOKEN', 'tok-abc123');
      const cfg = loadExporterConfig();
      expect(cfg.runalyze).toEqual({ token: 'tok-abc123' });
    });

    it('does not parse runalyze config when runalyze is not enabled', () => {
      vi.stubEnv('EXPORTERS', 'garmin');
      vi.stubEnv('RUNALYZE_TOKEN', 'tok-abc123');
      const cfg = loadExporterConfig();
      expect(cfg.runalyze).toBeUndefined();
    });
  });

  describe('Wger config', () => {
    it('requires WGER_BASE_URL when wger is enabled', () => {
      vi.stubEnv('EXPORTERS', 'wger');
      vi.stubEnv('WGER_TOKEN', 'tok-1');
      expect(() => loadExporterConfig()).toThrow(/WGER_BASE_URL is required/);
    });

    it('requires WGER_TOKEN when wger is enabled', () => {
      vi.stubEnv('EXPORTERS', 'wger');
      vi.stubEnv('WGER_BASE_URL', 'https://wger.example');
      expect(() => loadExporterConfig()).toThrow(/WGER_TOKEN is required/);
    });

    it('parses wger env vars (sync_measurements defaults true)', () => {
      vi.stubEnv('EXPORTERS', 'wger');
      vi.stubEnv('WGER_BASE_URL', 'https://wger.example');
      vi.stubEnv('WGER_TOKEN', 'tok-1');
      const cfg = loadExporterConfig();
      expect(cfg.wger).toEqual({
        baseUrl: 'https://wger.example',
        token: 'tok-1',
        syncMeasurements: true,
      });
    });

    it('parses WGER_SYNC_MEASUREMENTS=false', () => {
      vi.stubEnv('EXPORTERS', 'wger');
      vi.stubEnv('WGER_BASE_URL', 'https://wger.example');
      vi.stubEnv('WGER_TOKEN', 'tok-1');
      vi.stubEnv('WGER_SYNC_MEASUREMENTS', 'false');
      expect(loadExporterConfig().wger?.syncMeasurements).toBe(false);
    });

    it('does not parse wger config when wger is not enabled', () => {
      vi.stubEnv('EXPORTERS', 'garmin');
      vi.stubEnv('WGER_TOKEN', 'tok-1');
      expect(loadExporterConfig().wger).toBeUndefined();
    });
  });
});
