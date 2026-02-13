import type { ScaleAdapter, UserProfile, ScaleReading } from '../interfaces/scale-adapter.js';
import type { WeightUnit } from '../config/schema.js';
import { createLogger } from '../logger.js';
export { errMsg } from '../utils/error.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const LBS_TO_KG = 0.453592;
export const BT_BASE_UUID_SUFFIX = '00001000800000805f9b34fb';
export const CONNECT_TIMEOUT_MS = 30_000;
export const MAX_CONNECT_RETRIES = 5;
export const DISCOVERY_TIMEOUT_MS = 120_000;
export const DISCOVERY_POLL_MS = 2_000;

/** Timeout for GATT service/characteristic enumeration after connecting. */
export const GATT_DISCOVERY_TIMEOUT_MS = 30_000;

/** Delay after stopping BlueZ discovery to let the radio quiesce before connecting. */
export const POST_DISCOVERY_QUIESCE_MS = 500;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScanOptions {
  targetMac?: string;
  adapters: ScaleAdapter[];
  profile: UserProfile;
  weightUnit?: WeightUnit;
  onLiveData?: (reading: ScaleReading) => void;
  abortSignal?: AbortSignal;
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
