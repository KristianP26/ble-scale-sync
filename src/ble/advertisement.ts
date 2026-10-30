import type {
  ScaleAdapter,
  ScaleReading,
  BleDeviceInfo,
  LiveWeight,
} from '../interfaces/scale-adapter.js';
import type { RawReading } from './shared.js';
import { isForced } from '../scales/force.js';
import { bleLog, normalizeUuid, BT_BASE_UUID_SUFFIX } from './types.js';
import { isDebugEnabled } from '../logger.js';

/**
 * True when the matched device still carries broadcast/service data this
 * adapter can parse — a usable reading may yet arrive in a future
 * advertisement, so the caller should keep waiting rather than opening a GATT
 * connection.
 *
 * False when the device exposes no parseable broadcast source: a dual-mode
 * adapter (e.g. QN Scale, which declares `parseBroadcast` for the AABB
 * broadcast variant but also has a GATT path) must then fall through to its
 * GATT path. This is the #201 fix — the scan-batch proxy paths previously let
 * any adapter that merely *declared* `parseBroadcast`/`parseServiceData` skip
 * GATT entirely, so GATT-only QN scales (which advertise just a name + service
 * UUID, no manufacturer data) were matched and then silently dropped.
 *
 * Known limitation (Option B): any `manufacturerData` counts as a broadcast
 * source even if `parseBroadcast` would reject it. A QN scale advertising
 * non-AABB manufacturer data would therefore be gated to "wait" — this matches
 * the pre-#201 behaviour, so it is no regression. GATT-only QN scales
 * advertise no manufacturer data at all, so they are unaffected. The
 * esphome-proxy *watcher* intentionally does not use this helper: its
 * per-advertisement stream GATT-connects such devices instead (QN Elis 1).
 */
export function hasParseableBroadcastSource(adapter: ScaleAdapter, info: BleDeviceInfo): boolean {
  // A forced adapter (ble.force_scale_adapter) is exempt from the "any
  // manufacturer data counts" shortcut above, because the shortcut assumes the
  // adapter was chosen BY that advertisement. A forced one was not: it claims
  // every device it is shown, so a dual-mode adapter like QN or Eufy P2 pointed
  // at a scale whose manufacturer data it cannot parse would return "wait"
  // forever and the GATT path would never run. Here the parse must actually
  // succeed.
  const forced = isForced(adapter);
  if (adapter.parseBroadcast && info.manufacturerData) {
    if (!forced) return true;
    if (adapter.parseBroadcast(info.manufacturerData.data) !== null) return true;
  }
  if (adapter.parseServiceData && info.serviceData && info.serviceData.length > 0) {
    if (!forced) return true;
    if (info.serviceData.some((sd) => adapter.parseServiceData!(sd.uuid, sd.data) !== null)) {
      return true;
    }
  }
  return false;
}

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
   * `hasParseableBroadcastSource` doc comment above.
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
 * Classify a single advertisement for a matched adapter. No timers, no I/O; the
 * adapter's parser may keep state (BroadcastSource), so call it once per
 * advertisement. Reproduces the branch copy-pasted across five handlers (#242).
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

/**
 * True when this adapter reads its weigh-in from advertisements and must never
 * be driven over a GATT session, even when it also declares GATT wiring.
 *
 * The same test noble and node-ble have always applied before deciding between
 * the passive scan and a connect. A Mi Scale 2 carries a GATT path too, and on
 * the reporter's unit that path answers the unlock write with a status echo
 * forever and never a weight frame, so a session opened to it runs to the cap
 * (#422).
 */
export function readsFromAdvertisement(adapter: ScaleAdapter): boolean {
  return (
    adapter.preferPassive === true &&
    (typeof adapter.parseServiceData === 'function' || typeof adapter.parseBroadcast === 'function')
  );
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

  /** True while any weight-only reading is waiting out its grace. */
  isHolding(): boolean {
    return this.readings.size > 0;
  }

  /** Clear all pending timers and stored readings (teardown). */
  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.readings.clear();
  }
}

/**
 * Arm the deadline of a single-shot broadcast scan. Returns a function that
 * disarms it.
 *
 * With nothing held when it fires, `expire` runs and the caller rejects the
 * scan as it always has. With a weight-only reading held it does nothing and
 * the scan keeps listening: either a complete frame arrives and resolves it
 * with the impedance, or the held reading's own grace timer resolves it weight
 * only (#357). That wait is bounded by `IMPEDANCE_GRACE_MS` from when the
 * reading was first held, because `GraceTimers.hold` arms its timer once and
 * does not re-arm it.
 *
 * Resolving the held reading AT the deadline instead cost a Mi Scale 2 its
 * impedance: a stable weight-only frame shortly before the deadline used to
 * mean a rejection, a quick rescan and then the complete frame, and resolving
 * it there exported the weight alone. Waiting out the grace keeps both.
 *
 * Only the deadline is softened. An abort, or any other failure the caller
 * rejects with, does not pass through here and stands as before.
 */
export function armScanDeadline(ms: number, grace: GraceTimers, expire: () => void): () => void {
  const timer = setTimeout(() => {
    if (grace.isHolding()) {
      bleLog.info(
        'Scan deadline reached while a weight-only reading waits for impedance; ' +
          'waiting out its grace before reporting it',
      );
      return;
    }
    expire();
  }, ms);
  return () => clearTimeout(timer);
}

// ─── Dedup window (per address+weight) ─────────────────────────────────────────

function dedupKey(address: string, weight: number, recordTime?: string): string {
  const key = `${address}:${weight.toFixed(1)}`;
  return recordTime === undefined ? key : `${key}@${recordTime}`;
}

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
   *
   * `recordTime` keys a stored record by its own time as well, so it is a
   * duplicate only of the same record handed over again, never of a live
   * weigh-in that happens to round to the same 0.1 kg.
   */
  shouldEmit(address: string, weight: number, recordTime?: string): boolean {
    const key = dedupKey(address, weight, recordTime);
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

// ─── Bounded per-address memory ───────────────────────────────────────────────

/**
 * A Map that keeps at most `max` entries, dropping the oldest to admit a new
 * key. Each cache says how a key it already holds ages: `lru` makes it the
 * newest again, `fifo` leaves it where it was. A watcher runs for weeks, and
 * devices on rotating private addresses would otherwise grow these for good.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(
    private readonly max: number,
    private readonly mode: 'fifo' | 'lru',
  ) {
    super();
  }

  override set(key: K, value: V): this {
    if (!this.has(key)) {
      if (this.size >= this.max) this.delete(this.keys().next().value as K);
    } else if (this.mode === 'lru') {
      this.delete(key);
    }
    return super.set(key, value);
  }
}

/** A Set of at most `max` values, dropping the oldest to admit a new one. */
export class BoundedSet<T> extends Set<T> {
  constructor(private readonly max: number) {
    super();
  }

  override add(value: T): this {
    if (!this.has(value) && this.size >= this.max) this.delete(this.values().next().value as T);
    return super.add(value);
  }
}

// ─── Post-reading window (per address, proxy GATT sessions) ────────────────────

/** Scales remembered at once, oldest out; one per scale that gave a reading. */
const POST_READING_MAX_ADDRESSES = 64;

/**
 * When each scale last gave a GATT reading on a proxy watcher (#466, D058).
 *
 * The mqtt-proxy and esphome-proxy watchers keep no distance from a scale
 * after a reading: a scale that stays on keeps advertising, and the next
 * advertisement opens a new session (on mqtt-proxy the ESP32 reconnects by
 * itself). That is how a second person stepping on before the scale switches
 * off gets read. When nobody does, the session ends without a reading, which
 * is expected and must not be reported as a failure.
 *
 * Asked when a session opens, not when it fails: a session can run for 90 s,
 * and what matters is whether it opened as the reconnect to a scale still on.
 * Entries are therefore not pruned by the window; the cap bounds them.
 *
 * A session in the window that ends without a weigh-in moves the window to
 * its end, since the scale was still on until then: a Yunmai Mini 2 stays
 * connectable for minutes after a weigh-in and is connected again on every
 * advertisement, and each of those sessions after the first 60 s used to
 * warn (#474, D070). The time of the reading itself is kept apart, so the
 * line still says how long after the reading the session opened.
 */
export class PostReadingWindow {
  private readonly last = new BoundedMap<string, { at: number; from: number; told: boolean }>(
    POST_READING_MAX_ADDRESSES,
    'lru',
  );

  constructor(
    private readonly windowMs: number,
    // Late-bound, unlike DedupWindow's `Date.now` default: that captures
    // whichever Date.now exists when the watcher is built, so a test faking
    // the clock afterwards would not move it.
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A GATT session on `address` delivered a reading. */
  noteReading(address: string): void {
    const now = this.now();
    this.last.set(address.toLowerCase(), { at: now, from: now, told: false });
  }

  /**
   * Milliseconds since the last reading on `address` while within the window,
   * else undefined. The window runs from the reading, or from the end of the
   * last session after it that ended without a weigh-in (reportNoWeighIn). A
   * clock that stepped back (an NTP sync on a board without a real-time clock)
   * counts as outside it.
   */
  sinceReading(address: string): number | undefined {
    const entry = this.last.get(address.toLowerCase());
    if (!entry) return undefined;
    const now = this.now();
    const since = now - entry.at;
    const inWindow = now - entry.from;
    return since >= 0 && inWindow >= 0 && inWindow <= this.windowMs ? since : undefined;
  }

  /**
   * Log a session opened `sinceMs` after the last reading on `address` that
   * ended without one, and move the window to now. Info once per reading,
   * debug after that: ESPHome retries a refused connect on every
   * advertisement, and a scale that stays on is connected again on each one.
   */
  reportNoWeighIn(address: string, subject: string, sinceMs: number, reason: string): void {
    const line =
      `${subject}: session opened ${(sinceMs / 1000).toFixed(1)} s after the last reading, ` +
      `while the scale was still on, ended without a new weigh-in (${reason}).`;
    const entry = this.last.get(address.toLowerCase());
    if (entry) entry.from = Math.max(entry.from, this.now());
    if (entry && !entry.told) {
      entry.told = true;
      bleLog.info(line);
      return;
    }
    bleLog.debug(line);
  }
}

// ─── Manufacturer data for the GATT session (per address) ─────────────────────

/** A manufacturer-data entry as every transport hands it over. */
type ManufacturerData = { id: number; data: Buffer };

/**
 * Last non-empty manufacturer data seen per address, for the GATT session
 * handoff only (ConnectionContext.manufacturerData, #461).
 *
 * An advertisement and its scan response can arrive apart, and the one that
 * matches an adapter (usually the named scan response) need not be the one
 * that carries the manufacturer data. ESPHome delivers them as two events:
 * the only QN scale logged through ESPHome matched on `name="QN-Scale"
 * uuids=[ffe0]` with none (#331). Deliberately NOT merged into what the
 * resolver or the broadcast parsers see: that would change which adapter
 * matches, and hand a broadcast adapter a stale frame. Bounded like the name
 * cache next to it.
 */
export class ManufacturerDataCache {
  private readonly byAddress: BoundedMap<string, ManufacturerData>;

  constructor(max = 64) {
    this.byAddress = new BoundedMap(max, 'lru');
  }

  /** Remember the frame's manufacturer data, if it has any. */
  remember(info: { manufacturerData?: ManufacturerData }, key: string): void {
    const md = info.manufacturerData;
    if (!md || md.data.length === 0) return;
    this.byAddress.set(key, md);
  }

  /**
   * The frame's own manufacturer data, else the last one seen for the address,
   * else none. An entry without bytes counts as none, as in `remember`, and is
   * never handed over: BlueZ can expose a company id with an empty payload.
   */
  forSession(
    info: { manufacturerData?: ManufacturerData },
    key: string,
  ): ManufacturerData | undefined {
    const own = info.manufacturerData;
    if (own && own.data.length > 0) return own;
    return this.byAddress.get(key);
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
 * Render a device-supplied name safe to put in a log line.
 *
 * The local name comes straight off the air, unfiltered, from anyone with a
 * radio in range - or from anyone who can publish to a proxy topic. It is
 * logged for EVERY advertisement seen during a scan, matched or not, so no
 * pairing or trust step gates it. A crafted name carrying CR/LF forges
 * convincing log lines in journald or docker logs, which is exactly what
 * reporters are asked to paste into public issues, and ANSI/OSC escapes rewrite
 * the terminal of whoever cats the file.
 *
 * Escaped rather than stripped, so a name that really does contain a control
 * character stays distinguishable from one that does not. That only holds if
 * the escape character is escaped too - otherwise a name containing the four
 * literal characters `\x0a` renders identically to one containing a real LF -
 * so backslash is in the class.
 *
 * The class covers more than C0. U+0080..U+009F are the C1 controls, and
 * xterm-family terminals honour U+009B and U+009D as CSI and OSC introducers
 * even in UTF-8 mode; a BLE name is UTF-8 decoded by every stack, so those
 * arrive intact. U+2028 and U+2029 are line breaks to anything that splits on
 * Unicode newlines rather than on LF.
 */
export function safeName(name: string | undefined): string {
  if (!name) return '';
  return name.replace(/[\\\x00-\x1f\x7f-\x9f\u2028\u2029]/g, (c) => {
    const code = c.charCodeAt(0);
    return code > 0xff
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : `\\x${code.toString(16).padStart(2, '0')}`;
  });
}

/**
 * The emit step every watcher shares: dedup, announce, queue.
 *
 * Two watchers held a byte-identical private `pushDeduped` and the third
 * inlined the same four steps and had drifted, logging `Broadcast reading:`
 * where the others logged `Reading:` and omitting the dedup-skip line (#406).
 *
 * Returns whether the reading was queued, which the caller needs: the
 * mqtt-proxy watcher registers the scale's MAC with the ESP32 only when a
 * reading is actually emitted, and doing that on every duplicate advertisement
 * would publish to the proxy on every repeat.
 *
 * Deliberately a free function over the two collaborators rather than a class
 * owning them: the queue and the dedup window are per-watcher fields with
 * per-watcher lifetimes (a queued reading survives stop/start today), and the
 * grace-timer callbacks are NOT identical - the mqtt one registers the MAC.
 * Sharing only what is genuinely shared keeps those differences visible.
 */
export function emitDeduped(
  dedup: DedupWindow,
  queue: { push: (raw: RawReading) => void },
  address: string,
  raw: RawReading,
  weight: number,
  recordTime?: string,
): boolean {
  if (!dedup.shouldEmit(address, weight, recordTime)) {
    bleLog.debug(`Dedup skip: ${dedupKey(address, weight, recordTime)}`);
    return false;
  }
  bleLog.info(`Matched: ${raw.adapter.name} (${address})`);
  bleLog.info(`Reading: ${weight.toFixed(2)} kg`);
  queue.push(raw);
  return true;
}

/**
 * One-line summary of everything an adapter's `matches()` is allowed to see.
 *
 * Adapter mis-routing was the root cause of #317, #318 and #319, and every one
 * of those was reported over a proxy transport. Reproducing the decision from a
 * pasted log needs the exact inputs, so this prints the whole `BleDeviceInfo`
 * rather than a summary of it.
 *
 * The address is passed separately because `BleDeviceInfo.address` is optional
 * and not every path fills it, while every caller of this line knows which
 * device the advert came from.
 */
export function formatAdvert(address: string, info: BleDeviceInfo): string {
  // Canonical uppercase form: the transports hand addresses over in different
  // cases, and the same device has to produce the same line for the dedup below
  // to mean anything.
  const parts = [
    `[${address.toUpperCase()}]`,
    `name=${info.localName ? `"${safeName(info.localName)}"` : '(none)'}`,
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
const lastAdvertLine = new BoundedMap<string, string>(64, 'fifo');

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
  lastAdvertLine.set(key, line);
  bleLog.debug(line);
}

/** Test seam: forget every remembered advert line. */
export function _resetAdvertLog(): void {
  lastAdvertLine.clear();
}
