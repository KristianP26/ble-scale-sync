import type { BleDeviceInfo } from '../../interfaces/scale-adapter.js';
import type { HaBluetoothConfig } from '../../config/schema.js';
import { bleLog, errMsg } from '../types.js';
import { toBleDeviceInfo, type HaAdvertisement } from './advert.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long to wait for `auth_ok` + the subscription result before giving up. */
const CONNECT_TIMEOUT_MS = 15_000;
/** Application-level ping cadence; a missing pong before the next tick drops the socket. */
const PING_INTERVAL_MS = 30_000;
/** Reconnect backoff bounds after an unexpected close. */
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/**
 * Home Assistant answers the subscribe with a snapshot of every device it still
 * tracks, each stamped with when it was last heard (up to 15-20 minutes back),
 * so a restart would otherwise re-deliver the last weigh-in as if it had just
 * happened. Anything HA last saw more than this long ago is dropped, in the
 * snapshot and in the live stream alike. Live traffic is stamped with when HA
 * received it, converted to wall time with the clock offset HA took when the
 * subscription started, so it is fresh unless the two clocks disagree.
 */
export const STALE_ADVERT_MS = 30_000;

/** Live advertisements dropped as stale in a row before the clock-skew warning. */
const STALE_SKEW_WARN_AFTER = 20;
/**
 * ...and the run must have lasted this long on our clock: live advertisements
 * that queued up while this process stalled arrive as one burst, each of them
 * fresh when Home Assistant sent it. Short enough for the 15 s `scan` to warn.
 */
const STALE_SKEW_MIN_SPAN_MS = 10_000;

// WebSocket readyState values (WHATWG); Node's global WebSocket uses the same.
const WS_OPEN = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The slice of the WHATWG WebSocket surface this client uses. Declared locally
 * so the module compiles without the DOM lib and so tests can inject a fake.
 * Node 22+ provides a conforming global `WebSocket`.
 */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
}

export type WsFactory = (url: string) => WsLike;

export type AdvertCallback = (info: BleDeviceInfo, address: string, ad: HaAdvertisement) => void;

export interface HaBluetoothClientOptions {
  /** Socket constructor, injected by tests. Defaults to the global WebSocket. */
  wsFactory?: WsFactory;
  /** Reconnect with backoff after an unexpected close (continuous mode). Default true. */
  reconnect?: boolean;
  /** Clock, injected by tests. */
  now?: () => number;
}

/** A failure the client will not retry: bad token, non-admin user, HA too old. */
export class HaBluetoothPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HaBluetoothPermanentError';
  }
}

interface HaMessage {
  id?: number;
  type?: string;
  ha_version?: string;
  message?: string;
  success?: boolean;
  error?: { code?: string; message?: string };
  event?: { add?: HaAdvertisement[]; remove?: { address: string }[] };
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

/**
 * Turn the configured Home Assistant base URL into its websocket endpoint:
 * `http(s)://` becomes `ws(s)://` and `/api/websocket` is appended unless a path
 * is already present. A full `ws(s)://host/api/websocket` is accepted as-is.
 */
export function toWebSocketUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new Error(`Unsupported Home Assistant URL scheme: ${u.protocol}`);
  }
  if (u.pathname === '' || u.pathname === '/') u.pathname = '/api/websocket';
  u.search = '';
  u.hash = '';
  return u.toString();
}

function defaultWsFactory(url: string): WsLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
  if (!Ctor) {
    throw new Error('Global WebSocket is not available; Node.js 22 or newer is required');
  }
  return new Ctor(url);
}

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * Subscribes to Home Assistant's Bluetooth advertisement stream
 * (`bluetooth/subscribe_advertisements`, admin-only) and fans every
 * advertisement out to subscribers as a {@link BleDeviceInfo}.
 *
 * HA aggregates each device's `manufacturer_data` and `service_data` across
 * advertisements and emits an event whenever they change, so the stream is a
 * superset of what a local radio would show: every scanner HA knows about
 * (local adapter, ESPHome proxies, SMLIGHT SLZB, Shelly) feeds it. Passive only:
 * HA exposes no GATT path over this API.
 *
 * Right after the subscribe result HA sends one event with its whole
 * advertisement history (oldest first since 2026.8), then one event per live
 * advertisement. The first event of each subscription is handled as that
 * snapshot: it follows the same delivery rule as live traffic, but only live
 * traffic counts towards the clock-skew warning.
 */
export class HaBluetoothClient {
  private ws: WsLike | null = null;
  private readonly wsFactory: WsFactory;
  private readonly reconnect: boolean;
  private readonly now: () => number;
  private readonly subscribers = new Set<AdvertCallback>();
  private stopped = false;
  private nextId = 1;
  private subscriptionId: number | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private version: string | null = null;
  /** True between a successful subscribe result and the snapshot event after it. */
  private awaitingSnapshot = false;
  /** Live advertisements dropped as stale in a row, for the skew warning. */
  private liveStaleRun = 0;
  /** Our clock when the current run started. */
  private liveStaleSince = 0;
  /** Smallest age seen in the current run, the best estimate of the offset. */
  private liveStaleMinAgeMs = Infinity;
  /** The skew warning fires at most once per subscription. */
  private skewWarned = false;
  /** Set on the first successful subscription; see the subscribe-result branch. */
  private subscribedOnce = false;
  /** Addresses already reported by noteUndatable. */
  private readonly undatableLogged = new Set<string>();

  constructor(
    private readonly config: HaBluetoothConfig,
    opts: HaBluetoothClientOptions = {},
  ) {
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.reconnect = opts.reconnect ?? true;
    this.now = opts.now ?? Date.now;
  }

  /** Home Assistant version reported during the auth handshake, once connected. */
  get haVersion(): string | null {
    return this.version;
  }

  /**
   * Connect, authenticate and subscribe. Rejects when the first attempt fails;
   * later drops are reconnected in the background when `reconnect` is on.
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connectOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'client stop');
      } catch {
        // already closed
      }
    }
  }

  onAdvertisement(cb: AdvertCallback): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  // ─── Connection lifecycle ───────────────────────────────────────────────────

  private connectOnce(): Promise<void> {
    const wsUrl = toWebSocketUrl(this.config.url);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        settle(new Error(`Timed out connecting to Home Assistant at ${wsUrl}`));
        this.dropSocket();
      }, CONNECT_TIMEOUT_MS);

      let ws: WsLike;
      try {
        ws = this.wsFactory(wsUrl);
      } catch (err) {
        settle(err instanceof Error ? err : new Error(errMsg(err)));
        return;
      }
      this.ws = ws;
      this.subscriptionId = null;

      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
        bleLog.debug(`Home Assistant websocket open: ${wsUrl}`);
      });
      ws.addEventListener('message', (ev) => {
        this.handleMessage(ev.data, settle);
      });
      ws.addEventListener('error', (ev) => {
        const detail =
          typeof ev === 'object' && ev !== null && 'message' in ev
            ? String((ev as { message: unknown }).message)
            : 'socket error';
        bleLog.debug(`Home Assistant websocket error: ${detail}`);
        if (opened) return; // `close` follows and handles it
        // Node 22 fires only `error`, never `close`, when the connection is
        // refused or the upgrade is answered without a 101 (the Supervisor
        // proxy while HA boots), so without this every failed attempt sat out
        // CONNECT_TIMEOUT_MS. Node 24 sends an empty message, then `close`.
        settle(
          new Error(
            `Could not connect to Home Assistant at ${wsUrl}${detail ? `: ${detail}` : ''}`,
          ),
        );
        // Only through dropSocket(), which clears this.ws first: on Node 22,
        // close() on a socket that never opened fires `error` again
        // synchronously, so calling ws.close() straight from this listener
        // recurses until the stack overflows, which takes the process down.
        if (this.ws === ws) this.dropSocket();
      });
      ws.addEventListener('close', (ev) => {
        if (this.ws !== ws) return; // superseded
        this.ws = null;
        this.clearPing();
        const why = ev.reason ? ` (${ev.code ?? ''} ${ev.reason})`.replace('( ', '(') : '';
        if (!settled) {
          settle(new Error(`Home Assistant closed the websocket before subscribing${why}`));
          return;
        }
        if (this.stopped) return;
        bleLog.warn(`Home Assistant websocket closed${why}; reconnecting`);
        this.scheduleReconnect();
      });
    });
  }

  private handleMessage(data: unknown, settle: (err?: Error) => void): void {
    let msg: HaMessage;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data)) as HaMessage;
    } catch {
      bleLog.debug('Home Assistant sent a non-JSON frame; ignoring');
      return;
    }
    switch (msg.type) {
      case 'auth_required':
        if (msg.ha_version) this.version = msg.ha_version;
        this.send({ type: 'auth', access_token: this.config.token });
        return;
      case 'auth_ok': {
        if (msg.ha_version) this.version = msg.ha_version;
        const id = this.nextId++;
        this.subscriptionId = id;
        this.send({ id, type: 'bluetooth/subscribe_advertisements' });
        return;
      }
      case 'auth_invalid':
        this.stopped = true; // never retry a bad credential
        settle(
          new HaBluetoothPermanentError(
            `Home Assistant rejected the access token: ${msg.message ?? 'auth_invalid'}`,
          ),
        );
        this.dropSocket();
        return;
      case 'result':
        if (msg.id !== this.subscriptionId) return;
        if (msg.success) {
          this.reconnectDelay = RECONNECT_MIN_MS;
          this.subscribedOnce = true;
          this.startPing();
          // Every subscription opens with a snapshot and a new clock offset on
          // the HA side, so the skew record starts over with it.
          this.awaitingSnapshot = true;
          this.resetLiveStaleRun();
          this.skewWarned = false;
          bleLog.info(
            `Subscribed to Home Assistant Bluetooth advertisements` +
              (this.version ? ` (HA ${this.version})` : ''),
          );
          settle();
          return;
        }
        // Once this token has subscribed successfully, only a refusal of the
        // token itself is final. Anything else on a reconnect is HA still
        // starting: its websocket API is served from bootstrap stage 0 (with
        // the frontend), while `bluetooth` is a stage 1 integration and
        // registers this command only when it loads, so the first reconnect
        // after an HA restart can be answered `unknown_command` (B-05). Giving
        // up there left the transport dead until the liveness watchdog ended
        // the process, up to 30 minutes later. The first start() stays strict,
        // so a wrong setup is reported, not retried in silence.
        if (this.subscribedOnce && msg.error?.code !== 'unauthorized') {
          settle(new Error(describeSubscribeError(msg)));
        } else {
          this.stopped = true;
          settle(new HaBluetoothPermanentError(describeSubscribeError(msg)));
        }
        this.dropSocket();
        return;
      case 'event': {
        if (msg.id !== this.subscriptionId) return;
        const ads = msg.event?.add ?? [];
        // Classified by position, not content: HA always sends the snapshot
        // first, even when it is empty, and a one-entry snapshot looks just like
        // a live event. A misclassified event loses nothing, because both paths
        // deliver the same advertisements; only the diagnostics differ.
        if (this.awaitingSnapshot) {
          this.awaitingSnapshot = false;
          this.dispatchSnapshot(ads);
        } else {
          for (const ad of ads) this.dispatchLive(ad);
        }
        return;
      }
      case 'pong':
        this.awaitingPong = false;
        return;
      default:
        return;
    }
  }

  private resetLiveStaleRun(): void {
    this.liveStaleRun = 0;
    this.liveStaleSince = 0;
    this.liveStaleMinAgeMs = Infinity;
  }

  private accepts(ad: HaAdvertisement): boolean {
    if (!ad || typeof ad.address !== 'string') return false;
    if (this.config.source && ad.source?.toLowerCase() !== this.config.source.toLowerCase()) {
      return false;
    }
    return true;
  }

  /** Age on our clock, or null when HA sent no usable time stamp. */
  private ageMs(ad: HaAdvertisement): number | null {
    return typeof ad.time === 'number' ? this.now() - ad.time * 1000 : null;
  }

  /**
   * The history HA sends on subscribe. Most of it is minutes old by design, so
   * dropping it says nothing about the clocks and never feeds the skew warning.
   */
  private dispatchSnapshot(ads: HaAdvertisement[]): void {
    let sent = 0;
    let skipped = 0;
    let newestMs: number | null = null;
    for (const ad of ads) {
      if (!this.accepts(ad)) continue;
      sent++;
      const age = this.ageMs(ad);
      if (age !== null) newestMs = newestMs === null ? age : Math.min(newestMs, age);
      if (age !== null && age > STALE_ADVERT_MS) {
        skipped++;
        continue;
      }
      this.deliver(ad);
    }
    // The newest entry's age is a cheap skew hint even on a quiet install: HA
    // restamps a device on every advertisement it hears, so without skew the
    // newest is a few seconds old.
    bleLog.debug(
      `Home Assistant sent ${sent} cached advertisements on subscribe; skipped ${skipped} ` +
        `last seen more than ${STALE_ADVERT_MS / 1000}s ago` +
        (newestMs !== null ? ` (newest ${Math.round(newestMs / 1000)}s old)` : ''),
    );
  }

  private dispatchLive(ad: HaAdvertisement): void {
    if (!this.accepts(ad)) return;
    const ageMs = this.ageMs(ad);
    if (ageMs === null || ageMs <= STALE_ADVERT_MS) {
      if (ageMs !== null) this.resetLiveStaleRun();
      this.deliver(ad);
      return;
    }
    const now = this.now();
    if (this.liveStaleRun === 0) this.liveStaleSince = now;
    this.liveStaleRun++;
    this.liveStaleMinAgeMs = Math.min(this.liveStaleMinAgeMs, ageMs);
    if (this.liveStaleRun <= 3) {
      bleLog.debug(`Ignoring stale live advertisement for ${ad.address} from Home Assistant`);
    }
    // The gate compares Home Assistant's clock against ours. If they disagree
    // by more than the window, every live advertisement is dropped while the
    // subscription still looks healthy, so the symptom is silence with no
    // error. Say it once, with the measured offset. The span keeps a burst that
    // queued up while this process stalled from passing for skew.
    const span = now - this.liveStaleSince;
    if (
      !this.skewWarned &&
      this.liveStaleRun >= STALE_SKEW_WARN_AFTER &&
      span >= STALE_SKEW_MIN_SPAN_MS
    ) {
      this.skewWarned = true;
      bleLog.warn(
        `Home Assistant's live advertisements keep arriving stamped about ` +
          `${Math.round(this.liveStaleMinAgeMs / 1000)}s in the past ` +
          `(${this.liveStaleRun} in a row over ${Math.round(span / 1000)}s), so they are ` +
          `dropped as stale. This host's clock and Home Assistant's disagree, or Home ` +
          `Assistant's clock changed after the subscription started (restarting BLE Scale ` +
          `Sync clears that). Check NTP on both hosts.`,
      );
    }
  }

  /**
   * Once per address and process: a device whose manufacturer data was dropped
   * because Home Assistant's merged dict cannot say which entry is current and
   * the scanner sent no raw packet (toBleDeviceInfo). Without this line a scale
   * that never reads over Home Assistant leaves nothing in a debug log.
   */
  private noteUndatable(address: string): void {
    const key = address.toUpperCase();
    if (this.undatableLogged.has(key)) return;
    this.undatableLogged.add(key);
    bleLog.debug(
      `Home Assistant reports several manufacturer ids for ${key} and no raw packet to ` +
        `tell the newest, so its manufacturer data is ignored. The scanner that heard it ` +
        `does not forward raw advertisements.`,
    );
  }

  private deliver(ad: HaAdvertisement): void {
    let info: BleDeviceInfo;
    try {
      info = toBleDeviceInfo(ad, () => this.noteUndatable(ad.address));
    } catch (err) {
      bleLog.debug(`Malformed advertisement from Home Assistant: ${errMsg(err)}`);
      return;
    }
    for (const cb of this.subscribers) {
      try {
        cb(info, ad.address.toUpperCase(), ad);
      } catch (err) {
        bleLog.warn(`Advertisement handler threw: ${errMsg(err)}`);
      }
    }
  }

  private send(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      bleLog.debug(`Home Assistant websocket send failed: ${errMsg(err)}`);
    }
  }

  private startPing(): void {
    this.clearPing();
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (this.awaitingPong) {
        bleLog.warn('Home Assistant websocket missed a pong; dropping the connection');
        this.dropSocket();
        if (!this.stopped) this.scheduleReconnect();
        return;
      }
      this.awaitingPong = true;
      this.send({ id: this.nextId++, type: 'ping' });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.awaitingPong = false;
  }

  private clearTimers(): void {
    this.clearPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private dropSocket(): void {
    this.clearPing();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnect || this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connectOnce().catch((err) => {
        // Checked before `stopped`: the permanent branches set `stopped`
        // themselves before rejecting, so testing it first made this log
        // unreachable and the transport went quiet without saying why.
        if (err instanceof HaBluetoothPermanentError) {
          // Terminal: nothing reconnects after this, so a warn line buried in a
          // running log is not enough. Someone who rotates their long-lived
          // token months from now sees their scale stop working and needs to be
          // told why, and that it will not recover on its own.
          bleLog.error(
            `Home Assistant transport has given up and will not reconnect: ${errMsg(err)}`,
          );
          return;
        }
        if (this.stopped) return;
        bleLog.warn(`Home Assistant reconnect failed: ${errMsg(err)}`);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
    bleLog.debug(`Home Assistant reconnect in ${delay / 1000}s`);
  }
}

function describeSubscribeError(msg: HaMessage): string {
  const code = msg.error?.code ?? 'unknown';
  const detail = msg.error?.message ?? '';
  if (code === 'unauthorized') {
    return 'Home Assistant refused bluetooth/subscribe_advertisements: the token must belong to an administrator user';
  }
  if (code === 'unknown_command') {
    return 'Home Assistant does not know bluetooth/subscribe_advertisements: upgrade Home Assistant (the Bluetooth integration must be loaded)';
  }
  return `Home Assistant refused bluetooth/subscribe_advertisements (${code}${detail ? `: ${detail}` : ''})`;
}
