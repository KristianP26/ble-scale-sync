import { config as dotenvConfig } from 'dotenv';
import type { AppConfig, ExporterEntry } from './schema.js';
import { defaultEnvPath } from './paths.js';
import { parseBleAdapterEnv } from './env-overrides.js';
import { loadConfig as loadEnvVarConfig } from '../validate-env.js';
import { loadExporterConfig } from '../exporters/config.js';

/**
 * Load config from .env, wrapping existing loadConfig() + loadExporterConfig()
 * into the unified AppConfig shape.
 */
export function loadEnvConfig(): AppConfig {
  dotenvConfig({ path: defaultEnvPath() });

  const envConfig = loadEnvVarConfig();
  const exporterConfig = loadExporterConfig();

  // Build exporter entries from env-var config
  const globalExporters: ExporterEntry[] = exporterConfig.exporters.map((name) => {
    const entry: Record<string, unknown> = { type: name };

    if (name === 'garmin' && exporterConfig.garmin) {
      Object.assign(entry, {
        weight_only: exporterConfig.garmin.weightOnly,
      });
    }
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
        report_exports: n.reportExports,
      });
    }
    if (name === 'telegram' && exporterConfig.telegram) {
      const t = exporterConfig.telegram;
      Object.assign(entry, {
        bot_token: t.botToken,
        chat_id: t.chatId,
        title: t.title,
        silent: t.silent,
        report_exports: t.reportExports,
      });
    }
    if (name === 'intervals' && exporterConfig.intervals) {
      const i = exporterConfig.intervals;
      Object.assign(entry, {
        athlete_id: i.athleteId,
        api_key: i.apiKey,
      });
    }
    if (name === 'runalyze' && exporterConfig.runalyze) {
      Object.assign(entry, {
        token: exporterConfig.runalyze.token,
      });
    }
    if (name === 'wger' && exporterConfig.wger) {
      const w = exporterConfig.wger;
      Object.assign(entry, {
        base_url: w.baseUrl,
        token: w.token,
        sync_measurements: w.syncMeasurements,
      });
    }

    return entry as ExporterEntry;
  });

  // Use the actual birth date from env vars (already loaded by dotenvConfig above)
  const birthDate = process.env.USER_BIRTH_DATE ?? '2000-01-01';

  return {
    version: 1,
    ble: {
      handler: 'auto' as const,
      scale_mac: envConfig.scaleMac ?? null,
      noble_driver: (process.env.NOBLE_DRIVER as 'abandonware' | 'stoprocent') ?? null,
      adapter: parseBleAdapterEnv() ?? null,
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
      watchdog_max_consecutive_failures: 10,
      watch_config: true,
    },
    update_check: true,
  };
}
