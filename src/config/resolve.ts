import type { UserProfile } from '../interfaces/scale-adapter.js';
import type { BleHandlerName } from '../ble/types.js';
import type {
  AppConfig,
  UserConfig,
  ScaleConfig,
  ScaleDisplayUnit,
  ExporterEntry,
  WeightUnit,
  MqttProxyConfig,
  EsphomeProxyConfig,
  HaBluetoothConfig,
} from './schema.js';

// --- Scale display unit ---

/**
 * The unit to ask the scale's own display to show. `display_unit: weight_unit`
 * (the default) follows `weight_unit`, which is what kept a QN scale set to lb
 * on lb before display_unit existed (#269, #429).
 */
export function resolveDisplayUnit(scale: ScaleConfig): ScaleDisplayUnit {
  return scale.display_unit === 'weight_unit' ? scale.weight_unit : scale.display_unit;
}

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
  retryFailedExports: boolean;
  watchdogMaxFailures: number;
  watchConfig: boolean;
  bleHandler: BleHandlerName;
  bleAdapter?: string;
  /** `ble.adapter_privacy` (#417). */
  adapterPrivacy: boolean;
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
    retryFailedExports: config.runtime?.retry_failed_exports ?? true,
    watchdogMaxFailures: config.runtime?.watchdog_max_consecutive_failures ?? 10,
    watchConfig: config.runtime?.watch_config ?? true,
    bleHandler: config.ble?.handler ?? 'auto',
    bleAdapter: config.ble?.adapter ?? undefined,
    adapterPrivacy: config.ble?.adapter_privacy === true,
    mqttProxy: config.ble?.mqtt_proxy ?? undefined,
    esphomeProxy: config.ble?.esphome_proxy ?? undefined,
    haBluetooth: config.ble?.ha_bluetooth ?? undefined,
  };
}

// --- Exporter resolution ---

/**
 * Where one resolved exporter entry came from: which list, and its position in
 * that list. The retry queue stores this (never the entry itself, which holds
 * credentials, D015), so a failed export of the SECOND webhook is retried
 * through the second webhook and not the first (D029).
 */
export interface ExporterSlot {
  list: 'user' | 'global';
  index: number;
}

export interface ResolvedExporterEntry extends ExporterSlot {
  entry: ExporterEntry;
}

/**
 * The exporters one user's readings go to, with where each came from (D029).
 *
 * Global and per-user lists are MERGED: a global exporter applies to everyone,
 * and a user's own entries are added to it. The one exception is a type the
 * user configured for themselves: then only the user's entries of that type
 * apply to them, so a personal Garmin replaces the household one rather than
 * uploading the weigh-in twice into two accounts.
 *
 * Several entries of one type in one list are all kept and all exported to
 * (two webhooks, two InfluxDB buckets). An earlier version kept only the first
 * global entry of a type and silently dropped the rest (G-14).
 */
export function resolveExporterSlotsForUser(
  config: AppConfig,
  user: UserConfig,
): ResolvedExporterEntry[] {
  const resolved: ResolvedExporterEntry[] = [];
  const ownTypes = new Set<string>();

  (user.exporters ?? []).forEach((entry, index) => {
    resolved.push({ entry, list: 'user', index });
    ownTypes.add(entry.type);
  });

  (config.global_exporters ?? []).forEach((entry, index) => {
    if (!ownTypes.has(entry.type)) resolved.push({ entry, list: 'global', index });
  });

  return resolved;
}

/**
 * Merge user-level exporters with global exporters (D029): user entries first,
 * then every global entry whose type the user does not configure themselves.
 */
export function resolveExportersForUser(config: AppConfig, user: UserConfig): ExporterEntry[] {
  return resolveExporterSlotsForUser(config, user).map((r) => r.entry);
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
