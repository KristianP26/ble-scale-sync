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
 * Home Assistant replays every advertisement it has cached the moment a client
 * subscribes, so a restart would otherwise re-deliver the last weigh-in as if it
 * had just happened. Anything HA last saw more than this long ago is dropped;
 * live traffic always carries a fresh stamp.
 */
export const STALE_ADVERT_MS = 30_000;

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
  private staleDropped = 0;

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

      ws.addEventListener('open', () => {
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
          this.startPing();
          bleLog.info(
            `Subscribed to Home Assistant Bluetooth advertisements` +
              (this.version ? ` (HA ${this.version})` : ''),
          );
          settle();
          return;
        }
        this.stopped = true;
        settle(new HaBluetoothPermanentError(describeSubscribeError(msg)));
        this.dropSocket();
        return;
      case 'event':
        if (msg.id !== this.subscriptionId) return;
        for (const ad of msg.event?.add ?? []) this.dispatch(ad);
        return;
      case 'pong':
        this.awaitingPong = false;
        return;
      default:
        return;
    }
  }

  private dispatch(ad: HaAdvertisement): void {
    if (!ad || typeof ad.address !== 'string') return;
    if (this.config.source && ad.source?.toLowerCase() !== this.config.source.toLowerCase()) {
      return;
    }
    if (typeof ad.time === 'number' && this.now() - ad.time * 1000 > STALE_ADVERT_MS) {
      // Replayed from HA's cache on subscribe; see STALE_ADVERT_MS.
      this.staleDropped++;
      if (this.staleDropped <= 3) {
        bleLog.debug(`Ignoring stale cached advertisement for ${ad.address} from Home Assistant`);
      }
      return;
    }
    let info: BleDeviceInfo;
    try {
      info = toBleDeviceInfo(ad);
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
        if (this.stopped) return;
        bleLog.warn(`Home Assistant reconnect failed: ${errMsg(err)}`);
        if (!(err instanceof HaBluetoothPermanentError)) this.scheduleReconnect();
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
