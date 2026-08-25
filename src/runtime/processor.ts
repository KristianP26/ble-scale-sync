import type { RawReading } from '../ble/shared.js';
import type { Exporter, ExportContext } from '../interfaces/exporter.js';
import type { BodyComposition, ScaleReading } from '../interfaces/scale-adapter.js';
import type { WeightUnit, UserConfig } from '../config/schema.js';
import type { AppContext } from './context.js';
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

/** Returns `[historic <ISO>]` when the reading is from a cache replay, else ''. */
function historicTag(timestamp: Date | undefined): string {
  return timestamp ? `[historic ${timestamp.toISOString()}]` : '';
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

/** Per-frame policy that distinguishes the two user-count modes. */
interface FramePolicy {
  /** Log prefix: '' for single-user, '[Name]' for multi-user. */
  prefix: string;
  /** Drift warning attached to the last reading's ExportContext (multi only). */
  drift?: string;
  /**
   * Replay-dedup anchor: multi-user passes `last_known_weight` (config); single-
   * user passes its runtime last-exported weight. `null` disables dedup.
   */
  dedupAnchor: number | null;
}

/** Combine the user prefix and the historic tag into the per-frame log tag. */
function frameTag(prefix: string, timestamp: Date | undefined): string {
  const ht = historicTag(timestamp);
  if (prefix && ht) return `${prefix} ${ht}`;
  return prefix || ht;
}

/**
 * Shared expand -> compute -> log -> display -> dispatch core for one matched
 * user. Both single- and multi-user modes run this; they differ only in the
 * policy (prefix, drift, dedup anchor) and the surrounding side effects (weight
 * matching, beeps, last_known_weight write). Callers must have already fired
 * `checkAndLogUpdate` for the cycle.
 *
 * Returns the success of the last (live) dispatch and the payload of that
 * dispatch (`null` if every frame was deduped or skipped via dry-run), which the
 * caller uses to gate the dedup-anchor / last_known_weight write.
 */
async function processReadingFrames(
  ctx: AppContext,
  user: UserConfig,
  raw: RawReading,
  all: ScaleReading[],
  exporters: Exporter[] | undefined,
  policy: FramePolicy,
): Promise<{ lastSuccess: boolean; latestPayload: BodyComposition | null }> {
  const profile = resolveUserProfile(user, ctx.config.scale);
  // Dry-run signal is unified: ctx.dryRun OR (single-user) undefined exporters.
  // An empty exporter array is NOT a skip — it dispatches to nothing and reports
  // success, matching the prior multi-user behaviour.
  const skipExport = ctx.dryRun || exporters === undefined;

  let lastSuccess = true;
  let latestPayload: BodyComposition | null = null;

  for (let i = 0; i < all.length; i++) {
    const reading = all[i];
    const isLast = i === all.length - 1;
    const tag = frameTag(policy.prefix, reading.timestamp);
    const tagPrefix = tag ? `${tag} ` : '';

    // Replay dedup: skip a historical frame whose weight matches the anchor
    // within tolerance (likely a re-export of an already-synced measurement).
    if (
      reading.timestamp &&
      policy.dedupAnchor !== null &&
      Math.abs(reading.weight - policy.dedupAnchor) < DEDUP_KG_TOLERANCE
    ) {
      log.info(
        `${tagPrefix}Skipping replay: weight ${fmtWeight(reading.weight, ctx.weightUnit)} ` +
          `matches the last exported weight within +/-${DEDUP_KG_TOLERANCE} kg`,
      );
      continue;
    }

    const payload = raw.adapter.computeMetrics(reading, profile);

    log.info(
      `\n${tagPrefix}Measurement: ${fmtWeight(payload.weight, ctx.weightUnit)} / ${payload.impedance} Ohm`,
    );
    logBodyComp(payload, ctx.weightUnit, tag);

    if (skipExport) {
      log.info(`${tagPrefix}Dry run. Skipping export.`);
      continue;
    }

    if (isLast) latestPayload = payload;

    if (isLast) {
      // notifyReading uses raw scale values (pre-computeMetrics) so the display
      // mirrors what the scale measured; notifyResult uses the computed payload.
      ctx.display?.reading(
        user.slug,
        user.name,
        reading.weight,
        reading.impedance,
        exporters!.map((e) => e.name),
      );
    }

    const context: ExportContext = {
      userName: user.name,
      userSlug: user.slug,
      userConfig: user,
      weightUnit: ctx.weightUnit,
      ...(policy.drift && isLast ? { driftWarning: policy.drift } : {}),
      ...(reading.timestamp ? { timestamp: reading.timestamp } : {}),
    };

    const { success, details } = await dispatchExports(exporters!, payload, context);

    if (isLast) {
      ctx.display?.result(user.slug, user.name, payload.weight, details);
      lastSuccess = success;
    }
  }

  return { lastSuccess, latestPayload };
}

async function processSingleUser(
  ctx: AppContext,
  raw: RawReading,
  exporters: Exporter[] | undefined,
): Promise<boolean> {
  const user = ctx.config.users[0];
  const all = expandReadings(raw);

  checkAndLogUpdate(ctx.config.update_check);

  // Single-user replay dedup uses a RUNTIME anchor (not config): the last weight
  // we actually exported this process. Null on the first reading (no dedup),
  // then set below, so a later reconnect's cache replay dedups against it. This
  // makes #164 replay dedup uniform with multi-user within a process lifetime.
  const anchor = ctx.lastExportedWeights.get(user.slug) ?? null;

  const { lastSuccess, latestPayload } = await processReadingFrames(
    ctx,
    user,
    raw,
    all,
    exporters,
    {
      prefix: '',
      dedupAnchor: anchor,
    },
  );

  if (latestPayload) {
    ctx.lastExportedWeights.set(user.slug, all[all.length - 1].weight);
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
    ctx.display?.beep(600, 150, 3);
    return true;
  }

  const user = match.user;
  const prefix = `[${user.name}]`;
  log.info(`${prefix} Matched (tier: ${match.tier})`);

  // Update check fires once per matched cycle, independent of replay dedup.
  // Placing it inside the loop on `isLast` would skip the check whenever the
  // newest reading happens to be deduped.
  checkAndLogUpdate(ctx.config.update_check);

  ctx.display?.beep(1200, 200, 2);

  const exporters = getExportersForUser ? getExportersForUser(user.slug) : [];
  const drift = detectWeightDrift(user, matchWeight);
  if (drift) log.warn(`${prefix} ${drift}`);

  const previousLastKnown = user.last_known_weight;

  const { lastSuccess, latestPayload } = await processReadingFrames(
    ctx,
    user,
    raw,
    all,
    exporters,
    {
      prefix,
      drift: drift ?? undefined,
      dedupAnchor: previousLastKnown,
    },
  );

  // last_known_weight stores the raw scale value, not the computed payload.
  // latestPayload is set only after a non-dry export on the last reading,
  // so dry-run is already excluded here.
  if (latestPayload && ctx.configSource === 'yaml' && ctx.configPath) {
    updateLastKnownWeight(ctx.configPath, user.slug, latest.weight, previousLastKnown);
  }

  return lastSuccess;
}
