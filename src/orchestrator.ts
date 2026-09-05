import { createLogger } from './logger.js';
import { errMsg } from './utils/error.js';
import type { Exporter, ExportContext, ExportResultDetail } from './interfaces/exporter.js';
import type { BodyComposition } from './interfaces/scale-adapter.js';

const log = createLogger('Sync');

export interface DispatchResult {
  success: boolean;
  details: ExportResultDetail[];
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
): Promise<DispatchResult> {
  const isHistorical = context?.timestamp !== undefined;
  const eligible = isHistorical ? exporters.filter((e) => e.supportsBackdate === true) : exporters;
  const skipped = isHistorical ? exporters.filter((e) => e.supportsBackdate !== true) : [];

  if (skipped.length > 0) {
    log.info(
      `Historical reading (${context!.timestamp!.toISOString()}): ` +
        `skipping non-back-date exporters [${skipped.map((e) => e.name).join(', ')}]`,
    );
  }

  const buildResult = (success: boolean, details: ExportResultDetail[]): DispatchResult => {
    const result: DispatchResult = { success, details };
    if (skipped.length > 0) result.skipped = skipped.length;
    return result;
  };

  if (eligible.length === 0) {
    if (isHistorical && skipped.length > 0) {
      return buildResult(true, []);
    }
    log.warn('No exporters configured, measurement processed but not sent anywhere.');
    log.warn('  Run `npm run setup` and pick at least one export target, or edit config.yaml.');
    return buildResult(true, []);
  }

  log.info(`Exporting to: ${eligible.map((e) => e.name).join(', ')}...`);

  // Exporters that report on the others wait for the first wave and get its outcome.
  const reporters = eligible.filter((e) => e.reportsExports === true);
  const details = await runExports(
    eligible.filter((e) => e.reportsExports !== true),
    payload,
    context,
  );
  if (reporters.length > 0) {
    details.push(
      ...(await runExports(reporters, payload, { ...context, exportResults: [...details] })),
    );
  }

  const allFailed = details.every((d) => !d.ok);
  if (allFailed) {
    log.error('All exports failed.');
    return buildResult(false, details);
  }

  log.info('Done.');
  return buildResult(true, details);
}

async function runExports(
  exporters: Exporter[],
  payload: BodyComposition,
  context?: ExportContext,
): Promise<ExportResultDetail[]> {
  const results = await Promise.allSettled(
    exporters.map((e) => (context ? e.export(payload, context) : e.export(payload))),
  );

  const details: ExportResultDetail[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const name = exporters[i].name;
    if (result.status === 'fulfilled' && result.value.success) {
      details.push({ name, ok: true });
    } else if (result.status === 'fulfilled') {
      log.error(`${name}: ${result.value.error}`);
      details.push({ name, ok: false, error: result.value.error });
    } else {
      const msg = errMsg(result.reason);
      log.error(`${name}: ${msg}`);
      details.push({ name, ok: false, error: msg });
    }
  }
  return details;
}
