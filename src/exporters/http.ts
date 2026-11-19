import type { ExportResult } from '../interfaces/exporter.js';
import {
  withRetry,
  httpError,
  httpHealthcheck,
  NonRetryableError,
  type RetryOptions,
} from '../utils/retry.js';

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

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/**
 * Statuses a server answers to a POST once it has processed it, pointing the
 * client at a result page (Post/Redirect/Get, a Google Apps Script web app).
 * The request arrived, so the export counts as delivered and the redirect is
 * not followed.
 */
const POST_DONE_STATUSES: ReadonlySet<number> = new Set([302, 303]);
const USE_FINAL = 'Use the final address as the URL.';

/**
 * The failure for a redirect. It names the origin only: the path and query of
 * a Location can carry a webhook id or a token, and the log is shared.
 */
export function redirectNotFollowed(
  status: number,
  location: string | null,
  url: string,
): NonRetryableError {
  let target: URL | null = null;
  try {
    if (location) target = new URL(location, url);
  } catch {
    target = null;
  }
  if (!target || !/^https?:$/.test(target.protocol)) {
    return new NonRetryableError(
      `HTTP ${status}: redirect without a usable Location, not followed. ${USE_FINAL}`,
    );
  }
  if (target.origin === new URL(url).origin) {
    return new NonRetryableError(
      `HTTP ${status}: redirected within ${target.origin}, which is not followed. ${USE_FINAL}`,
    );
  }
  return new NonRetryableError(
    `HTTP ${status}: redirected to ${target.origin}, which is not followed (a redirect can send ` +
      `the request and its headers to another host). ${USE_FINAL}`,
  );
}

/** `redirect` comes after the spread so a caller cannot switch it back. */
function fetchManual(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: 'manual' });
}

/** Tolerates a mocked Response without a body. */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function refuseRedirect(response: Response, url: string): void {
  if (!REDIRECT_STATUSES.has(response.status)) return;
  discardBody(response);
  throw redirectNotFollowed(response.status, response.headers?.get('location') ?? null, url);
}

/**
 * fetch that never follows a redirect: undici would send the request again,
 * custom headers included, and turn a POST into a body-less GET on 301/302/303.
 * A redirect is a failure that a retry cannot change.
 */
export async function fetchNoRedirect(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetchManual(url, init);
  refuseRedirect(response, url);
  return response;
}

/**
 * One export request under `withRetry`. A 302 or 303 to a POST counts as
 * delivered and is not followed; any other redirect fails without a retry.
 * Any other non-2xx status goes through `httpError`, so a 4xx fails fast and
 * 5xx/408/429 are retried (D017).
 */
export function sendWithRetry(
  url: string,
  init: RequestInit,
  opts: SendOptions,
): Promise<ExportResult> {
  return withRetry(async () => {
    const response = await fetchManual(url, {
      ...init,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (init.method?.toUpperCase() === 'POST' && POST_DONE_STATUSES.has(response.status)) {
      discardBody(response);
      opts.log.info(
        `${opts.label}: ${new URL(url).origin} answered HTTP ${response.status}, counted as delivered. The redirect is not followed.`,
      );
      return { success: true };
    }
    refuseRedirect(response, url);
    const settled = opts.onStatus?.(response);
    if (settled) return settled;
    if (!response.ok) throw httpError(response.status);
    await opts.onOk?.(response);
    return { success: true };
  }, opts);
}

/** A healthcheck that is one request with a 5 s timeout. */
export function probe(url: string, init: RequestInit = {}): Promise<ExportResult> {
  return httpHealthcheck(() =>
    fetchNoRedirect(url, { ...init, signal: AbortSignal.timeout(5000) }),
  );
}
