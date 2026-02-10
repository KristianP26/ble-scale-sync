import { createLogger } from '../logger.js';

const log = createLogger('ExporterConfig');

export type ExporterName = 'garmin' | 'mqtt' | 'webhook' | 'influxdb' | 'ntfy';

const KNOWN_EXPORTERS = new Set<ExporterName>(['garmin', 'mqtt', 'webhook', 'influxdb', 'ntfy']);

export interface MqttConfig {
  brokerUrl: string;
  topic: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  username?: string;
  password?: string;
  clientId: string;
  haDiscovery: boolean;
}

export interface WebhookConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  timeout: number;
}

export interface InfluxDbConfig {
  url: string;
  token: string;
  org: string;
  bucket: string;
  measurement: string;
}

export interface NtfyConfig {
  url: string;
  topic: string;
  title: string;
  priority: number;
  token?: string;
  username?: string;
  password?: string;
}

export interface ExporterConfig {
  exporters: ExporterName[];
  mqtt?: MqttConfig;
  webhook?: WebhookConfig;
  influxdb?: InfluxDbConfig;
  ntfy?: NtfyConfig;
}

function fail(msg: string): never {
  log.error(msg);
  process.exit(1);
}

function parseQos(raw: string | undefined): 0 | 1 | 2 {
  if (!raw) return 1;
  const num = Number(raw);
  if (num === 0 || num === 1 || num === 2) return num;
  fail(`MQTT_QOS must be 0, 1, or 2, got '${raw}'`);
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 1) {
      log.warn(`Ignoring invalid header (missing ':'): '${pair.trim()}'`);
      continue;
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function parsePriority(raw: string | undefined): number {
  if (!raw) return 3;
  const num = Number(raw);
  if (Number.isInteger(num) && num >= 1 && num <= 5) return num;
  fail(`NTFY_PRIORITY must be 1-5, got '${raw}'`);
}

function parseBoolean(key: string, raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) return defaultValue;
  const lower = raw.toLowerCase();
  if (['true', 'yes', '1'].includes(lower)) return true;
  if (['false', 'no', '0'].includes(lower)) return false;
  fail(`${key} must be true/false/yes/no/1/0, got '${raw}'`);
}

export function loadExporterConfig(): ExporterConfig {
  const raw = process.env.EXPORTERS?.trim();
  const names = raw ? raw.split(',').map((s) => s.trim().toLowerCase()) : ['garmin'];

  const exporters: ExporterName[] = [];
  for (const name of names) {
    if (!KNOWN_EXPORTERS.has(name as ExporterName)) {
      fail(`Unknown exporter '${name}'. Valid exporters: ${[...KNOWN_EXPORTERS].join(', ')}`);
    }
    if (!exporters.includes(name as ExporterName)) {
      exporters.push(name as ExporterName);
    }
  }

  if (exporters.length === 0) {
    fail('EXPORTERS must contain at least one exporter.');
  }

  let mqtt: MqttConfig | undefined;
  if (exporters.includes('mqtt')) {
    const brokerUrl = process.env.MQTT_BROKER_URL?.trim();
    if (!brokerUrl) {
      fail('MQTT_BROKER_URL is required when mqtt exporter is enabled.');
    }
    mqtt = {
      brokerUrl,
      topic: process.env.MQTT_TOPIC?.trim() || 'scale/body-composition',
      qos: parseQos(process.env.MQTT_QOS?.trim()),
      retain: parseBoolean('MQTT_RETAIN', process.env.MQTT_RETAIN?.trim(), true),
      username: process.env.MQTT_USERNAME?.trim() || undefined,
      password: process.env.MQTT_PASSWORD?.trim() || undefined,
      clientId: process.env.MQTT_CLIENT_ID?.trim() || 'ble-scale-sync',
      haDiscovery: parseBoolean('MQTT_HA_DISCOVERY', process.env.MQTT_HA_DISCOVERY?.trim(), true),
    };
  }

  let webhook: WebhookConfig | undefined;
  if (exporters.includes('webhook')) {
    const url = process.env.WEBHOOK_URL?.trim();
    if (!url) {
      fail('WEBHOOK_URL is required when webhook exporter is enabled.');
    }
    webhook = {
      url,
      method: process.env.WEBHOOK_METHOD?.trim()?.toUpperCase() || 'POST',
      headers: parseHeaders(process.env.WEBHOOK_HEADERS?.trim()),
      timeout: Number(process.env.WEBHOOK_TIMEOUT?.trim()) || 10_000,
    };
  }

  let influxdb: InfluxDbConfig | undefined;
  if (exporters.includes('influxdb')) {
    const url = process.env.INFLUXDB_URL?.trim();
    if (!url) {
      fail('INFLUXDB_URL is required when influxdb exporter is enabled.');
    }
    const token = process.env.INFLUXDB_TOKEN?.trim();
    if (!token) {
      fail('INFLUXDB_TOKEN is required when influxdb exporter is enabled.');
    }
    const org = process.env.INFLUXDB_ORG?.trim();
    if (!org) {
      fail('INFLUXDB_ORG is required when influxdb exporter is enabled.');
    }
    const bucket = process.env.INFLUXDB_BUCKET?.trim();
    if (!bucket) {
      fail('INFLUXDB_BUCKET is required when influxdb exporter is enabled.');
    }
    influxdb = {
      url,
      token,
      org,
      bucket,
      measurement: process.env.INFLUXDB_MEASUREMENT?.trim() || 'body_composition',
    };
  }

  let ntfy: NtfyConfig | undefined;
  if (exporters.includes('ntfy')) {
    const topic = process.env.NTFY_TOPIC?.trim();
    if (!topic) {
      fail('NTFY_TOPIC is required when ntfy exporter is enabled.');
    }
    ntfy = {
      url: process.env.NTFY_URL?.trim() || 'https://ntfy.sh',
      topic,
      title: process.env.NTFY_TITLE?.trim() || 'Scale Measurement',
      priority: parsePriority(process.env.NTFY_PRIORITY?.trim()),
      token: process.env.NTFY_TOKEN?.trim() || undefined,
      username: process.env.NTFY_USERNAME?.trim() || undefined,
      password: process.env.NTFY_PASSWORD?.trim() || undefined,
    };
  }

  return { exporters, mqtt, webhook, influxdb, ntfy };
}
