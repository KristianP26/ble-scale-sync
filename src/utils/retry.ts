import type { Logger } from '../logger.js';
import type { ExportResult } from '../interfaces/exporter.js';
import { errMsg } from './error.js';

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 2). Total attempts = maxRetries + 1. */
  maxRetries?: number;
  /** Logger instance for retry/error messages. */
  log: Logger;
  /** Label for log messages (e.g. 'upload', 'MQTT publish'). */
  label: string;
}

/**
 * Execute an async function with retries, returning an ExportResult.
 *
 * The `fn` should throw on failure. If it returns an ExportResult with
 * `success: false`, that is also treated as a retriable failure.
 */
export async function withRetry(
  fn: () => Promise<ExportResult>,
  opts: RetryOptions,
): Promise<ExportResult> {
  const maxRetries = opts.maxRetries ?? 2;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      opts.log.info(`Retrying ${opts.label} (${attempt}/${maxRetries})...`);
    }

    try {
      const result = await fn();
      if (result.success) return result;
      lastError = result.error;
      opts.log.error(`${opts.label} failed: ${lastError}`);
    } catch (err) {
      lastError = errMsg(err);
      opts.log.error(`${opts.label} failed: ${lastError}`);
    }
  }

  return { success: false, error: lastError ?? `All ${opts.label} attempts failed` };
}
