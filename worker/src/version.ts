/**
 * Latest released version, as served by GET /version.
 *
 * Only the KV calls the worker makes, typed locally, so this module needs no
 * Workers globals and the root test suite can run it against a fake store.
 */
export interface VersionStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/KristianP26/ble-scale-sync/releases/latest';

/** Fresh answer, refreshed from GitHub at most once per TTL. */
export const VERSION_CACHE_KEY = 'latest-version';
export const VERSION_CACHE_TTL = 3600;
/** Last version GitHub confirmed. No TTL: it is the fallback when GitHub is not answering. */
export const LAST_KNOWN_KEY = 'latest-version:last-known';
/** Set after a failed GitHub call, so the next requests do not retry it straight away. */
export const BACKOFF_KEY = 'latest-version:backoff';
export const BACKOFF_TTL = 300; // KV's minimum expirationTtl is 60

export interface LatestVersion {
  /** Null when no version has ever been confirmed; the caller answers 503. */
  version: string | null;
  /** True when this is the cached GitHub answer, false for a fallback. */
  fresh: boolean;
}

async function safeGet(kv: VersionStore, key: string): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

async function safePut(
  kv: VersionStore,
  key: string,
  value: string,
  options?: { expirationTtl?: number },
): Promise<void> {
  try {
    await kv.put(key, value, options);
  } catch {
    // A failed write (1 write/s per key, or the free plan's daily write quota)
    // only costs the cache. It must never cost the answer.
  }
}

async function fetchFromGitHub(fetchFn: FetchLike): Promise<string | null> {
  try {
    const res = await fetchFn(GITHUB_RELEASES_URL, {
      headers: { 'User-Agent': 'ble-scale-sync-api-worker' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: unknown };
    if (typeof data.tag_name !== 'string') return null;
    const version = data.tag_name.replace(/^v/, '');
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Never answers "0.0.0". That used to be the answer whenever the KV write after
 * a successful fetch failed, or GitHub rate-limited the worker's shared egress
 * IP, and every client then compared itself against 0.0.0 and silently stopped
 * announcing updates. Now a known version is always returned, and a failure
 * falls back to the last confirmed one, or to no answer at all.
 */
export async function getLatestVersion(
  kv: VersionStore,
  fetchFn: FetchLike = fetch,
): Promise<LatestVersion> {
  const cached = await safeGet(kv, VERSION_CACHE_KEY);
  if (cached) return { version: cached, fresh: true };

  const lastKnown = await safeGet(kv, LAST_KNOWN_KEY);
  if (await safeGet(kv, BACKOFF_KEY)) return { version: lastKnown, fresh: false };

  const version = await fetchFromGitHub(fetchFn);
  if (version) {
    await safePut(kv, VERSION_CACHE_KEY, version, { expirationTtl: VERSION_CACHE_TTL });
    if (version !== lastKnown) await safePut(kv, LAST_KNOWN_KEY, version);
    return { version, fresh: true };
  }

  await safePut(kv, BACKOFF_KEY, '1', { expirationTtl: BACKOFF_TTL });
  return { version: lastKnown, fresh: false };
}
