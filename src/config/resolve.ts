import type { AdapterRuntimeConfig, ScaleAuth, UserProfile } from '../interfaces/scale-adapter.js';
import type { z } from 'zod';
import type { BleHandlerName } from '../ble/types.js';
import {
  ADAPTER_BLE_OPTIONS,
  RuntimeSchema,
  type AppConfig,
  type UserConfig,
  type ScaleConfig,
  type ScaleDisplayUnit,
  type ExporterEntry,
  type WeightUnit,
  type MqttProxyConfig,
  type EsphomeProxyConfig,
  type HaBluetoothConfig,
} from './schema.js';

import { isOutOfRange, matchUserByWeight } from './user-matching.js';

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
    // Only when off, so every profile of a config without the key is as before.
    ...(user.estimate_body_composition === false && { estimateBodyComposition: false }),
  };
}

/** The Beurer consent material a session hands to the adapter, from `users[0]`. */
export function resolveScaleAuth(user: UserConfig | undefined): ScaleAuth {
  return {
    pin: user?.beurer_pin,
    userIndex: user?.beurer_user_index,
    provision: user?.beurer_provision,
    registerNewUser: user?.beurer_register_new_user,
  };
}

type CamelCase<K extends string> = K extends `${infer H}_${infer T}`
  ? `${H}${Capitalize<CamelCase<T>>}`
  : K;

/**
 * The adapter-owned `ble.*` keys of one fragment as configure() gets them (D076):
 * camelCased, a null or missing key absent.
 */
export type AdapterOptions<S extends Record<string, z.ZodType>> = {
  readonly [K in keyof S & string as CamelCase<K>]?: NonNullable<z.output<S[K]>>;
};

/**
 * What every adapter's configure() gets, at startup and on each reload: the Xiaomi
 * MiBeacon bind key plus the effective scale MAC the S400 nonce needs, the display
 * unit the QN 0x13 command and the AC 27 D0 frame echo (#269), and every
 * adapter-owned ble.* key (ADAPTER_BLE_OPTIONS) under its camelCase name.
 */
export function buildAdapterRuntimeConfig(
  config: AppConfig,
  scaleMac: string | undefined,
): AdapterRuntimeConfig {
  const ble: Record<string, unknown> = config.ble ?? {};
  const options: Record<string, unknown> = {};
  for (const key of Object.keys(ADAPTER_BLE_OPTIONS)) {
    options[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = ble[key] ?? undefined;
  }
  return {
    bindKey: config.ble?.bind_key ?? undefined,
    scaleMac,
    displayUnit: resolveDisplayUnit(config.scale),
    ...options,
    // The config entries themselves, not copies: the processor moves
    // last_known_weight on them in memory after each live weigh-in.
    userWeights: config.users,
  };
}

/**
 * Select the profile authorized for one measured weight.
 *
 * Matching remains centralized in matchUserByWeight; ambiguous range matches
 * cannot authorize a session, even when ordinary matching resolves a tiebreak.
 * Apply the out_of_range policy before resolving demographics.
 */
export function resolveSessionProfile(
  config: AppConfig,
  weightKg: number,
): SessionProfileSelection | null {
  const match = matchUserByWeight(config.users, weightKg, config.unknown_user);
  if (!match.user || match.tier === 'tiebreak') return null;
  if (config.out_of_range === 'skip' && isOutOfRange(match.user, weightKg)) return null;

  return {
    userSlug: match.user.slug,
    profile: resolveUserProfile(match.user, config.scale),
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
  const runtime = { ...RuntimeSchema.parse({}), ...config.runtime };

  return {
    profile,
    scaleMac: config.ble?.scale_mac ?? undefined,
    weightUnit: config.scale.weight_unit,
    dryRun: runtime.dry_run,
    continuousMode: runtime.continuous_mode,
    scanCooldownSec: runtime.scan_cooldown,
    retryFailedExports: runtime.retry_failed_exports,
    watchdogMaxFailures: runtime.watchdog_max_consecutive_failures,
    watchConfig: runtime.watch_config,
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
