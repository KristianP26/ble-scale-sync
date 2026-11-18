import { bleLog, errMsg } from './types.js';
import { escapeForLog } from '../utils/escape.js';
import type { Logger } from '../logger.js';

/**
 * Input from a peer is untrusted (ADR D108): the ESP32 proxy publishes to a
 * broker other clients may reach, and Home Assistant is a network peer. This
 * module is the one place `src/ble/**` parses JSON from a peer, prints text
 * from one, and guards the listeners that run on one's data.
 *
 * A listener that throws is not caught by the library that calls it: mqtt.js
 * runs `message` listeners synchronously inside a stream write and a WebSocket
 * `message` listener runs on the event target, and in both cases the exception
 * ends the process.
 */

/** Largest JSON text accepted from the ESP32 proxy for a list of scan results. */
export const MAX_PEER_JSON_BYTES = 1024 * 1024;
/** Largest JSON object accepted for the small payloads (`connected`, `error`). */
export const MAX_PEER_OBJECT_BYTES = 64 * 1024;
/** Home Assistant is a trusted server and its snapshot can be large. */
export const HA_MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** Fault logs of one kind are a warning at most this often, the rest are debug. */
const THROTTLE_WINDOW_MS = 60_000;
/** Distinct keys remembered; the keys are literals from the code, so this is a safety cap. */
const THROTTLE_MAX_KEYS = 64;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type PeerParse<T> = { ok: true; value: T } | { ok: false; why: string };

/**
 * The only `JSON.parse` on peer data in `src/ble/**`. The size is checked before
 * the text is decoded or parsed; for a string it is the length in characters,
 * which bounds the bytes from above and costs nothing.
 */
export function parsePeerJson(raw: Buffer | string, maxBytes: number): PeerParse<unknown> {
  if (raw.length > maxBytes) return { ok: false, why: `too large (${raw.length} bytes)` };
  try {
    return { ok: true, value: JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) };
  } catch {
    return { ok: false, why: 'not valid JSON' };
  }
}

export function parsePeerObject(
  raw: Buffer | string,
  maxBytes: number,
): PeerParse<Record<string, unknown>> {
  const parsed = parsePeerJson(raw, maxBytes);
  if (!parsed.ok) return parsed;
  return isPlainObject(parsed.value)
    ? { ok: true, value: parsed.value }
    : { ok: false, why: 'not a JSON object' };
}

export function parsePeerArray(raw: Buffer | string, maxBytes: number): PeerParse<unknown[]> {
  const parsed = parsePeerJson(raw, maxBytes);
  if (!parsed.ok) return parsed;
  return Array.isArray(parsed.value)
    ? { ok: true, value: parsed.value }
    : { ok: false, why: 'not a JSON array' };
}

/**
 * Text from a peer, safe to put in a log line: cut to `max` characters first
 * (a Buffer only decodes as many bytes as that can need), then escaped in full,
 * LF included, so it can never start a line of its own.
 */
export function peerText(value: unknown, max = 120): string {
  let text: string;
  let cut = false;
  if (Buffer.isBuffer(value)) {
    cut = value.length > max * 4;
    text = value.toString('utf8', 0, max * 4);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > max) {
    text = text.slice(0, max);
    cut = true;
  }
  return escapeForLog(text) + (cut ? '...' : '');
}

interface ThrottleState {
  lastWarnAt: number;
  suppressed: number;
  variant?: string;
}
const throttled = new Map<string, ThrottleState>();

export interface ThrottleOptions {
  /**
   * A value that differs from the one of the last warning of this key is
   * warned at once instead of held back, so a changed reason is not hidden by
   * the first one. The caller keeps it bounded (the error of a retrying
   * connection, not free text).
   */
  variant?: string;
  /** Logger the line goes to; the BLE one by default. */
  log?: Logger;
}

/**
 * Log `text` as a warning the first time per `key` in a minute, as debug after
 * that, and say how many were held back when the next warning comes. For
 * messages an outside party can trigger at will. `key` must be a literal from
 * the code, never peer data: the map is capped but not meant to hold input.
 */
export function warnThrottled(key: string, text: string, options: ThrottleOptions = {}): void {
  const log = options.log ?? bleLog;
  const now = Date.now();
  const state = throttled.get(key);
  if (state && state.variant === options.variant && now - state.lastWarnAt < THROTTLE_WINDOW_MS) {
    state.suppressed++;
    log.debug(text);
    return;
  }
  const more =
    state && state.suppressed > 0 ? ` (${state.suppressed} more in the last minute)` : '';
  if (!state && throttled.size >= THROTTLE_MAX_KEYS) {
    throttled.delete(throttled.keys().next().value as string);
  }
  throttled.set(key, { lastWarnAt: now, suppressed: 0, variant: options.variant });
  log.warn(text + more);
}

/**
 * True for a message the broker replays from its store after a subscribe. A live
 * publish has `retain: false` even when the publisher set the flag, so this
 * tells a stored copy from a current one. Null-safe: test doubles and older
 * callers pass no packet.
 */
export function isRetained(packet?: { retain?: boolean }): boolean {
  return packet?.retain === true;
}

/** Test seam: the throttle state is module-wide. */
export function _resetPeerInput(): void {
  throttled.clear();
}

/** A message from `peer` that is not what it is supposed to send, ignored. */
export function reportPeerFault(peer: string, what: string, detail: unknown): void {
  warnThrottled(
    `peer|${peer}|${what}`,
    `Ignored a malformed ${what} from ${peer}: ${peerText(detail)}`,
  );
}

/**
 * Wrap a listener that runs on peer data so nothing it throws can escape into
 * the library that called it. The same wrapped function must be used for `on`
 * and `removeListener`. All arguments are passed through.
 */
export function guardedListener<A extends unknown[]>(
  peer: string,
  what: string,
  fn: (...args: A) => void,
): (...args: A) => void {
  return (...args: A): void => {
    try {
      fn(...args);
    } catch (err) {
      warnThrottled(
        `peer-throw|${peer}|${what}`,
        `Failed to handle a ${what} from ${peer}: ${peerText(errMsg(err))}`,
      );
    }
  };
}
