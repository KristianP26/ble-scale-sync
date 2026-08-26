import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  LiveWeight,
} from '../interfaces/scale-adapter.js';
import { hasParseableBroadcastSource, type RawReading } from './shared.js';
import { bleLog, normalizeUuid, BT_BASE_UUID_SUFFIX } from './types.js';
import { isDebugEnabled } from '../logger.js';

// ─── Advertisement decision (pure) ─────────────────────────────────────────────

/**
 * The per-advertisement decision, derived purely from `(adapter, info)`. Every
 * BLE transport handler (noble, mqtt-proxy, esphome-proxy) shares this decision
 * tree; only the sink differs (emit vs queue vs resolve), so that stays at the
 * call site. See #242.
 */
export type AdvertisementDecision =
  /** A usable, stable reading — emit it now. */
  | { kind: 'complete'; reading: ScaleReading }
  /** A weight-only frame from a passive adapter — start/refresh a grace timer. */
  | { kind: 'partial'; reading: ScaleReading }
  /** No usable reading yet, but the device still carries a parseable broadcast
   *  source — keep waiting for a future advertisement. `live` carries what the
   *  scale is DISPLAYING while you wait, when the adapter decodes it (#356). It
   *  is not a reading and must never be treated as one. */
  | { kind: 'wait'; live?: LiveWeight }
  /** No broadcast reading and the adapter has a GATT path — connect via GATT. */
  | { kind: 'gatt' }
  /** Matched, but the device exposes neither a parseable broadcast source nor a
   *  GATT characteristic — nothing to do. */
  | { kind: 'none' };

export interface EvaluateOptions {
  /**
   * Default true. When false, a null reading never returns `wait` even if a
   * parseable broadcast source is present — it falls straight through to `gatt`
   * or `none`. The esphome-proxy watcher sets this false: it GATT-connects such
   * devices on demand from its per-advertisement stream (QN Elis 1). See the
   * `hasParseableBroadcastSource` doc comment in shared.ts.
   */
  waitForBroadcast?: boolean;
}

/** Try the adapter's broadcast parsers against an advertisement's data. */
function parseAdvertisement(adapter: ScaleAdapter, info: BleDeviceInfo): ScaleReading | null {
  let reading: ScaleReading | null = null;

  if (adapter.parseBroadcast && info.manufacturerData) {
    reading = adapter.parseBroadcast(info.manufacturerData.data);
  }

  if (!reading && adapter.parseServiceData && info.serviceData) {
    for (const sd of info.serviceData) {
      reading = adapter.parseServiceData(sd.uuid, sd.data);
      if (reading) break;
    }
  }

  return reading;
}

/**
 * Classify a single advertisement for a matched adapter. Pure: no side effects,
 * no timers, no I/O. Reproduces the parse-then-classify branch that was
 * copy-pasted across all five handler sites (#242).
 *
 * Passive-preferring adapters (e.g. Mi Scale 2) emit a weight-only frame first
 * and a weight+impedance frame moments later, so they gate on `isComplete`
 * (`partial` until then). Other broadcast adapters embed a "final" flag in the
 * frame itself, so any non-null reading is already `complete`.
 */
export function evaluateAdvertisement(
  adapter: ScaleAdapter,
  info: BleDeviceInfo,
  opts?: EvaluateOptions,
): AdvertisementDecision {
  const reading = parseAdvertisement(adapter, info);
  const requiresStable = adapter.preferPassive === true;

  if (reading && (!requiresStable || adapter.isComplete(reading))) {
    return { kind: 'complete', reading };
  }
  if (reading && requiresStable) {
    return { kind: 'partial', reading };
  }
  if (opts?.waitForBroadcast !== false && hasParseableBroadcastSource(adapter, info)) {
    // Only ever consulted once parseAdvertisement has declined the frame, which
    // is what keeps one advertisement from being reported through both channels
    // (#356).
    const live =
      adapter.parseLiveBroadcast && info.manufacturerData
        ? (adapter.parseLiveBroadcast(info.manufacturerData.data) ?? undefined)
        : undefined;
    return live ? { kind: 'wait', live } : { kind: 'wait' };
  }
  if (!adapter.charNotifyUuid) {
    return { kind: 'none' };
  }
  return { kind: 'gatt' };
}

// ─── Grace timers (per-address, weight-only fallback) ──────────────────────────

/**
 * Owns the `graceTimers` / `graceReadings` Map pair that was declared verbatim
 * in the mqtt-proxy watcher, esphome-proxy scan and esphome-proxy watcher, and
 * (single-key) the noble broadcastScan (#242).
 *
 * When a passive adapter emits a weight-only frame, `hold` records it and arms a
 * single timer for that address. If an impedance-bearing frame arrives first the
 * caller cancels it; otherwise the timer fires `onElapsed` with the weight-only
 * reading after `graceMs` so a complete-less reading is still forwarded.
 */
export class GraceTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly readings = new Map<string, RawReading>();

  constructor(
    private readonly graceMs: number,
    private readonly onElapsed: (address: string, reading: RawReading) => void,
  ) {}

  /**
   * Record (or overwrite) the weight-only reading for an address and arm a grace
   * timer if one is not already running for it. Arming is once-per-address: a
   * later partial frame refreshes the stored reading without resetting the clock,
   * matching every original call site.
   */
  hold(address: string, reading: RawReading): void {
    this.readings.set(address, reading);
    if (this.timers.has(address)) return;
    this.timers.set(
      address,
      setTimeout(() => {
        // Delete the entry BEFORE invoking the callback so an onElapsed that
        // calls clear() (noble) cannot double-clear, and the callback fires
        // exactly once. #242
        this.timers.delete(address);
        const r = this.readings.get(address);
        this.readings.delete(address);
        if (r) this.onElapsed(address, r);
      }, this.graceMs),
    );
  }

  /** Cancel a pending timer for an address (a complete reading arrived). */
  cancel(address: string): void {
    const t = this.timers.get(address);
    if (t) {
      clearTimeout(t);
      this.timers.delete(address);
    }
    this.readings.delete(address);
  }

  /** Clear all pending timers and stored readings (teardown). */
  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.readings.clear();
  }
}

// ─── Dedup window (per address+weight) ─────────────────────────────────────────

/**
 * Owns the `dedup` Map + prune logic duplicated in the mqtt-proxy and
 * esphome-proxy watchers (#242). Suppresses a repeated reading of the same
 * weight from the same address within `windowMs`, so a scale that keeps
 * broadcasting the same frame after a weigh-in is not queued repeatedly.
 *
 * `shouldEmit` is a boolean check the caller wraps in its own control flow (the
 * mqtt watcher must `continue` its batch loop, the esphome watcher returns), and
 * each caller keeps its own log line.
 */
export class DedupWindow {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Return true if this (address, weight) has not been emitted within the
   * window, recording it as emitted. Return false (suppress) otherwise. Old
   * entries are pruned on every call so the map cannot grow without bound.
   */
  shouldEmit(address: string, weight: number): boolean {
    const key = `${address}:${weight.toFixed(1)}`;
    const now = this.now();
    this.prune(now);
    const lastSeen = this.seen.get(key);
    if (lastSeen && now - lastSeen < this.windowMs) return false;
    this.seen.set(key, now);
    return true;
  }

  private prune(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.windowMs) this.seen.delete(key);
    }
  }
}

// ─── Advertisement logging (diagnostics) ───────────────────────────────────────

/** How many UUIDs of one kind are printed before the rest are summarised. */
const UUID_LIST_CAP = 10;
/** How many advertisement bytes of one blob are printed. */
const DATA_BYTE_CAP = 24;

/** Print the 16-bit short form for SIG-base UUIDs, the full form otherwise. */
function shortUuid(uuid: string): string {
  const normalized = normalizeUuid(uuid);
  if (
    normalized.length === 32 &&
    normalized.startsWith('0000') &&
    normalized.endsWith(BT_BASE_UUID_SUFFIX)
  )
    return normalized.slice(4, 8);
  return normalized;
}

function uuidList(uuids: string[]): string {
  const shown = uuids.slice(0, UUID_LIST_CAP).map(shortUuid);
  const rest = uuids.length - shown.length;
  return `[${shown.join(', ')}${rest > 0 ? `, +${rest} more` : ''}]`;
}

function blob(data: Buffer): string {
  const hex = data.subarray(0, DATA_BYTE_CAP).toString('hex');
  return data.length > DATA_BYTE_CAP ? `${hex}… (${data.length}B)` : hex;
}

/**
 * One-line summary of everything an adapter's `matches()` is allowed to see.
 *
 * Adapter mis-routing was the root cause of #317, #318 and #319, and every one
 * of those was reported over a proxy transport. Reproducing the decision from a
 * pasted log needs the exact inputs, so this prints the whole `BleDeviceInfo`
 * rather than a summary of it.
 *
 * The address is passed separately because `BleDeviceInfo` deliberately does not
 * carry one: matching is on advertised content, never on who sent it.
 */
export function formatAdvert(address: string, info: BleDeviceInfo): string {
  // Canonical uppercase form: the transports hand addresses over in different
  // cases, and the same device has to produce the same line for the dedup below
  // to mean anything.
  const parts = [
    `[${address.toUpperCase()}]`,
    `name=${info.localName ? `"${info.localName}"` : '(none)'}`,
  ];
  parts.push(`uuids=${uuidList(info.serviceUuids)}`);
  if (info.manufacturerData) {
    const id = info.manufacturerData.id.toString(16).padStart(4, '0');
    parts.push(`manufacturerData={0x${id}: ${blob(info.manufacturerData.data)}}`);
  }
  if (info.serviceData && info.serviceData.length > 0) {
    const entries = info.serviceData.map((e) => `${shortUuid(e.uuid)}: ${blob(e.data)}`);
    parts.push(`serviceData={${entries.join(', ')}}`);
  }
  if (info.characteristicUuids) parts.push(`chars=${uuidList(info.characteristicUuids)}`);
  return `Advert: ${parts.join(' ')}`;
}

/**
 * Per-address cache of the last advert line printed, so a scan that re-reads the
 * same advertisement several times a second logs it once. A changed
 * fingerprint (a scan response filling in the name, or post-discovery
 * characteristics arriving) prints again, which is the interesting case.
 */
const lastAdvertLine = new Map<string, string>();

/**
 * Cap on remembered addresses. Devices using resolvable private addresses
 * rotate theirs every few minutes, and a watcher runs for weeks, so an
 * unbounded map is a slow leak on the smallest supported host. Oldest entry
 * out, same as the other caches on this path.
 */
const ADVERT_CACHE_MAX = 64;

/**
 * Log an advertisement once per distinct content, on any transport.
 *
 * The node-ble handler has its own richer version built from D-Bus properties
 * (address type and advertising flags, which no other transport exposes); this
 * is the equivalent for the proxy transports, which previously logged nothing a
 * reporter could paste. Both use the same `Advert:` prefix on purpose, so one
 * grep works whatever the transport, and both spell out their fields as
 * `key=value` so a line is self-describing.
 */
export function logAdvert(address: string, info: BleDeviceInfo): void {
  // Checked before the line is built, not after: this runs on every
  // advertisement of every device in range, and formatting one is the whole
  // cost. The node-ble handler guards its sibling line the same way.
  if (!isDebugEnabled()) return;
  const key = address.toLowerCase();
  const line = formatAdvert(address, info);
  if (lastAdvertLine.get(key) === line) return;
  if (!lastAdvertLine.has(key) && lastAdvertLine.size >= ADVERT_CACHE_MAX) {
    const oldest = lastAdvertLine.keys().next().value;
    if (oldest !== undefined) lastAdvertLine.delete(oldest);
  }
  lastAdvertLine.set(key, line);
  bleLog.debug(line);
}

/** Test seam: forget every remembered advert line. */
export function _resetAdvertLog(): void {
  lastAdvertLine.clear();
}
