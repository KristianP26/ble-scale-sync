import { createLogger } from './logger.js';
import { errMsg } from './utils/error.js';
import type { Exporter, ExportContext, ExportResultDetail } from './interfaces/exporter.js';
import type { BodyComposition } from './interfaces/scale-adapter.js';
import { cliCommand } from './cli-invocation.js';

const log = createLogger('Sync');

/** One exporter of a dispatch and what came of it. */
export interface ExportAttempt {
  exporter: Exporter;
  detail: ExportResultDetail;
}

export interface DispatchOptions {
  /**
   * Aborted when the app shuts down. A dispatch is not cancelled by it: the
   * exports run to their end or until the hard-exit floor ends the process.
   * What the signal buys is a log line naming the reading and every export
   * still running at that moment, because those are the ones the shutdown may
   * cut off, and at-most-once (D014) means they are not queued either (E-10).
   */
  signal?: AbortSignal;
  /** How the shutdown line names the reading, e.g. "82.40 kg for Dad measured at ...". */
  label?: string;
}

export interface DispatchResult {
  success: boolean;
  details: ExportResultDetail[];
  /**
   * Every attempted exporter paired with its outcome, in the order of
   * `details`. The retry queue needs the INSTANCE, not the name: one list can
   * hold two entries of the same type (two webhooks, D029), and the name alone
   * cannot say which of them failed.
   */
  attempts: ExportAttempt[];
  /** Count of exporters skipped because the reading was historical and they do not back-date. */
  skipped?: number;
}

/**
 * Run healthchecks on all exporters that support them.
 * Results are logged as warnings (non-fatal).
 */
export async function runHealthchecks(exporters: Exporter[]): Promise<void> {
  const withHealthcheck = exporters.filter(
    (e): e is Exporter & { healthcheck: NonNullable<Exporter['healthcheck']> } =>
      typeof e.healthcheck === 'function',
  );

  if (withHealthcheck.length === 0) return;

  log.info('Running exporter healthchecks...');
  const results = await Promise.allSettled(withHealthcheck.map((e) => e.healthcheck()));

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const name = withHealthcheck[i].name;
    if (result.status === 'fulfilled' && result.value.success) {
      log.info(`  ${name}: OK`);
    } else if (result.status === 'fulfilled') {
      log.warn(`  ${name}: ${result.value.error}`);
    } else {
      log.warn(`  ${name}: ${errMsg(result.reason)}`);
    }
  }
}

/**
 * Dispatch body composition data to all exporters in parallel.
 * Returns true if at least one exporter succeeded, false if all failed.
 * When context is provided, it is forwarded to each exporter for multi-user support.
 */
export async function dispatchExports(
  exporters: Exporter[],
  payload: BodyComposition,
  context?: ExportContext,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  // The flag, not the presence of a timestamp: live readings carry their
  // measurement time too (D027), and reading that as "historical" would stop
  // every live MQTT, webhook and notification export.
  const isHistorical = context?.historical === true;
  const eligible = isHistorical ? exporters.filter((e) => e.supportsBackdate === true) : exporters;
  const skipped = isHistorical ? exporters.filter((e) => e.supportsBackdate !== true) : [];

  if (skipped.length > 0) {
    log.info(
      `Historical reading (${context?.timestamp?.toISOString() ?? 'time unknown'}): ` +
        `skipping non-back-date exporters [${skipped.map((e) => e.name).join(', ')}]`,
    );
  }

  const attempts: ExportAttempt[] = [];
  const buildResult = (success: boolean, details: ExportResultDetail[]): DispatchResult => {
    const result: DispatchResult = { success, details, attempts };
    if (skipped.length > 0) result.skipped = skipped.length;
    return result;
  };

  if (eligible.length === 0) {
    if (isHistorical && skipped.length > 0) {
      return buildResult(true, []);
    }
    log.warn('No exporters configured, measurement processed but not sent anywhere.');
    log.warn(
      `  Run \`${cliCommand('setup')}\` and pick at least one export target, or edit config.yaml.`,
    );
    return buildResult(true, []);
  }

  log.info(`Exporting to: ${eligible.map((e) => e.name).join(', ')}...`);

  // Exporters that report on the others wait for the first wave and get its outcome.
  const reporters = eligible.filter((e) => e.reportsExports === true);
  const watch = watchShutdown(opts);
  try {
    attempts.push(
      ...(await runExports(
        eligible.filter((e) => e.reportsExports !== true),
        payload,
        context,
        watch.pending,
      )),
    );
  } finally {
    if (reporters.length === 0) watch.stop();
  }
  const details = attempts.map((a) => a.detail);
  // A reporter is a notification about the other exports, not a delivered
  // export of its own. When anything else was configured, only those results
  // decide success, so a sent "all failed" notification cannot turn a total
  // failure into a success (which would advance the dedup anchor and
  // last_known_weight and let a single run exit 0).
  const decisive = details.length;
  if (reporters.length > 0) {
    try {
      const second = await runExports(
        reporters,
        payload,
        { ...context, exportResults: [...details] },
        watch.pending,
      );
      attempts.push(...second);
      details.push(...second.map((a) => a.detail));
    } finally {
      watch.stop();
    }
  }

  const allFailed = (decisive > 0 ? details.slice(0, decisive) : details).every((d) => !d.ok);
  if (allFailed) {
    log.error('All exports failed.');
    return buildResult(false, details);
  }

  log.info('Done.');
  return buildResult(true, details);
}

/**
 * Log, at the moment the app is told to stop, which exports of this dispatch
 * have not finished (E-10).
 *
 * The owner chose at-most-once for a shutdown during an export (D014): the
 * reading is not queued before the dispatch, so an export the hard-exit floor
 * cuts off is lost. Silently losing it is the part this fixes. The line names
 * the reading and exactly the exports still running, which is all the operator
 * needs to re-enter a weigh-in by hand.
 */
function watchShutdown(opts: DispatchOptions): { pending: Set<Exporter>; stop: () => void } {
  const pending = new Set<Exporter>();
  const signal = opts.signal;
  if (!signal) return { pending, stop: () => {} };
  const report = (): void => {
    if (pending.size === 0) return;
    log.warn(
      `Shutdown requested while exporting ${opts.label ?? 'a reading'}: ` +
        `[${[...pending].map((e) => e.name).join(', ')}] had not finished. If the process exits before ` +
        'they do, this reading is lost for them; it is not queued for retry (at-most-once).',
    );
  };
  if (signal.aborted) {
    // Already stopping when the dispatch began: report once the set is filled.
    queueMicrotask(report);
    return { pending, stop: () => {} };
  }
  signal.addEventListener('abort', report, { once: true });
  return { pending, stop: () => signal.removeEventListener('abort', report) };
}

async function runExports(
  exporters: Exporter[],
  payload: BodyComposition,
  context: ExportContext | undefined,
  pending: Set<Exporter>,
): Promise<ExportAttempt[]> {
  const results = await Promise.allSettled(
    exporters.map(async (e) => {
      // Instances, not names: two webhooks in one list share a name.
      pending.add(e);
      try {
        return await (context ? e.export(payload, context) : e.export(payload));
      } finally {
        pending.delete(e);
      }
    }),
  );

  const attempts: ExportAttempt[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const exporter = exporters[i];
    const name = exporter.name;
    // Rejection first, then the outcome. The previous shape tested
    // `status === 'fulfilled' && value.success` and handled the failure in an
    // `else if`, where TypeScript still could not tell WHICH half of that
    // conjunction had failed - so `value.error` was `string | undefined` and a
    // detail could be pushed as failed with no reason at all.
    if (result.status === 'rejected') {
      const msg = errMsg(result.reason);
      log.error(`${name}: ${msg}`);
      attempts.push({ exporter, detail: { name, ok: false, error: msg } });
      continue;
    }
    const value = result.value;
    if (value.success) {
      attempts.push({ exporter, detail: { name, ok: true } });
    } else {
      log.error(`${name}: ${value.error}`);
      attempts.push({ exporter, detail: { name, ok: false, error: value.error } });
    }
  }
  return attempts;
}
