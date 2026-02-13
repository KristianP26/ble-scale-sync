import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { config as dotenvConfig } from 'dotenv';
import { createLogger } from '../logger.js';
import { AppConfigSchema, formatConfigError } from './schema.js';
import type { AppConfig, BleConfig, ExporterEntry } from './schema.js';
import { KNOWN_EXPORTER_NAMES } from '../exporters/registry.js';
import { loadConfig as loadEnvVarConfig } from '../validate-env.js';
import { loadExporterConfig } from '../exporters/config.js';

const log = createLogger('Config');

const __dirname: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = join(ROOT, 'config.yaml');

export type ConfigSource = 'yaml' | 'env' | 'none';

export interface LoadedConfig {
  source: ConfigSource;
  config: AppConfig;
  configPath?: string;
}

// --- Env reference resolution ---

const ENV_REF_REGEX = /\$\{([^}]+)}/g;

/**
 * Deep-walk a parsed YAML object and replace `${VAR}` references with
 * `process.env[VAR]`. Throws if a referenced variable is not defined.
 */
export function resolveEnvReferences<T>(obj: T): T {
  if (typeof obj === 'string') {
    return obj.replace(ENV_REF_REGEX, (_match, varName: string) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(
          `Environment variable '${varName}' referenced in config.yaml is not defined`,
        );
      }
      return value;
    }) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvReferences(item)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvReferences(value);
    }
    return result as T;
  }
  return obj;
}

// --- Config source detection ---

/**
 * Detect which config source is available.
 */
export function detectConfigSource(configPath?: string): ConfigSource {
  const yamlPath = configPath ?? DEFAULT_CONFIG_PATH;
  if (existsSync(yamlPath)) return 'yaml';

  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) return 'env';

  return 'none';
}

// --- YAML loading ---

function applyEnvOverrides(config: AppConfig): AppConfig {
  const runtime = {
    continuous_mode: config.runtime?.continuous_mode ?? false,
    scan_cooldown: config.runtime?.scan_cooldown ?? 30,
    dry_run: config.runtime?.dry_run ?? false,
    debug: config.runtime?.debug ?? false,
  };
  const ble = { ...config.ble };

  // Runtime overrides
  if (process.env.CONTINUOUS_MODE !== undefined) {
    runtime.continuous_mode = ['true', 'yes', '1'].includes(
      process.env.CONTINUOUS_MODE.toLowerCase(),
    );
  }
  if (process.env.DRY_RUN !== undefined) {
    runtime.dry_run = ['true', 'yes', '1'].includes(process.env.DRY_RUN.toLowerCase());
  }
  if (process.env.DEBUG !== undefined) {
    runtime.debug = ['true', 'yes', '1'].includes(process.env.DEBUG.toLowerCase());
  }
  if (process.env.SCAN_COOLDOWN !== undefined) {
    const num = Number(process.env.SCAN_COOLDOWN);
    if (Number.isFinite(num) && num >= 5 && num <= 3600) {
      runtime.scan_cooldown = num;
    }
  }

  // BLE overrides
  if (process.env.SCALE_MAC !== undefined) {
    ble.scale_mac = process.env.SCALE_MAC;
  }
  if (process.env.NOBLE_DRIVER !== undefined) {
    const driver = process.env.NOBLE_DRIVER.toLowerCase();
    if (driver === 'abandonware' || driver === 'stoprocent') {
      ble.noble_driver = driver;
    }
  }

  return { ...config, runtime, ble };
}

function filterValidExporters(entries: ExporterEntry[] | undefined): ExporterEntry[] | undefined {
  if (!entries) return undefined;
  const valid: ExporterEntry[] = [];
  for (const entry of entries) {
    if ((KNOWN_EXPORTER_NAMES as Set<string>).has(entry.type)) {
      valid.push(entry);
    } else {
      log.warn(`Unknown exporter type '${entry.type}' in config.yaml — skipping`);
    }
  }
  return valid.length > 0 ? valid : undefined;
}

/**
 * Load and validate config from a YAML file.
 */
export function loadYamlConfig(configPath?: string): AppConfig {
  // Load .env so ${VAR} references in config.yaml can resolve secrets from .env
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    dotenvConfig({ path: envPath });
  }

  const yamlPath = configPath ?? DEFAULT_CONFIG_PATH;
  const raw = readFileSync(yamlPath, 'utf8');
  const parsed: unknown = parseYaml(raw);
  const resolved = resolveEnvReferences(parsed);

  const result = AppConfigSchema.safeParse(resolved);
  if (!result.success) {
    const msg = formatConfigError(result.error);
    log.error(msg);
    throw new Error(msg);
  }

  let config = result.data;

  // Lenient exporter validation — warn + skip unknown types
  config = {
    ...config,
    global_exporters: filterValidExporters(config.global_exporters),
    users: config.users.map((u) => ({
      ...u,
      exporters: filterValidExporters(u.exporters),
    })),
  };

  // Set NOBLE_DRIVER env var if configured (needed before BLE handler import)
  if (config.ble?.noble_driver) {
    process.env.NOBLE_DRIVER = config.ble.noble_driver;
  }

  // Set DEBUG env var if configured (needed for logger level)
  if (config.runtime?.debug) {
    process.env.DEBUG = 'true';
  }

  // Apply env overrides
  config = applyEnvOverrides(config);

  return config;
}

// --- Env fallback loading ---

/**
 * Load config from .env, wrapping existing loadConfig() + loadExporterConfig()
 * into the unified AppConfig shape.
 */
export function loadEnvConfig(): AppConfig {
  dotenvConfig({ path: join(ROOT, '.env') });

  const envConfig = loadEnvVarConfig();
  const exporterConfig = loadExporterConfig();

  // Build exporter entries from env-var config
  const globalExporters: ExporterEntry[] = exporterConfig.exporters.map((name) => {
    const entry: Record<string, unknown> = { type: name };

    if (name === 'mqtt' && exporterConfig.mqtt) {
      const m = exporterConfig.mqtt;
      Object.assign(entry, {
        broker_url: m.brokerUrl,
        topic: m.topic,
        qos: m.qos,
        retain: m.retain,
        username: m.username,
        password: m.password,
        client_id: m.clientId,
        ha_discovery: m.haDiscovery,
        ha_device_name: m.haDeviceName,
      });
    }
    if (name === 'webhook' && exporterConfig.webhook) {
      const w = exporterConfig.webhook;
      Object.assign(entry, {
        url: w.url,
        method: w.method,
        headers: w.headers,
        timeout: w.timeout,
      });
    }
    if (name === 'influxdb' && exporterConfig.influxdb) {
      const i = exporterConfig.influxdb;
      Object.assign(entry, {
        url: i.url,
        token: i.token,
        org: i.org,
        bucket: i.bucket,
        measurement: i.measurement,
      });
    }
    if (name === 'ntfy' && exporterConfig.ntfy) {
      const n = exporterConfig.ntfy;
      Object.assign(entry, {
        url: n.url,
        topic: n.topic,
        title: n.title,
        priority: n.priority,
        token: n.token,
        username: n.username,
        password: n.password,
      });
    }

    return entry as ExporterEntry;
  });

  // Use the actual birth date from env vars (already loaded by dotenvConfig above)
  const birthDate = process.env.USER_BIRTH_DATE ?? '2000-01-01';

  return {
    version: 1,
    ble: {
      scale_mac: envConfig.scaleMac ?? null,
      noble_driver: (process.env.NOBLE_DRIVER as 'abandonware' | 'stoprocent') ?? null,
    },
    scale: {
      weight_unit: envConfig.weightUnit,
      height_unit: 'cm', // env-var config already converts to cm
    },
    unknown_user: 'nearest',
    users: [
      {
        name: 'Default',
        slug: 'default',
        height: envConfig.profile.height,
        birth_date: birthDate,
        gender: envConfig.profile.gender,
        is_athlete: envConfig.profile.isAthlete,
        weight_range: { min: 0, max: 999 },
        last_known_weight: null,
      },
    ],
    global_exporters: globalExporters,
    runtime: {
      continuous_mode: envConfig.continuousMode,
      scan_cooldown: envConfig.scanCooldownSec,
      dry_run: envConfig.dryRun,
      debug: process.env.DEBUG === 'true',
    },
  };
}

// --- Unified loader ---

/**
 * Load application config from the best available source.
 * Priority: config.yaml → .env → none (error).
 */
export function loadAppConfig(configPath?: string): LoadedConfig {
  const source = detectConfigSource(configPath);

  switch (source) {
    case 'yaml': {
      const yamlPath = configPath ?? DEFAULT_CONFIG_PATH;
      log.info(`Loading config from ${configPath ?? 'config.yaml'}`);
      return { source: 'yaml', config: loadYamlConfig(configPath), configPath: yamlPath };
    }

    case 'env':
      log.info('Loading config from .env (no config.yaml found)');
      return { source: 'env', config: loadEnvConfig() };

    case 'none':
      log.error('No configuration found.');
      log.error('');
      log.error('Create one of:');
      log.error('  config.yaml  — recommended (run: npm run setup)');
      log.error('  .env         — legacy single-user format (see .env.example)');
      process.exit(1);
  }
}

// --- Lightweight BLE config loader (for scan.ts) ---

export interface BleLoadedConfig {
  scaleMac?: string;
  nobleDriver?: string;
}

/**
 * Load only BLE-related config (scale_mac, noble_driver).
 * Lightweight — doesn't validate full config, doesn't require user profile.
 */
export function loadBleConfig(configPath?: string): BleLoadedConfig {
  const yamlPath = configPath ?? DEFAULT_CONFIG_PATH;

  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf8');
      const parsed = parseYaml(raw) as { ble?: BleConfig };
      const ble = parsed?.ble;
      return {
        scaleMac: ble?.scale_mac ?? undefined,
        nobleDriver: ble?.noble_driver ?? undefined,
      };
    } catch {
      // Fall through to env vars
    }
  }

  // Load .env if it exists
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    dotenvConfig({ path: envPath });
  }

  return {
    scaleMac: process.env.SCALE_MAC || undefined,
    nobleDriver: process.env.NOBLE_DRIVER || undefined,
  };
}
