import { createLogger } from './logger.js';
import { errMsg } from './utils/error.js';
import type { Exporter, ExportContext } from './interfaces/exporter.js';
import type { BodyComposition } from './interfaces/scale-adapter.js';

const log = createLogger('Sync');

export interface ExportResultDetail {
  name: string;
  ok: boolean;
  error?: string;
}

export interface DispatchResult {
  success: boolean;
  details: ExportResultDetail[];
  /**
   * Count of exporters skipped because the reading was historical and they
   * do not implement back-dating. Omitted when zero so existing mocks of
   * shape `{ success, details }` keep compiling. Callers read with
   * `result.skipped ?? 0`.
   */
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

  if (eligible.length === 0) {
    if (isHistorical && skipped.length > 0) {
      log.info(
        `Historical reading at ${context!.timestamp!.toISOString()} skipped, ` +
          `no configured exporter supports back-dating.`,
      );
      return { success: true, details: [], skipped: skipped.length };
    }
    log.warn('No exporters configured, measurement processed but not sent anywhere.');
    log.warn('  Run `npm run setup` and pick at least one export target, or edit config.yaml.');
    return { success: true, details: [] };
  }

  log.info(`Exporting to: ${eligible.map((e) => e.name).join(', ')}...`);

  const results = await Promise.allSettled(
    eligible.map((e) => (context ? e.export(payload, context) : e.export(payload))),
  );

  const details: ExportResultDetail[] = [];
  let allFailed = true;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const name = eligible[i].name;
    if (result.status === 'fulfilled' && result.value.success) {
      allFailed = false;
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

  if (allFailed) {
    log.error('All exports failed.');
    return skipped.length > 0
      ? { success: false, details, skipped: skipped.length }
      : { success: false, details };
  }

  log.info('Done.');
  return skipped.length > 0
    ? { success: true, details, skipped: skipped.length }
    : { success: true, details };
}
