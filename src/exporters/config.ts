import { createLogger } from '../logger.js';

const log = createLogger('ExporterConfig');

export type ExporterName =
  | 'garmin'
  | 'mqtt'
  | 'webhook'
  | 'influxdb'
  | 'ntfy'
  | 'file'
  | 'strava'
  | 'telegram'
  | 'intervals'
  | 'runalyze'
  | 'wger'
  | 'google-health';

/**
 * Runtime twin of `ExporterName`, for validating `EXPORTERS=...`.
 *
 * Hand-maintained, like the union above, and `tests/exporters/registry.test.ts`
 * asserts it equals the set derived from the registry. Without that assertion a
 * twelfth exporter added per the documented steps but missed here passes lint,
 * typecheck and the whole suite, then rejects its own name at startup (#406).
 */
const KNOWN_EXPORTERS = new Set<ExporterName>([
  'garmin',
  'mqtt',
  'webhook',
  'influxdb',
  'ntfy',
  'file',
  'strava',
  'telegram',
  'intervals',
  'runalyze',
  'wger',
  'google-health',
]);

/** @internal Exported for the registry-agreement test only. */
export const _knownExporterNamesForTest: ReadonlySet<ExporterName> = KNOWN_EXPORTERS;

export interface GarminConfig {
  /** Upload the weight alone, leaving every derived metric unset in Garmin. */
  weightOnly: boolean;
  /** Seconds one upload attempt may take before it is killed (10-900). */
  uploadTimeoutSec?: number;
}

export interface MqttConfig {
  brokerUrl: string;
  topic: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  username?: string;
  password?: string;
  clientId: string;
  haDiscovery: boolean;
  haDeviceName: string;
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
  /** v2 only. InfluxDB v3 has no organizations and ignores the parameter. */
  org?: string;
  /** Bucket name on v2, database name on v3. */
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
  reportExports: boolean;
}

export interface FileConfig {
  filePath: string;
  format: 'csv' | 'jsonl';
}

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
  tokenDir: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  title: string;
  silent: boolean;
  reportExports: boolean;
}

export interface IntervalsConfig {
  athleteId: string;
  apiKey: string;
}

export interface RunalyzeConfig {
  token: string;
}

export interface WgerConfig {
  baseUrl: string;
  token: string;
  /** Also push body-composition metrics as Wger custom measurements, not just weight. */
  syncMeasurements: boolean;
}

export interface GoogleHealthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;

  /** Upload bodyFatPercent as a DERIVED Google Health data point. */
  writeBodyFat: boolean;

  /** Optional metadata identifying the physical scale. */
  deviceManufacturer?: string;

  /** Optional human-readable scale name. */
  deviceDisplayName?: string;
}

export interface ExporterConfig {
  exporters: ExporterName[];
  garmin?: GarminConfig;
  mqtt?: MqttConfig;
  webhook?: WebhookConfig;
  influxdb?: InfluxDbConfig;
  ntfy?: NtfyConfig;
  file?: FileConfig;
  strava?: StravaConfig;
  telegram?: TelegramConfig;
  intervals?: IntervalsConfig;
  runalyze?: RunalyzeConfig;
  wger?: WgerConfig;
  googleHealth?: GoogleHealthConfig;
}

function fail(msg: string): never {
  throw new Error(msg);
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

function parseUploadTimeout(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const num = Number(raw);
  if (Number.isInteger(num) && num >= 10 && num <= 900) return num;
  fail(`GARMIN_UPLOAD_TIMEOUT_SEC must be a whole number of seconds, 10-900, got '${raw}'`);
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

  let garmin: GarminConfig | undefined;
  if (exporters.includes('garmin')) {
    garmin = {
      weightOnly: parseBoolean('GARMIN_WEIGHT_ONLY', process.env.GARMIN_WEIGHT_ONLY?.trim(), false),
      uploadTimeoutSec: parseUploadTimeout(process.env.GARMIN_UPLOAD_TIMEOUT_SEC?.trim()),
    };
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
      haDeviceName: process.env.MQTT_HA_DEVICE_NAME?.trim() || 'BLE Scale',
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
      reportExports: parseBoolean(
        'NTFY_REPORT_EXPORTS',
        process.env.NTFY_REPORT_EXPORTS?.trim(),
        false,
      ),
    };
  }

  let file: FileConfig | undefined;
  if (exporters.includes('file')) {
    const filePath = process.env.FILE_PATH?.trim();
    if (!filePath) {
      fail('FILE_PATH is required when file exporter is enabled.');
    }
    const rawFormat = process.env.FILE_FORMAT?.trim()?.toLowerCase();
    let format: 'csv' | 'jsonl';
    if (rawFormat === 'jsonl') {
      format = 'jsonl';
    } else if (rawFormat === 'csv' || !rawFormat) {
      format = 'csv';
    } else {
      log.warn(`Invalid FILE_FORMAT "${rawFormat}", falling back to "csv".`);
      format = 'csv';
    }
    file = { filePath, format };
  }

  let strava: StravaConfig | undefined;
  if (exporters.includes('strava')) {
    const clientId = process.env.STRAVA_CLIENT_ID?.trim();
    if (!clientId) {
      fail('STRAVA_CLIENT_ID is required when strava exporter is enabled.');
    }
    const clientSecret = process.env.STRAVA_CLIENT_SECRET?.trim();
    if (!clientSecret) {
      fail('STRAVA_CLIENT_SECRET is required when strava exporter is enabled.');
    }
    strava = {
      clientId,
      clientSecret,
      tokenDir: process.env.STRAVA_TOKEN_DIR?.trim() || './strava-tokens',
    };
  }

  let telegram: TelegramConfig | undefined;
  if (exporters.includes('telegram')) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!botToken) {
      fail('TELEGRAM_BOT_TOKEN is required when telegram exporter is enabled.');
    }
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
    if (!chatId) {
      fail('TELEGRAM_CHAT_ID is required when telegram exporter is enabled.');
    }
    telegram = {
      botToken,
      chatId,
      title: process.env.TELEGRAM_TITLE?.trim() || 'Scale Measurement',
      silent: parseBoolean('TELEGRAM_SILENT', process.env.TELEGRAM_SILENT?.trim(), false),
      reportExports: parseBoolean(
        'TELEGRAM_REPORT_EXPORTS',
        process.env.TELEGRAM_REPORT_EXPORTS?.trim(),
        false,
      ),
    };
  }

  let intervals: IntervalsConfig | undefined;
  if (exporters.includes('intervals')) {
    const athleteId = process.env.INTERVALS_ATHLETE_ID?.trim();
    if (!athleteId) {
      fail('INTERVALS_ATHLETE_ID is required when intervals exporter is enabled.');
    }
    const apiKey = process.env.INTERVALS_API_KEY?.trim();
    if (!apiKey) {
      fail('INTERVALS_API_KEY is required when intervals exporter is enabled.');
    }
    intervals = { athleteId, apiKey };
  }

  let runalyze: RunalyzeConfig | undefined;
  if (exporters.includes('runalyze')) {
    const token = process.env.RUNALYZE_TOKEN?.trim();
    if (!token) {
      fail('RUNALYZE_TOKEN is required when runalyze exporter is enabled.');
    }
    runalyze = { token };
  }

  let wger: WgerConfig | undefined;
  if (exporters.includes('wger')) {
    const baseUrl = process.env.WGER_BASE_URL?.trim();
    if (!baseUrl) {
      fail('WGER_BASE_URL is required when wger exporter is enabled.');
    }

    const token = process.env.WGER_TOKEN?.trim();
    if (!token) {
      fail('WGER_TOKEN is required when wger exporter is enabled.');
    }

    wger = {
      baseUrl,
      token,
      syncMeasurements: parseBoolean(
        'WGER_SYNC_MEASUREMENTS',
        process.env.WGER_SYNC_MEASUREMENTS?.trim(),
        true,
      ),
    };
  }

  let googleHealth: GoogleHealthConfig | undefined;
  if (exporters.includes('google-health')) {
    const clientId = process.env.GOOGLE_HEALTH_CLIENT_ID?.trim();
    if (!clientId) {
      fail('GOOGLE_HEALTH_CLIENT_ID is required when google-health exporter is enabled.');
    }

    const clientSecret = process.env.GOOGLE_HEALTH_CLIENT_SECRET?.trim();
    if (!clientSecret) {
      fail('GOOGLE_HEALTH_CLIENT_SECRET is required when google-health exporter is enabled.');
    }

    const refreshToken = process.env.GOOGLE_HEALTH_REFRESH_TOKEN?.trim();
    if (!refreshToken) {
      fail('GOOGLE_HEALTH_REFRESH_TOKEN is required when google-health exporter is enabled.');
    }

    googleHealth = {
      clientId,
      clientSecret,
      refreshToken,
      writeBodyFat: parseBoolean(
        'GOOGLE_HEALTH_WRITE_BODY_FAT',
        process.env.GOOGLE_HEALTH_WRITE_BODY_FAT?.trim(),
        true,
      ),
      deviceManufacturer: process.env.GOOGLE_HEALTH_DEVICE_MANUFACTURER?.trim() || undefined,
      deviceDisplayName: process.env.GOOGLE_HEALTH_DEVICE_DISPLAY_NAME?.trim() || undefined,
    };
  }

  return {
    exporters,
    garmin,
    mqtt,
    webhook,
    influxdb,
    ntfy,
    file,
    strava,
    telegram,
    intervals,
    runalyze,
    wger,
    googleHealth,
  };
}
