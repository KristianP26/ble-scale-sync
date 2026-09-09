import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { Exporter } from '../interfaces/exporter.js';
import type { ExporterEntry } from '../config/schema.js';
import type {
  MqttConfig,
  WebhookConfig,
  InfluxDbConfig,
  NtfyConfig,
  FileConfig,
  StravaConfig,
  TelegramConfig,
  IntervalsConfig,
  RunalyzeConfig,
  WgerConfig,
} from './config.js';
import {
  garminSchema,
  GarminExporter,
  GARMIN_UPLOAD_TIMEOUT_MIN_SEC,
  GARMIN_UPLOAD_TIMEOUT_MAX_SEC,
} from './garmin.js';
import { mqttSchema, MqttExporter } from './mqtt.js';
import { webhookSchema, WebhookExporter } from './webhook.js';
import { influxdbSchema, InfluxDbExporter } from './influxdb.js';
import { ntfySchema, NtfyExporter } from './ntfy.js';
import { fileSchema, FileExporter } from './file.js';
import { stravaSchema, StravaExporter } from './strava.js';
import { telegramSchema, TelegramExporter } from './telegram.js';
import { intervalsSchema, IntervalsExporter } from './intervals.js';
import { runalyzeSchema, RunalyzeExporter } from './runalyze.js';
import { wgerSchema, WgerExporter } from './wger.js';

// --- Registry entry type ---

interface ExporterRegistryEntry {
  schema: ExporterSchema;
  factory: (config: Record<string, unknown>) => Exporter;
}

const TRUE_STRINGS = new Set(['true', 'yes', '1', 'on']);
const FALSE_STRINGS = new Set(['false', 'no', '0', 'off', '']);

/**
 * Read an optional boolean field that must not be guessed at.
 *
 * `ExporterEntrySchema` is `.passthrough()`, so YAML hands the factory whatever
 * the user typed, and `${ENV_VAR}` references resolve to STRINGS before the
 * schema ever sees them (`resolveEnvReferences`). A bare `as boolean` cast plus
 * a truthiness test therefore reads `weight_only: "false"` as true — the exact
 * inverse of what was written, silently. Accept the boolean, accept the usual
 * string spellings, and throw on anything else rather than pick a side.
 */
function optionalBool(
  config: Record<string, unknown>,
  type: string,
  key: string,
): boolean | undefined {
  const value = config[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (TRUE_STRINGS.has(lower)) return true;
    if (FALSE_STRINGS.has(lower)) return false;
  }
  throw new Error(
    `Exporter "${type}" field "${key}" must be true or false, got '${String(value)}'. Check your config.yaml.`,
  );
}

/**
 * Read an optional numeric field, with the same reasoning as `optionalBool`.
 *
 * YAML hands the factory whatever the user typed and `${ENV_VAR}` references
 * resolve to STRINGS before the schema sees them, so `as number` produces a
 * string that looks like a number until something downstream refuses it. For
 * Garmin's timeout that something is `spawn`, which throws on a non-integer
 * `timeout` and takes the export with it. Bounds are checked here too, since
 * a 1-second cap and a 10-hour one are both accepted by the type.
 */
function optionalNumber(
  config: Record<string, unknown>,
  type: string,
  key: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  const value = config[key];
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num)) {
    throw new Error(
      `Exporter "${type}" field "${key}" must be a number, got '${String(value)}'. Check your config.yaml.`,
    );
  }
  if (opts.integer && !Number.isInteger(num)) {
    throw new Error(
      `Exporter "${type}" field "${key}" must be a whole number, got ${num}. Check your config.yaml.`,
    );
  }
  if ((opts.min !== undefined && num < opts.min) || (opts.max !== undefined && num > opts.max)) {
    throw new Error(
      `Exporter "${type}" field "${key}" must be between ${opts.min} and ${opts.max}, got ${num}. Check your config.yaml.`,
    );
  }
  return num;
}

// Every boolean an exporter reads goes through the helper above. The cast it
// replaced was not specific to one field: `retain: "${MQTT_RETAIN}"` with
// MQTT_RETAIN=false retained, and wger's sync_measurements had the same hole.

/**
 * Read a required config field, throwing a clear error when it is missing or
 * empty. Surfaces hand-written `config.yaml` mistakes instead of letting an
 * `undefined` propagate into a confusing downstream failure.
 */
function requireField(config: Record<string, unknown>, type: string, key: string): string {
  const value = config[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `Exporter "${type}" is missing required field "${key}". Check your config.yaml.`,
    );
  }
  return String(value);
}

// --- Registry ---

export const EXPORTER_REGISTRY: ExporterRegistryEntry[] = [
  {
    schema: garminSchema,
    factory: (config) =>
      new GarminExporter({
        email: config.email as string | undefined,
        password: config.password as string | undefined,
        token_dir: config.token_dir as string | undefined,
        weight_only: optionalBool(config, 'garmin', 'weight_only'),
        upload_timeout_sec: optionalNumber(config, 'garmin', 'upload_timeout_sec', {
          min: GARMIN_UPLOAD_TIMEOUT_MIN_SEC,
          max: GARMIN_UPLOAD_TIMEOUT_MAX_SEC,
          // spawn() throws ERR_OUT_OF_RANGE on a fractional timeout, from
          // inside the promise executor, so 10.0005 would fail three attempts
          // with an error about milliseconds nobody typed.
          integer: true,
        }),
      }),
  },
  {
    schema: mqttSchema,
    factory: (config) => {
      const mqttConfig: MqttConfig = {
        brokerUrl: requireField(config, 'mqtt', 'broker_url'),
        topic: (config.topic as string) ?? 'scale/body-composition',
        qos: (config.qos as 0 | 1 | 2) ?? 1,
        retain: optionalBool(config, 'mqtt', 'retain') ?? true,
        username: config.username as string | undefined,
        password: config.password as string | undefined,
        clientId: (config.client_id as string) ?? 'ble-scale-sync',
        haDiscovery: optionalBool(config, 'mqtt', 'ha_discovery') ?? true,
        haDeviceName: (config.ha_device_name as string) ?? 'BLE Scale',
      };
      return new MqttExporter(mqttConfig);
    },
  },
  {
    schema: webhookSchema,
    factory: (config) => {
      const webhookConfig: WebhookConfig = {
        url: requireField(config, 'webhook', 'url'),
        method: (config.method as string) ?? 'POST',
        headers: (config.headers as Record<string, string>) ?? {},
        // Same trap as the booleans: `timeout: "${WEBHOOK_TIMEOUT}"` reached
        // AbortSignal.timeout() as a string. Deliberately unbounded: this field
        // has accepted any number since it existed, and narrowing it here would
        // turn somebody's working `timeout: 50` into a crash at startup.
        timeout: optionalNumber(config, 'webhook', 'timeout') ?? 10_000,
      };
      return new WebhookExporter(webhookConfig);
    },
  },
  {
    schema: influxdbSchema,
    factory: (config) => {
      const influxConfig: InfluxDbConfig = {
        url: requireField(config, 'influxdb', 'url'),
        token: requireField(config, 'influxdb', 'token'),
        org: (config.org as string | undefined) || undefined,
        bucket: requireField(config, 'influxdb', 'bucket'),
        measurement: (config.measurement as string) ?? 'body_composition',
      };
      return new InfluxDbExporter(influxConfig);
    },
  },
  {
    schema: ntfySchema,
    factory: (config) => {
      const ntfyConfig: NtfyConfig = {
        url: (config.url as string) ?? 'https://ntfy.sh',
        topic: requireField(config, 'ntfy', 'topic'),
        title: (config.title as string) ?? 'Scale Measurement',
        priority: (config.priority as number) ?? 3,
        token: config.token as string | undefined,
        username: config.username as string | undefined,
        password: config.password as string | undefined,
        reportExports: optionalBool(config, 'ntfy', 'report_exports') ?? false,
      };
      return new NtfyExporter(ntfyConfig);
    },
  },
  {
    schema: fileSchema,
    factory: (config) => {
      const fileConfig: FileConfig = {
        filePath: requireField(config, 'file', 'file_path'),
        format: (config.format as 'csv' | 'jsonl') ?? 'csv',
      };
      return new FileExporter(fileConfig);
    },
  },
  {
    schema: stravaSchema,
    factory: (config) => {
      const stravaConfig: StravaConfig = {
        clientId: requireField(config, 'strava', 'client_id'),
        clientSecret: requireField(config, 'strava', 'client_secret'),
        tokenDir: (config.token_dir as string) ?? './strava-tokens',
      };
      return new StravaExporter(stravaConfig);
    },
  },
  {
    schema: telegramSchema,
    factory: (config) => {
      const telegramConfig: TelegramConfig = {
        botToken: requireField(config, 'telegram', 'bot_token'),
        chatId: requireField(config, 'telegram', 'chat_id'),
        title: (config.title as string) ?? 'Scale Measurement',
        silent: optionalBool(config, 'telegram', 'silent') ?? false,
        reportExports: optionalBool(config, 'telegram', 'report_exports') ?? false,
      };
      return new TelegramExporter(telegramConfig);
    },
  },
  {
    schema: intervalsSchema,
    factory: (config) => {
      const intervalsConfig: IntervalsConfig = {
        athleteId: requireField(config, 'intervals', 'athlete_id'),
        apiKey: requireField(config, 'intervals', 'api_key'),
      };
      return new IntervalsExporter(intervalsConfig);
    },
  },
  {
    schema: runalyzeSchema,
    factory: (config) => {
      const runalyzeConfig: RunalyzeConfig = {
        token: requireField(config, 'runalyze', 'token'),
      };
      return new RunalyzeExporter(runalyzeConfig);
    },
  },
  {
    schema: wgerSchema,
    factory: (config) => {
      const wgerConfig: WgerConfig = {
        baseUrl: requireField(config, 'wger', 'base_url'),
        token: requireField(config, 'wger', 'token'),
        syncMeasurements: optionalBool(config, 'wger', 'sync_measurements') ?? true,
      };
      return new WgerExporter(wgerConfig);
    },
  },
];

// --- Derived exports ---

export const EXPORTER_SCHEMAS: ExporterSchema[] = EXPORTER_REGISTRY.map((e) => e.schema);

export const KNOWN_EXPORTER_NAMES = new Set(EXPORTER_REGISTRY.map((e) => e.schema.name));

// --- Factory ---

/**
 * Create an exporter instance from a config.yaml exporter entry.
 * The entry must have a `type` field matching a registered exporter name.
 */
export function createExporterFromEntry(entry: ExporterEntry): Exporter {
  const registryEntry = EXPORTER_REGISTRY.find((e) => e.schema.name === entry.type);
  if (!registryEntry) {
    throw new Error(
      `Unknown exporter type '${entry.type}'. Known exporters: ${[...KNOWN_EXPORTER_NAMES].join(', ')}`,
    );
  }
  const { type: _, ...config } = entry;
  return registryEntry.factory(config);
}
