import type { UserProfile } from '../interfaces/scale-adapter.js';
import type { BleHandlerName } from '../ble/types.js';
import type {
  AppConfig,
  UserConfig,
  ScaleConfig,
  ExporterEntry,
  WeightUnit,
  MqttProxyConfig,
  EsphomeProxyConfig,
  HaBluetoothConfig,
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
 * Bounds a `weight_range` has to sit inside before its midpoint is treated as a
 * hint about a person. The env-var config path has no range to ask for and
 * writes a `0` to `999` sentinel, whose midpoint would be a 499 kg anchor.
 */
const ANCHOR_RANGE_MIN_KG = 20;
const ANCHOR_RANGE_MAX_KG = 250;
const ANCHOR_RANGE_MAX_SPAN_KG = 100;

/**
 * Best estimate of what a configured user weighs, in kg, or undefined when
 * config says nothing useful.
 *
 * `last_known_weight` is the exact answer when it exists: the processor writes
 * it back after every successful reading, so it tracks the person. It is null
 * until the first reading lands, which is precisely the state a scale that gates
 * on the anchor leaves people in (#75), so fall back to the midpoint of the
 * weight range the wizard already requires from every user. A range that spans
 * everything is not a hint about anyone, so it yields nothing rather than a
 * number, and the adapter keeps its own fallback.
 */
function resolveWeightAnchor(user: UserConfig): number | undefined {
  if (user.last_known_weight !== null) return user.last_known_weight;
  const { min, max } = user.weight_range;
  if (min < ANCHOR_RANGE_MIN_KG || max > ANCHOR_RANGE_MAX_KG) return undefined;
  if (max - min > ANCHOR_RANGE_MAX_SPAN_KG) return undefined;
  return (min + max) / 2;
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
    birthDate: user.birth_date,
    lastKnownWeight: resolveWeightAnchor(user),
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
  watchdogMaxFailures: number;
  watchConfig: boolean;
  bleHandler: BleHandlerName;
  bleAdapter?: string;
  mqttProxy?: MqttProxyConfig;
  esphomeProxy?: EsphomeProxyConfig;
  haBluetooth?: HaBluetoothConfig;
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
    watchdogMaxFailures: config.runtime?.watchdog_max_consecutive_failures ?? 10,
    watchConfig: config.runtime?.watch_config ?? true,
    bleHandler: config.ble?.handler ?? 'auto',
    bleAdapter: config.ble?.adapter ?? undefined,
    mqttProxy: config.ble?.mqtt_proxy ?? undefined,
    esphomeProxy: config.ble?.esphome_proxy ?? undefined,
    haBluetooth: config.ble?.ha_bluetooth ?? undefined,
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
