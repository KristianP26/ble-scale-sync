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
import { garminSchema, GarminExporter } from './garmin.js';
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
      }),
  },
  {
    schema: mqttSchema,
    factory: (config) => {
      const mqttConfig: MqttConfig = {
        brokerUrl: requireField(config, 'mqtt', 'broker_url'),
        topic: (config.topic as string) ?? 'scale/body-composition',
        qos: (config.qos as 0 | 1 | 2) ?? 1,
        retain: (config.retain as boolean) ?? true,
        username: config.username as string | undefined,
        password: config.password as string | undefined,
        clientId: (config.client_id as string) ?? 'ble-scale-sync',
        haDiscovery: (config.ha_discovery as boolean) ?? true,
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
        timeout: (config.timeout as number) ?? 10_000,
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
        reportExports: (config.report_exports as boolean) ?? false,
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
        silent: (config.silent as boolean) ?? false,
        reportExports: (config.report_exports as boolean) ?? false,
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
        syncMeasurements: (config.sync_measurements as boolean) ?? true,
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
