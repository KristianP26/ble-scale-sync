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
 * An error `withRetry` will not retry — the operation is guaranteed to fail
 * again (e.g. bad credentials, malformed request). Fail fast instead.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** True for HTTP statuses worth retrying: 5xx server errors, 408 timeout, 429 rate-limit. */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Build an error for a failed HTTP response. 4xx client errors (except 408 and
 * 429) are wrapped in {@link NonRetryableError} so `withRetry` fails fast
 * rather than retrying a request that cannot succeed.
 */
export function httpError(status: number, prefix?: string): Error {
  const message = prefix ? `${prefix}: HTTP ${status}` : `HTTP ${status}`;
  return isRetryableStatus(status) ? new Error(message) : new NonRetryableError(message);
}

/**
 * Run one HTTP probe and turn it into an ExportResult.
 *
 * Six exporters held a byte-identical copy of this, differing only in the
 * `fetch(...)` expression, and two of the exporters most likely to hold stale
 * credentials had none at all (#406).
 *
 * The 5 s bound is the caller's: pass `AbortSignal.timeout(...)` in the fetch
 * itself, as the copies did, so an exporter that needs a different one is not
 * fighting the helper.
 */
export async function httpHealthcheck(probe: () => Promise<Response>): Promise<ExportResult> {
  try {
    const response = await probe();
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
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
      if (err instanceof NonRetryableError) {
        return { success: false, error: lastError };
      }
    }
  }

  return { success: false, error: lastError ?? `All ${opts.label} attempts failed` };
}
