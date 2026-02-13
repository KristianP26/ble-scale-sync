import { createLogger } from './logger.js';
import { errMsg } from './utils/error.js';
import type { Exporter, ExportContext } from './interfaces/exporter.js';
import type { BodyComposition } from './interfaces/scale-adapter.js';

const log = createLogger('Sync');

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
): Promise<boolean> {
  log.info(`Exporting to: ${exporters.map((e) => e.name).join(', ')}...`);

  const results = await Promise.allSettled(
    exporters.map((e) => (context ? e.export(payload, context) : e.export(payload))),
  );

  let allFailed = true;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const name = exporters[i].name;
    if (result.status === 'fulfilled' && result.value.success) {
      allFailed = false;
    } else if (result.status === 'fulfilled') {
      log.error(`${name}: ${result.value.error}`);
    } else {
      log.error(`${name}: ${errMsg(result.reason)}`);
    }
  }

  if (allFailed) {
    log.error('All exports failed.');
    return false;
  }

  log.info('Done.');
  return true;
}
