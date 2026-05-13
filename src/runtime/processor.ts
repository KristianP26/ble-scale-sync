import type { RawReading } from '../ble/shared.js';
import type { Exporter, ExportContext } from '../interfaces/exporter.js';
import type { BodyComposition, ScaleReading } from '../interfaces/scale-adapter.js';
import type { WeightUnit } from '../config/schema.js';
import type { AppContext } from './context.js';
import {
  publishBeep,
  publishDisplayReading,
  publishDisplayResult,
} from '../ble/handler-mqtt-proxy/index.js';
import { resolveUserProfile } from '../config/resolve.js';
import { matchUserByWeight, detectWeightDrift } from '../config/user-matching.js';
import { updateLastKnownWeight } from '../config/write.js';
import { dispatchExports } from '../orchestrator.js';
import { createLogger } from '../logger.js';
import { checkAndLogUpdate } from '../update-check.js';
import { fmtWeight } from './format.js';

const log = createLogger('Sync');

// Fixed log order for body-composition metrics, independent of the order in
// which the adapter populates the payload. Matches the BodyComposition shape
// minus `weight` and `impedance` (logged separately above).
const BODY_COMP_LOG_KEYS: ReadonlyArray<keyof BodyComposition> = [
  'bmi',
  'bodyFatPercent',
  'waterPercent',
  'boneMass',
  'muscleMass',
  'visceralFat',
  'physiqueRating',
  'bmr',
  'metabolicAge',
];
const KG_METRICS = new Set<keyof BodyComposition>(['boneMass', 'muscleMass']);

/** Tolerance for treating a historical replay weight as a duplicate of last_known_weight. */
const DEDUP_KG_TOLERANCE = 0.1;

function expandReadings(raw: RawReading): ScaleReading[] {
  return raw.history ? [...raw.history, raw.reading] : [raw.reading];
}

function notifyReading(
  ctx: AppContext,
  slug: string,
  name: string,
  weight: number,
  impedance: number | undefined,
  exporterNames: string[],
): void {
  if (ctx.bleHandler !== 'mqtt-proxy' || !ctx.mqttProxy) return;
  publishDisplayReading(ctx.mqttProxy, slug, name, weight, impedance, exporterNames).catch(
    () => {},
  );
}

function notifyResult(
  ctx: AppContext,
  slug: string,
  name: string,
  weight: number,
  details: Array<{ name: string; ok: boolean }>,
): void {
  if (ctx.bleHandler !== 'mqtt-proxy' || !ctx.mqttProxy) return;
  publishDisplayResult(ctx.mqttProxy, slug, name, weight, details).catch(() => {});
}

function notifyBeep(ctx: AppContext, freq: number, duration: number, repeat: number): void {
  if (ctx.bleHandler !== 'mqtt-proxy' || !ctx.mqttProxy) return;
  publishBeep(ctx.mqttProxy, freq, duration, repeat).catch(() => {});
}

function logBodyComp(payload: BodyComposition, weightUnit: WeightUnit, prefix = ''): void {
  const p = prefix ? `${prefix} ` : '';
  log.info(`${p}Body composition:`);
  for (const k of BODY_COMP_LOG_KEYS) {
    const v = payload[k];
    const display = KG_METRICS.has(k) ? fmtWeight(v, weightUnit) : String(v);
    log.info(`${p}  ${k}: ${display}`);
  }
}

export interface ProcessReadingOpts {
  /** Pre-built exporters for single-user mode. Undefined = dry run skip. */
  singleUserExporters?: Exporter[];
  /** Per-user exporter lookup for multi-user mode (cached by AppContext). */
  getExportersForUser?: (slug: string) => Exporter[];
}

/**
 * Unified reading processor. Single-user mode is the degenerate case of
 * multi-user with `users.length === 1`: skips weight-based matching, drift
 * detection, beep cues, and last-known-weight write.
 *
 * Returns true if export succeeded (or was skipped via dry-run / unknown-user
 * strategy), false on dispatch failure.
 */
export async function processReading(
  ctx: AppContext,
  raw: RawReading,
  opts: ProcessReadingOpts = {},
): Promise<boolean> {
  const isMultiUser = ctx.config.users.length > 1;
  if (isMultiUser) {
    return processMultiUser(ctx, raw, opts.getExportersForUser);
  }
  return processSingleUser(ctx, raw, opts.singleUserExporters);
}

async function processSingleUser(
  ctx: AppContext,
  raw: RawReading,
  exporters: Exporter[] | undefined,
): Promise<boolean> {
  const user = ctx.config.users[0];
  const profile = resolveUserProfile(user, ctx.config.scale);
  const all = expandReadings(raw);

  let lastSuccess = true;

  for (let i = 0; i < all.length; i++) {
    const reading = all[i];
    const isLast = i === all.length - 1;
    const payload = raw.adapter.computeMetrics(reading, profile);

    const tag = reading.timestamp ? `[historic ${reading.timestamp.toISOString()}]` : '';
    const tagPrefix = tag ? `${tag} ` : '';
    log.info(
      `\n${tagPrefix}Measurement received: ${fmtWeight(payload.weight, ctx.weightUnit)} / ${payload.impedance} Ohm`,
    );
    logBodyComp(payload, ctx.weightUnit, tag);

    if (isLast) checkAndLogUpdate(ctx.config.update_check);

    if (!exporters) {
      log.info('\nDry run. Skipping export.');
      continue;
    }

    if (isLast) {
      notifyReading(
        ctx,
        user.slug,
        user.name,
        payload.weight,
        payload.impedance,
        exporters.map((e) => e.name),
      );
    }

    const context: ExportContext = {
      userName: user.name,
      userSlug: user.slug,
      userConfig: user,
      ...(reading.timestamp ? { timestamp: reading.timestamp } : {}),
    };

    const { success, details } = await dispatchExports(exporters, payload, context);

    if (isLast) {
      notifyResult(ctx, user.slug, user.name, payload.weight, details);
      lastSuccess = success;
    }
  }

  return lastSuccess;
}

async function processMultiUser(
  ctx: AppContext,
  raw: RawReading,
  getExportersForUser: ((slug: string) => Exporter[]) | undefined,
): Promise<boolean> {
  const all = expandReadings(raw);
  // Match on the LATEST weight. Premise: cache replay belongs to whoever
  // stepped on the scale last; the firmware does not multiplex users.
  const latest = all[all.length - 1];
  const matchWeight = latest.weight;

  log.info(
    `\nRaw reading: ${fmtWeight(matchWeight, ctx.weightUnit)} / ${latest.impedance} Ohm` +
      (all.length > 1 ? ` (+ ${all.length - 1} historical)` : ''),
  );

  const match = matchUserByWeight(ctx.config.users, matchWeight, ctx.config.unknown_user);

  if (!match.user) {
    if (match.warning) log.warn(match.warning);
    notifyBeep(ctx, 600, 150, 3);
    return true;
  }

  const user = match.user;
  const prefix = `[${user.name}]`;
  log.info(`${prefix} Matched (tier: ${match.tier})`);

  notifyBeep(ctx, 1200, 200, 2);

  const exporters = getExportersForUser ? getExportersForUser(user.slug) : [];
  const drift = detectWeightDrift(user, matchWeight);
  if (drift) log.warn(`${prefix} ${drift}`);

  const profile = resolveUserProfile(user, ctx.config.scale);
  const previousLastKnown = user.last_known_weight;

  let lastSuccess = true;
  let latestPayload: BodyComposition | null = null;

  for (let i = 0; i < all.length; i++) {
    const reading = all[i];
    const isLast = i === all.length - 1;
    const tag = reading.timestamp
      ? `${prefix} [historic ${reading.timestamp.toISOString()}]`
      : prefix;

    // Replay dedup: skip historical readings whose weight matches the previously-known
    // weight within tolerance (likely a re-export of an already-synced measurement).
    if (
      reading.timestamp &&
      previousLastKnown !== null &&
      Math.abs(reading.weight - previousLastKnown) < DEDUP_KG_TOLERANCE
    ) {
      log.info(
        `${tag} Skipping replay: weight ${fmtWeight(reading.weight, ctx.weightUnit)} ` +
          `matches last_known_weight within +/-${DEDUP_KG_TOLERANCE} kg`,
      );
      continue;
    }

    const payload = raw.adapter.computeMetrics(reading, profile);

    log.info(
      `${tag} Measurement: ${fmtWeight(payload.weight, ctx.weightUnit)} / ${payload.impedance} Ohm`,
    );
    logBodyComp(payload, ctx.weightUnit, tag);

    if (isLast) checkAndLogUpdate(ctx.config.update_check);

    if (ctx.dryRun) {
      log.info(`${tag} Dry run. Skipping export.`);
      continue;
    }

    if (isLast) latestPayload = payload;

    if (isLast) {
      // Preserve the original behaviour: notifyReading uses RAW reading
      // values (before computeMetrics), notifyResult uses payload values.
      notifyReading(
        ctx,
        user.slug,
        user.name,
        reading.weight,
        reading.impedance,
        exporters.map((e) => e.name),
      );
    }

    const context: ExportContext = {
      userName: user.name,
      userSlug: user.slug,
      userConfig: user,
      ...(drift && isLast ? { driftWarning: drift } : {}),
      ...(reading.timestamp ? { timestamp: reading.timestamp } : {}),
    };

    const { success, details } = await dispatchExports(exporters, payload, context);

    if (isLast) {
      notifyResult(ctx, user.slug, user.name, payload.weight, details);
      lastSuccess = success;
    }
  }

  // Use the RAW latest weight for last_known_weight, matching the original
  // pre-Phase-3 behaviour. latestPayload is only set when a non-dry export
  // happened on the last reading, so dry-run is already excluded.
  if (latestPayload && ctx.configSource === 'yaml' && ctx.configPath) {
    updateLastKnownWeight(ctx.configPath, user.slug, latest.weight, previousLastKnown);
  }

  return lastSuccess;
}
