/**
 * The one place that turns configured HTTP headers into a header map.
 *
 * The webhook exporter declares `headers` as a STRING field described as
 * "Comma-separated Key: Value pairs", so the wizard writes a string - and the
 * factory cast that string straight to `Record<string, string>`. The exporter
 * then spread it: `{ 'Content-Type': ..., ...'Authorization: Bearer x' }`
 * spreads a string by INDEX, producing `{ 0: 'A', 1: 'u', ... }` and no
 * Authorization header at all. Producer and consumer were this project's own,
 * and disagreed.
 *
 * The env path (`WEBHOOK_HEADERS`) already had a correct parser; this is that
 * rule, shared, so a third implementation cannot drift from the other two.
 */
export interface HeaderParseResult {
  headers: Record<string, string>;
  /** Pairs that carried no ':' and were skipped, for the caller to report. */
  invalid: string[];
}

export function parseHeaderString(raw: string): HeaderParseResult {
  const headers: Record<string, string> = {};
  const invalid: string[] = [];
  for (const pair of raw.split(',')) {
    if (pair.trim() === '') continue;
    const idx = pair.indexOf(':');
    if (idx < 1) {
      invalid.push(pair.trim());
      continue;
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) headers[key] = value;
    else invalid.push(pair.trim());
  }
  return { headers, invalid };
}

/**
 * Normalise whatever `headers` a config carries. A YAML mapping is the natural
 * way to write these by hand and is accepted as-is; the wizard's
 * "Key: Value, Key: Value" string is parsed. Values are stringified, since YAML
 * turns `X-Retry: 3` into a number and fetch wants text.
 */
export function normaliseHeaders(value: unknown): HeaderParseResult {
  if (value === undefined || value === null || value === '') {
    return { headers: {}, invalid: [] };
  }
  if (typeof value === 'string') return parseHeaderString(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    const headers: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw === undefined || raw === null) continue;
      headers[key] = String(raw);
    }
    return { headers, invalid: [] };
  }
  return { headers: {}, invalid: [String(value)] };
}
