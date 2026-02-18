import type { UserProfile } from '../interfaces/scale-adapter.js';
import type {
  AppConfig,
  UserConfig,
  ScaleConfig,
  ExporterEntry,
  WeightUnit,
  MqttProxyConfig,
} from './schema.js';

// --- User profile resolution ---

/**
 * Compute age from a birth date string (YYYY-MM-DD).
 */
function computeAge(birthDate: string): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  const today = new Date();
  let age = today.getFullYear() - y;
  const monthDiff = today.getMonth() - (m - 1);
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < d)) {
    age--;
  }
  return age;
}

/**
 * Resolve a UserConfig + ScaleConfig into a UserProfile for body composition calculation.
 */
export function resolveUserProfile(user: UserConfig, scaleConfig: ScaleConfig): UserProfile {
  let height = user.height;
  if (scaleConfig.height_unit === 'in') {
    height = height * 2.54;
  }

  return {
    height,
    age: computeAge(user.birth_date),
    gender: user.gender,
    isAthlete: user.is_athlete,
  };
}

// --- Runtime config resolution ---

export interface ResolvedRuntimeConfig {
  profile: UserProfile;
  scaleMac?: string;
  weightUnit: WeightUnit;
  dryRun: boolean;
  continuousMode: boolean;
  scanCooldownSec: number;
  bleHandler: 'auto' | 'mqtt-proxy';
  mqttProxy?: MqttProxyConfig;
}

/**
 * Resolve runtime config from AppConfig (uses first user as default profile).
 */
export function resolveRuntimeConfig(config: AppConfig): ResolvedRuntimeConfig {
  const user = config.users[0];
  const profile = resolveUserProfile(user, config.scale);

  return {
    profile,
    scaleMac: config.ble?.scale_mac ?? undefined,
    weightUnit: config.scale.weight_unit,
    dryRun: config.runtime?.dry_run ?? false,
    continuousMode: config.runtime?.continuous_mode ?? false,
    scanCooldownSec: config.runtime?.scan_cooldown ?? 30,
    bleHandler: config.ble?.handler ?? 'auto',
    mqttProxy: config.ble?.mqtt_proxy ?? undefined,
  };
}

// --- Exporter resolution ---

/**
 * Merge user-level exporters with global exporters.
 * User exporters come first; global exporters are appended (deduped by type).
 */
export function resolveExportersForUser(config: AppConfig, user: UserConfig): ExporterEntry[] {
  const entries: ExporterEntry[] = [];
  const seenTypes = new Set<string>();

  // User-level exporters first
  if (user.exporters) {
    for (const entry of user.exporters) {
      entries.push(entry);
      seenTypes.add(entry.type);
    }
  }

  // Global exporters (skip if user already has one of the same type)
  if (config.global_exporters) {
    for (const entry of config.global_exporters) {
      if (!seenTypes.has(entry.type)) {
        entries.push(entry);
        seenTypes.add(entry.type);
      }
    }
  }

  return entries;
}

// --- Convenience: single-user resolution ---

export interface ResolvedSingleUser extends ResolvedRuntimeConfig {
  exporterEntries: ExporterEntry[];
}

/**
 * Convenience function for single-user mode.
 * Resolves profile, runtime config, and exporter entries for the first user.
 */
export function resolveForSingleUser(config: AppConfig): ResolvedSingleUser {
  const runtime = resolveRuntimeConfig(config);
  const user = config.users[0];
  const exporterEntries = resolveExportersForUser(config, user);

  return {
    ...runtime,
    exporterEntries,
  };
}
