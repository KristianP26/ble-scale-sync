import type {
  ScaleAdapter,
  UserProfile,
  ScaleReading,
  ScaleAuth,
  LiveWeight,
} from '../interfaces/scale-adapter.js';
import type {
  WeightUnit,
  MqttProxyConfig,
  EsphomeProxyConfig,
  HaBluetoothConfig,
} from '../config/schema.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
export { errMsg };

// ─── Constants ────────────────────────────────────────────────────────────────

export const LBS_TO_KG = 0.453592;
export const BT_BASE_UUID_SUFFIX = '00001000800000805f9b34fb';
export const CONNECT_TIMEOUT_MS = 30_000;
export const MAX_CONNECT_RETRIES = 5;
export const DISCOVERY_TIMEOUT_MS = 120_000;
export const DISCOVERY_POLL_MS = 2_000;

/** Timeout for GATT service/characteristic enumeration after connecting. */
export const GATT_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * How long the reading phase waits without a notification from the scale. The
 * timer restarts on every frame, so it counts silence rather than time since
 * connect: a window counted from connect can expire before the user steps on,
 * because connect is driven by the advertisement, not the weigh-in. Native
 * handlers only; the mqtt-proxy uses its own GATT_READING_IDLE_MS.
 */
export const RAW_READING_TIMEOUT_MS = 120_000;

/**
 * Absolute cap on one native reading session, as a multiple of the configured
 * silence window. The idle timer restarts on every frame, so a scale that
 * streams adapter-rejected frames forever would otherwise hold the session
 * open with no bound; the cap ends it while leaving room for a weigh-in that
 * spans several restarts. A session_timeout_sec above 300 makes
 * POLL_CYCLE_TIMEOUT_MS the effective ceiling instead.
 */
export const READING_SESSION_CAP_FACTOR = 3;

/**
 * Max attempts to enumerate GATT characteristics. BlueZ can signal
 * `ServicesResolved=true` before all characteristic interfaces are exported
 * over D-Bus ([bluez/bluez#1489](https://github.com/bluez/bluez/issues/1489)),
 * so the first enumeration can return a partial map. Retrying with a short
 * backoff lets BlueZ finish exporting before we validate the map.
 */
export const CHAR_DISCOVERY_MAX_RETRIES = 3;

/** Backoff between characteristic-enumeration retries. */
export const CHAR_DISCOVERY_RETRY_DELAY_MS = 500;

/** Delay after stopping BlueZ discovery to let the radio quiesce before connecting. */
export const POST_DISCOVERY_QUIESCE_MS = 500;

/**
 * Hard ceiling on one native poll cycle.
 *
 * The reading phase is bounded by scale silence, capped in absolute terms at
 * READING_SESSION_CAP_FACTOR x the silence window (360 s by default). The worst
 * legitimate node-ble cycle is then roughly 815 s (discovery 120 + six connect
 * attempts 170 + GATT acquisition 30 + characteristic retries + reading 360),
 * so 900 s never fires on a healthy run with the default session_timeout_sec.
 *
 * It exists because dbus-next never rejects an in-flight `MessageBus.call()`
 * when the socket dies: the resolver is stored in `_methodReturnHandlers` and is
 * only ever read when a reply arrives, so a broken D-Bus transport parks the
 * cycle forever. Without a deadline the consecutive-failure watchdog is never
 * reached and a dead transport looks exactly like an idle house (#290).
 */
export const POLL_CYCLE_TIMEOUT_MS = 900_000;

/**
 * Minimum cooldown floor after a successful read in continuous mode.
 * BLE scales typically keep advertising for 15-25 s after the user steps off
 * (display goes dark, link layer winds down). Connecting during that tail-off
 * triggers BlueZ to accept the request against a peer that never completes
 * GATT discovery, which on some controllers stalls the D-Bus call inside
 * node-ble synchronously. A 25 s floor sidesteps the dying-peer window
 * entirely. Failed scans still respect the configured cooldown only; this
 * floor applies on success.
 *
 * BlueZ-specific: only the `node-ble` handler hits the dying-peer GATT stall.
 * Proxy handlers (mqtt-proxy, esphome-proxy) and the noble-based stacks talk
 * to a different transport and do not need this floor; the orchestrator gates
 * application based on the resolved handler. See #143.
 */
export const POST_DISCONNECT_GRACE_MS = 25_000;

/** Threshold below which a cached RSSI is considered stale (BlueZ uses 127 as "unavailable" sentinel). */
export const RSSI_UNAVAILABLE = 127;

/**
 * Maximum age of the last RSSI PropertiesChanged signal before a peer is
 * considered to have stopped advertising. Typical BLE scale advertising
 * intervals are 100-500 ms, so 5 s gives roughly 10-50 missed packets of slack
 * before we treat the device reference as stale. See #143.
 */
export const RSSI_FRESHNESS_MS = 5_000;

/**
 * Observation window for the watchdog liveness probe (#213). After a failed idle
 * scan we watch advertisement activity for this long to tell a live-but-idle
 * radio (saw other adverts) from a wedged controller (saw nothing).
 */
export const LIVENESS_PROBE_WINDOW_MS = 3_000;

/**
 * Grace window after a weight-only broadcast frame is received.
 * The Mi Scale 2 broadcasts weight-only frames while BIA is in progress, then
 * a final frame with impedance once the measurement completes (~10-20 s on device).
 * If an impedance-bearing frame arrives within this window the complete reading is
 * used; otherwise the weight-only reading is forwarded as a fallback.
 */
export const IMPEDANCE_GRACE_MS = 12_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type BleHandlerName = 'auto' | 'mqtt-proxy' | 'esphome-proxy' | 'ha-bluetooth';

export interface ScanOptions {
  targetMac?: string;
  adapters: ScaleAdapter[];
  profile: UserProfile;
  scaleAuth?: ScaleAuth;
  weightUnit?: WeightUnit;
  onLiveData?: (reading: ScaleReading) => void;
  /**
   * Settling weights from a broadcast scale, for a display that follows it
   * (#356). A `LiveWeight` is not a `ScaleReading` and cannot be exported.
   */
  onLiveWeight?: (live: LiveWeight) => void;
  abortSignal?: AbortSignal;
  bleHandler?: BleHandlerName;
  mqttProxy?: MqttProxyConfig;
  esphomeProxy?: EsphomeProxyConfig;
  haBluetooth?: HaBluetoothConfig;
  bleAdapter?: string;
  /** Override RAW_READING_TIMEOUT_MS (seconds of silence) for one session (ble.session_timeout_sec, #83). */
  readingTimeoutMs?: number;
  /**
   * Clear a bond the scale has forgotten instead of only diagnosing it
   * (`ble.auto_clear_stale_bond`, #335). node-ble only; the other transports
   * have no bond to clear.
   */
  autoClearStaleBond?: boolean;
}

export interface ScanResult {
  address: string;
  name: string;
  matchedAdapter?: string;
}

// ─── Pure utilities ───────────────────────────────────────────────────────────

export const bleLog = createLogger('BLE');

/** Normalize a UUID to lowercase 32-char (no dashes) form for comparison. */
export function normalizeUuid(uuid: string): string {
  const stripped = uuid.replace(/-/g, '').toLowerCase();
  if (stripped.length === 4) {
    return `0000${stripped}${BT_BASE_UUID_SUFFIX}`;
  }
  return stripped;
}

/** Format MAC address for BlueZ D-Bus (uppercase with colons). */
export function formatMac(mac: string): string {
  const clean = mac.replace(/[:-]/g, '').toUpperCase();
  return clean.match(/.{2}/g)!.join(':');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Like withTimeout, but the deadline restarts whenever `start`'s callback is
 * invoked: the returned promise rejects after `ms` with no activity. Like
 * withTimeout, the promise from `start` is abandoned rather than cancelled, so
 * callers must still tear down whatever it holds.
 */
export async function withIdleTimeout<T>(
  start: (onActivity: () => void) => Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout!: (err: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const onActivity = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => rejectTimeout(new Error(message)), ms);
  };
  onActivity();
  try {
    return await Promise.race([start(onActivity), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function resetAdapterBtmgmt(adapterIndex = 0): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const idx = String(adapterIndex);
    await run('btmgmt', ['--index', idx, 'power', 'off'], { timeout: 5000 });
    bleLog.debug('btmgmt: adapter powered off');
    await sleep(500);
    await run('btmgmt', ['--index', idx, 'power', 'on'], { timeout: 5000 });
    bleLog.debug('btmgmt: adapter powered on');
    await sleep(2000);
    return true;
  } catch (err) {
    bleLog.debug(`btmgmt reset failed: ${errMsg(err)}`);
    return false;
  }
}

/** Reset Bluetooth adapter via rfkill (RF-level block/unblock). */
export async function resetAdapterRfkill(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('rfkill', ['block', 'bluetooth'], { timeout: 5000 });
    bleLog.debug('rfkill: bluetooth blocked');
    await sleep(1000);
    await run('rfkill', ['unblock', 'bluetooth'], { timeout: 5000 });
    bleLog.debug('rfkill: bluetooth unblocked');
    await sleep(3000);
    return true;
  } catch (err) {
    bleLog.debug(`rfkill reset failed: ${errMsg(err)}`);
    return false;
  }
}

/** Restart the bluetoothd service via systemctl (nuclear option). */
export async function restartBluetoothd(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('systemctl', ['restart', 'bluetooth'], { timeout: 15_000 });
    bleLog.debug('bluetoothd service restarted');
    await sleep(3000);
    return true;
  } catch (err) {
    bleLog.debug(`bluetoothd restart failed: ${errMsg(err)}`);
    return false;
  }
}
