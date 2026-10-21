import type { ExportResult } from '../interfaces/exporter.js';
import { withRetry, httpError, httpHealthcheck, type RetryOptions } from '../utils/retry.js';

export interface SendOptions extends RetryOptions {
  /** Per-attempt timeout (default 10 s). */
  timeoutMs?: number;
  /**
   * Sees the response before the 2xx check, for a status the service gives a
   * meaning of its own: return a result or throw to settle the attempt.
   */
  onStatus?: (response: Response) => ExportResult | void;
  /** Runs on a 2xx response; throw to fail the attempt. */
  onOk?: (response: Response) => void | Promise<void>;
}

/**
 * One export request under `withRetry`. Any other non-2xx status goes through
 * `httpError`, so a 4xx fails fast and 5xx/408/429 are retried (D017).
 */
export function sendWithRetry(
  url: string,
  init: RequestInit,
  opts: SendOptions,
): Promise<ExportResult> {
  return withRetry(async () => {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const settled = opts.onStatus?.(response);
    if (settled) return settled;
    if (!response.ok) throw httpError(response.status);
    await opts.onOk?.(response);
    return { success: true };
  }, opts);
}

/** A healthcheck that is one request with a 5 s timeout. */
export function probe(url: string, init: RequestInit = {}): Promise<ExportResult> {
  return httpHealthcheck(() => fetch(url, { ...init, signal: AbortSignal.timeout(5000) }));
}
