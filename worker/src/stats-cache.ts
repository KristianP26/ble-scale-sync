/**
 * Short-lived cache in front of the two stats endpoints.
 *
 * GET /stats and GET /stats/json each read 30 KV keys (readStats in index.ts).
 * Their `Cache-Control: max-age` only reaches browsers: Cloudflare stores a Worker
 * response only where the Worker puts it into a cache, so a client that ignores
 * the header costs 30 KV reads per request. The free plan allows 100,000 reads a
 * day, shared with GET /version.
 *
 * The Cache API is per data center and does not collapse concurrent requests, so
 * this reduces the reads of ordinary polling and reloads; it is not a cap.
 *
 * Only the Cache API calls the worker makes are typed here, so this module needs
 * no Workers globals and the root test suite can run it against a fake, like
 * version.ts. GET /version is deliberately not cached this way: its handler
 * counts the hit, and a cached answer would skip the count.
 */
export interface ResponseCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** Seconds a stats response is reused. Matches the max-age clients already get. */
export const STATS_CACHE_TTL = 300;

/**
 * Cache key of a stats request: origin and path. The query string is left out on
 * purpose, or `?x=1`, `?x=2` ... would each be a miss and cost 30 KV reads.
 */
export function statsCacheKey(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** Cache-Control for a stats response: browsers and Cloudflare keep it the same time. */
export const STATS_CACHE_CONTROL = `public, max-age=${STATS_CACHE_TTL}, s-maxage=${STATS_CACHE_TTL}`;

/**
 * Serve a stats response from `cache`, or build it and keep it.
 *
 * The cache is best effort, like the stats themselves: a failing match or put
 * costs only the saving, never the answer. A response that is not 2xx is
 * returned but not kept.
 */
export async function cachedStats(
  cache: ResponseCache | undefined,
  key: string,
  waitUntil: (work: Promise<unknown>) => void,
  build: () => Promise<Response>,
): Promise<Response> {
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const served = new Response(hit.body, hit);
        served.headers.set('X-Stats-Cache', 'hit');
        return served;
      }
    } catch {
      // Fall through to a fresh build.
    }
  }

  const fresh = await build();
  if (cache && fresh.ok) {
    waitUntil(cache.put(key, fresh.clone()).catch(() => undefined));
    const served = new Response(fresh.body, fresh);
    served.headers.set('X-Stats-Cache', 'miss');
    return served;
  }
  return fresh;
}
