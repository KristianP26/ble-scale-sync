import type { BleDeviceInfo } from '../interfaces/scale-adapter.js';
import { SVC_FE95, miBeaconProductId, normUuid } from './mibeacon.js';

/**
 * Name predicates an adapter claims. All tokens MUST be lowercase with no
 * leading or trailing whitespace: the device name is compared without its
 * trailing padding, so a token that ends in whitespace never matches.
 */
export interface NameClaim {
  /** Full-name equality (device name without trailing padding === token). */
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
  /**
   * MiBeacon product ids this adapter claims: bytes 2-3, little-endian, of the
   * Xiaomi 0xFE95 service data. Xiaomi assigns them per model (a model may have
   * several), so like a name an id says which device this is, and
   * resolveAfterDiscovery keeps a pick made on it (#474).
   */
  miBeaconProductIds?: number[];
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

/**
 * The advertised name without trailing padding, for matching only.
 *
 * A CH100 was logged as `CH100` plus 15 spaces (20 characters, #503) and fell
 * through to Standard GATT, because every exact name claim compares the whole
 * string. BlueZ keeps the spaces of a UTF-8 name (src/eir.c, profiles/gap/gas.c
 * in 5.82), so the padding of a fixed-width name field can reach us verbatim;
 * that is how the CH100 name arrived. NUL is cut by BlueZ itself, other stacks
 * may pass it on.
 *
 * Strips trailing NUL and whatever `String.prototype.trim()` strips. The start
 * and the inside stay: nothing shows a scale padded on the left, and Medisana
 * reads the raw name for its clock epoch. A name that is padding only comes
 * back unchanged, so adapters see what they saw before this fix. Index loop,
 * not `/\s+$/`: that backtracks quadratically on a long run of spaces in the
 * middle and the name is attacker-controlled input. Returns the same string
 * when nothing was stripped.
 */
export function normalizeLocalName(localName: string): string {
  let end = localName.length;
  while (end > 0) {
    const c = localName[end - 1];
    if (c !== '\0' && c.trim() !== '') break;
    end--;
  }
  return end === 0 || end === localName.length ? localName : localName.slice(0, end);
}

/** True if the device's advertised name hits one of the descriptor's name claims. */
export function nameClaimHits(d: MatchDescriptor, localName: string | undefined): boolean {
  // Resolvers hand over a normalized name already; direct callers may not.
  const name = normalizeLocalName(localName || '').toLowerCase();
  if (!name || !d.names) return false;
  if (d.names.exact?.includes(name)) return true;
  if (d.names.includes?.some((n) => name.includes(n))) return true;
  if (d.names.startsWith?.some((p) => name.startsWith(p))) return true;
  return false;
}

/** True if the device's 0xFE95 service data carries a product id the descriptor claims. */
export function miBeaconClaimHits(d: MatchDescriptor, device: BleDeviceInfo): boolean {
  const ids = d.miBeaconProductIds;
  if (!ids || ids.length === 0) return false;
  return (device.serviceData ?? []).some((sd) => {
    if (normUuid(sd.uuid) !== SVC_FE95) return false;
    const pid = miBeaconProductId(sd.data);
    return pid !== null && ids.includes(pid);
  });
}

/** Evaluate the common (data-expressible) match predicates. */
export function matchesDescriptor(device: BleDeviceInfo, d: MatchDescriptor): boolean {
  if (nameClaimHits(d, device.localName)) return true;
  if (miBeaconClaimHits(d, device)) return true;
  if (d.serviceUuids && uuidClaimHits(d.serviceUuids, device.serviceUuids)) return true;
  if (d.charUuids && uuidClaimHits(d.charUuids, device.characteristicUuids)) return true;
  return false;
}

/**
 * The six bytes of a transport-reported address, uppercase hex without
 * separators, or null when the transport has none (noble on macOS reports
 * `<unknown>`).
 *
 * For adapters whose claim is the device's own address echoed inside its
 * manufacturer data: a device that is not the scale will not happen to carry
 * the address it is transmitting from, so the claim validates itself.
 */
export function ownAddressBytes(address: string | undefined): string | null {
  if (!address) return null;
  const clean = address.replace(/[:-]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(clean) ? clean : null;
}

/** Union of every name token a descriptor claims (for exclusion / overlap analysis). */
export function descriptorNameTokens(d: MatchDescriptor): string[] {
  const n = d.names;
  if (!n) return [];
  return [...(n.exact ?? []), ...(n.includes ?? []), ...(n.startsWith ?? [])];
}
