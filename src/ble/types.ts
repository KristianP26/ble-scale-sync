import type { ScaleAdapter, UserProfile, ScaleReading } from '../interfaces/scale-adapter.js';
import type { WeightUnit, MqttProxyConfig, EsphomeProxyConfig } from '../config/schema.js';
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
 * Grace window after a weight-only broadcast frame is received.
 * The Mi Scale 2 broadcasts weight-only frames while BIA is in progress, then
 * a final frame with impedance once the measurement completes (~10–20 s on device).
 * If an impedance-bearing frame arrives within this window the complete reading is
 * used; otherwise the weight-only reading is forwarded as a fallback.
 */
export const IMPEDANCE_GRACE_MS = 12_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type BleHandlerName = 'auto' | 'mqtt-proxy' | 'esphome-proxy';

export interface ScanOptions {
  targetMac?: string;
  adapters: ScaleAdapter[];
  profile: UserProfile;
  weightUnit?: WeightUnit;
  onLiveData?: (reading: ScaleReading) => void;
  abortSignal?: AbortSignal;
  bleHandler?: BleHandlerName;
  mqttProxy?: MqttProxyConfig;
  esphomeProxy?: EsphomeProxyConfig;
  bleAdapter?: string;
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
    await sleep(1500);
    return true;
  } catch (err) {
    bleLog.debug(`btmgmt reset failed: ${errMsg(err)}`);
    return false;
  }
}
