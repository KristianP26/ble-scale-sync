import type { BleDeviceInfo } from '../interfaces/scale-adapter.js';

/** Name predicates an adapter claims. All tokens MUST be lowercase. */
export interface NameClaim {
  /** Full-name equality (device name === token). */
  exact?: string[];
  /** Substring (device name includes token). */
  includes?: string[];
  /** Prefix (device name starts with token). */
  startsWith?: string[];
}

/**
 * Declarative description of what a scale adapter claims, plus its precedence.
 *
 * `priority` is a unique total order across the registry (higher wins). It
 * replaces array position as the precedence mechanism, so the registry array
 * may be reordered without changing selection.
 *
 * `custom: true` marks adapters whose runtime `matches()` has logic this
 * descriptor cannot fully express (byte signatures, mutual exclusion, instance
 * side effects). The resolver still calls `matches()`; the descriptor is used
 * only for precedence ordering and for the overlap / exclusion analysis in
 * registry-check, where it represents the adapter's claims (a superset of the
 * names it can match).
 */
export interface MatchDescriptor {
  priority: number;
  names?: NameClaim;
  /** Advertised service UUIDs (16-bit short like 'fff0', or full 128-bit). */
  serviceUuids?: string[];
  /** Post-discovery characteristic UUIDs that positively identify the adapter. */
  charUuids?: string[];
  /** Manufacturer company id this adapter claims (a weak signal on its own). */
  manufacturerId?: number;
  custom?: boolean;
}

/**
 * Lowercase and strip dashes from a UUID for comparison.
 *
 * Note for anyone writing a claim: tokens here are 4-char (16-bit) or full
 * 32-char. A 32-bit, 8-char token would NOT work, because this pair does not
 * expand it the way `normalizeUuid` in the BLE layer does (#406).
 */
function norm(u: string): string {
  return u.toLowerCase().replace(/-/g, '');
}

/** The Bluetooth SIG base UUID suffix; a 32-hex UUID using it is a 16-bit UUID. */
const SIG_BASE_SUFFIX = '00001000800000805f9b34fb';

/** Return the 16-bit form ('xxxx') if `n` is a SIG-based 128-bit UUID, else `n`. */
function to16(n: string): string {
  if (n.length === 32 && n.endsWith(SIG_BASE_SUFFIX) && n.startsWith('0000')) {
    return n.slice(4, 8);
  }
  return n;
}

/**
 * True if any claimed UUID equals any device UUID, comparing both raw
 * (dash-stripped, lowercase) and 16-bit-reduced forms so short ('fff0') and
 * full (uuid16(0xfff0)) advertisements match interchangeably.
 */
export function uuidClaimHits(claims: string[], deviceUuids: string[] | undefined): boolean {
  if (!deviceUuids || deviceUuids.length === 0) return false;
  const devSet = new Set<string>();
  for (const d of deviceUuids) {
    const n = norm(d);
    devSet.add(n);
    devSet.add(to16(n));
  }
  return claims.some((c) => {
    const n = norm(c);
    return devSet.has(n) || devSet.has(to16(n));
  });
}

/** Evaluate the common (data-expressible) match predicates. */
export function matchesDescriptor(device: BleDeviceInfo, d: MatchDescriptor): boolean {
  const name = (device.localName || '').toLowerCase();
  if (d.names) {
    if (name && d.names.exact?.includes(name)) return true;
    if (name && d.names.includes?.some((n) => name.includes(n))) return true;
    if (name && d.names.startsWith?.some((p) => name.startsWith(p))) return true;
  }
  if (d.serviceUuids && uuidClaimHits(d.serviceUuids, device.serviceUuids)) return true;
  if (d.charUuids && uuidClaimHits(d.charUuids, device.characteristicUuids)) return true;
  return false;
}

/** Union of every name token a descriptor claims (for exclusion / overlap analysis). */
export function descriptorNameTokens(d: MatchDescriptor): string[] {
  const n = d.names;
  if (!n) return [];
  return [...(n.exact ?? []), ...(n.includes ?? []), ...(n.startsWith ?? [])];
}
