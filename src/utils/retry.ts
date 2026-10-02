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
  /**
   * Delay before the FIRST retry, doubled for each one after it (default
   * 1000 ms). Set 0 in tests that would otherwise wait for it.
   */
  baseDelayMs?: number;
  /** Ceiling for the backoff (default 8000 ms). */
  maxDelayMs?: number;
  /** Injectable sleep, so tests do not have to wait out real time. */
  sleep?: (ms: number) => Promise<void>;
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
 * Base backoff delay, overridable with BLE_RETRY_BASE_DELAY_MS.
 *
 * The env var is read per call rather than once at import, so a test (or an
 * operator) can change it without reloading the module. 0 disables the wait
 * entirely, which is what the test suite uses: three attempts against a mocked
 * fetch have nothing to wait for, and paying the real backoff in every
 * failure-path test would add a minute to the run for no signal.
 */
function defaultBaseDelayMs(): number {
  const raw = process.env.BLE_RETRY_BASE_DELAY_MS;
  if (raw === undefined) return 1_000;
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? num : 1_000;
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
  const baseDelayMs = opts.baseDelayMs ?? defaultBaseDelayMs();
  const maxDelayMs = opts.maxDelayMs ?? 8_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // There was no delay at all, so all three attempts went out in the same
      // millisecond. Against the transient failures this loop exists for -
      // `isRetryableStatus` counts 429 and 5xx among them - that is not a
      // retry, it is the same request three times: the service gets no chance
      // to recover and the whole budget is spent before it could have.
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      if (delay > 0) {
        opts.log.debug(`Waiting ${delay} ms before retrying ${opts.label}...`);
        await sleep(delay);
      }
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
