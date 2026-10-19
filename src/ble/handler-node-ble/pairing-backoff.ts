/**
 * Hold back a bonding scale whose pairing nobody confirmed (#471, D063).
 *
 * Nothing used to remember a pairing that failed. `ensureBonded()` logs the
 * failure and the cycle goes on unbonded, so with a scale that advertises all
 * the time (a Beurer BF915) every cycle connected again, waited 30 s for the
 * services, paired, and lit a fresh six-digit code on a scale nobody stood
 * at: about 370 codes in one night.
 *
 * The evidence is what our BlueZ agent saw: a cycle in which it handled a
 * request only a person at the scale can answer (`userPromptCount()`), that
 * ends without a reading and with the scale still unpaired, is a pairing
 * nobody confirmed. Only then is anything recorded. A failure without such a
 * request (a Just Works scale, a link that dropped before pairing, a D-Bus
 * hiccup) is retried on the next cycle as before.
 *
 * While a record stands and the scale is not paired, a cycle does not connect
 * to it at all, since BlueZ can start the pairing by itself and the connect
 * alone lights the display. It listens to the scale's advertisements for the
 * rest of its discovery budget and ends like an idle cycle. Pairing is tried
 * again after 2, 2, 2, 4, 8, 16, 32 minutes and then every
 * `ble.pairing_retry_max_min` (default 60), and at once when the scale comes
 * back after a cycle without it, when its advertisement says it holds a new
 * weigh-in, when it is paired by other means, or after a restart: the memory
 * lives only in this process.
 */

import type { BleDeviceInfo, ScaleAdapter } from '../../interfaces/scale-adapter.js';
import {
  bleLog,
  errMsg,
  formatMac,
  untilAborted,
  PairingDeferredError,
  RSSI_FRESHNESS_MS,
} from '../types.js';
import { helperOf, type Adapter, type Device, type PropsChangedHandler } from './dbus.js';
import { userPromptCount } from './agent.js';
import { FRESH_REPORT_PROPS } from './device-cache.js';
import { withScanActivityWatchdog, type ScanWatch } from './scan-watchdog.js';

/** The first waits, before the doubling starts. */
export const PAIRING_RETRY_FIRST_MS = 2 * 60_000;

/**
 * How many waits stay at PAIRING_RETRY_FIRST_MS. Somebody pairing for the
 * first time who misses the code waits 2 minutes, not 2, then 4, then 8.
 */
export const PAIRING_RETRY_FLAT_ATTEMPTS = 3;

/** `ble.pairing_retry_max_min` when the config does not set it. */
export const DEFAULT_PAIRING_RETRY_MAX_MIN = 60;

/** Wait after the `failures`-th unconfirmed pairing, under a cap in minutes. */
export function pairingRetryDelayMs(failures: number, capMin: number): number {
  const k = Math.max(1, failures);
  const raw =
    k <= PAIRING_RETRY_FLAT_ATTEMPTS
      ? PAIRING_RETRY_FIRST_MS
      : PAIRING_RETRY_FIRST_MS * 2 ** (k - PAIRING_RETRY_FLAT_ATTEMPTS);
  return Math.min(capMin * 60_000, raw);
}

interface PairingEntry {
  failures: number;
  /** `now()` of the last unconfirmed pairing. */
  failedAt: number;
  adapterName: string;
  /** A cycle since then waited for the scale and did not find it. */
  missedSinceFailure: boolean;
  /** The last thing the scale's advertisement said about a stored weigh-in. */
  lastHint: boolean | undefined;
}

export type PairingDecision =
  | { go: true; why: 'no-record' | 'off' | 'due' | 'returned' }
  | { go: false; waitMs: number; failures: number };

/** Unconfirmed pairings per scale, in this process only. */
export class PairingBackoff {
  private readonly entries = new Map<string, PairingEntry>();

  /** Monotonic by default, so a wall clock stepped by NTP moves nothing. */
  constructor(private readonly now: () => number = () => performance.now()) {}

  has(mac: string): boolean {
    return this.entries.has(formatMac(mac));
  }

  failures(mac: string): number {
    return this.entries.get(formatMac(mac))?.failures ?? 0;
  }

  adapterName(mac: string): string | undefined {
    return this.entries.get(formatMac(mac))?.adapterName;
  }

  /** Count one more unconfirmed pairing; returns how many there have been. */
  recordFailure(mac: string, adapterName: string, hint: boolean | undefined): number {
    const key = formatMac(mac);
    const failures = (this.entries.get(key)?.failures ?? 0) + 1;
    this.entries.set(key, {
      failures,
      failedAt: this.now(),
      adapterName,
      missedSinceFailure: false,
      lastHint: hint,
    });
    return failures;
  }

  /** Forget the scale; true when there was something to forget. */
  reset(mac: string): boolean {
    return this.entries.delete(formatMac(mac));
  }

  /** A cycle waited for this scale and did not find it. */
  noteMissed(mac: string): void {
    const entry = this.entries.get(formatMac(mac));
    if (entry) entry.missedSinceFailure = true;
  }

  /** Auto-discovery found no scale at all, so none of them was there. */
  noteMissedAll(): void {
    for (const entry of this.entries.values()) entry.missedSinceFailure = true;
  }

  /**
   * Take in what the advertisement says now. True only on the step from false
   * to true: a flag already up when the pairing failed means a weigh-in that
   * was waiting then, and opening on it would bring back the loop of #471.
   * Undefined says nothing and changes nothing.
   */
  observeHint(mac: string, hint: boolean | undefined): boolean {
    const entry = this.entries.get(formatMac(mac));
    if (!entry || hint === undefined) return false;
    const edge = entry.lastHint === false && hint;
    entry.lastHint = hint;
    return edge;
  }

  /** Time left until the next attempt, 0 when it is due or nothing is held. */
  remainingMs(mac: string, capMin: number): number {
    const entry = this.entries.get(formatMac(mac));
    if (!entry || capMin <= 0) return 0;
    const due = entry.failedAt + pairingRetryDelayMs(entry.failures, capMin);
    return Math.max(0, due - this.now());
  }

  /**
   * Whether this cycle may connect. The cap is read on every call, so a lower
   * one applies at once. A return after a missed cycle opens once.
   */
  decide(mac: string, capMin: number): PairingDecision {
    const entry = this.entries.get(formatMac(mac));
    if (!entry) return { go: true, why: 'no-record' };
    if (capMin <= 0) return { go: true, why: 'off' };
    const waitMs = this.remainingMs(mac, capMin);
    if (waitMs <= 0) return { go: true, why: 'due' };
    if (entry.missedSinceFailure) {
      entry.missedSinceFailure = false;
      return { go: true, why: 'returned' };
    }
    return { go: false, waitMs, failures: entry.failures };
  }
}

let backoff = new PairingBackoff();

/** The process-wide record the scan cycles share. */
export function pairingBackoff(): PairingBackoff {
  return backoff;
}

/** Test hook: a fresh record, optionally on the test's clock. */
export function _resetPairingBackoffForTests(now?: () => number): void {
  backoff = new PairingBackoff(now);
}

/** A cycle waited for this scale and did not find it (MAC branch). */
export function noteScaleMissed(mac: string): void {
  if (!backoff.has(mac)) return;
  backoff.noteMissed(mac);
  bleLog.debug(`${formatMac(mac)} was not found in this cycle; its next pairing goes at once`);
}

/** Auto-discovery found no scale; every held one counts as gone. */
export function noteAllScalesMissed(): void {
  backoff.noteMissedAll();
}

/**
 * The adapter whose hook reads the advertisement: the one matched in this
 * cycle, else the one the record was written with.
 */
export function hintAdapterFor(
  mac: string,
  adapter: ScaleAdapter | undefined,
  adapters: readonly ScaleAdapter[],
): ScaleAdapter | undefined {
  if (adapter?.advertisesPendingReading) return adapter;
  const name = backoff.adapterName(mac);
  return name === undefined ? adapter : (adapters.find((a) => a.name === name) ?? adapter);
}

/** What the adapter's hook makes of the advertised service data; never throws. */
export function advertisedReadingHint(
  adapter: ScaleAdapter | undefined,
  mac: string,
  serviceData: Array<{ uuid: string; data: Buffer }> | undefined,
): boolean | undefined {
  if (!adapter?.advertisesPendingReading || !serviceData) return undefined;
  const info: BleDeviceInfo = {
    localName: '',
    address: formatMac(mac),
    serviceUuids: [],
    serviceData,
  };
  try {
    return adapter.advertisesPendingReading(info);
  } catch (err) {
    bleLog.debug(`${adapter.name} could not read the advertised service data: ${errMsg(err)}`);
    return undefined;
  }
}

/**
 * The ServiceData property as a PropertiesChanged signal carries it: a
 * Variant of a{sv} whose values are Variants of ay. node-ble forwards the raw
 * Variants. Kept here rather than shared with the snapshot reader, whose
 * module the scan tests replace wholesale. An empty payload stays an empty
 * Buffer: for a BF915 that is the "nothing waiting" state (#418).
 */
export function parseServiceDataProp(
  prop: unknown,
): Array<{ uuid: string; data: Buffer }> | undefined {
  const dict = unwrapVariant(prop);
  if (!dict || typeof dict !== 'object') return undefined;
  const entries = dict instanceof Map ? [...dict.entries()] : Object.entries(dict);
  const out: Array<{ uuid: string; data: Buffer }> = [];
  for (const [uuid, value] of entries) {
    const data = bytesOf(value);
    if (data) out.push({ uuid: String(uuid), data });
  }
  return out.length > 0 ? out : undefined;
}

function unwrapVariant(v: unknown): unknown {
  if (v && typeof v === 'object' && !Buffer.isBuffer(v) && 'value' in v) {
    return (v as { value: unknown }).value;
  }
  return v;
}

function bytesOf(v: unknown): Buffer | undefined {
  const inner = unwrapVariant(v);
  if (Buffer.isBuffer(inner)) return inner;
  if (inner instanceof Uint8Array) return Buffer.from(inner);
  if (Array.isArray(inner) && inner.every((b) => typeof b === 'number')) {
    return Buffer.from(inner as number[]);
  }
  return undefined;
}

function minutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

function announceCleared(mac: string, why: string): void {
  bleLog.info(`${mac} ${why}; pairing attempts are no longer held back.`);
}

export interface PairingHoldOptions {
  device: Device;
  btAdapter: Adapter;
  mac: string;
  /** The adapter this cycle matched before connecting, if any. */
  adapter: ScaleAdapter | undefined;
  adapters: readonly ScaleAdapter[];
  /** `ble.pairing_retry_max_min`; undefined is the default. */
  capMin: number | undefined;
  /** What this cycle's advertisement snapshot said about a stored weigh-in. */
  hint: boolean | undefined;
  /** What is left of this cycle's discovery budget. */
  budgetMs: number;
  abortSignal?: AbortSignal;
  scanWatch?: ScanWatch;
  /** The scan activity watchdog; a test passes its own. */
  watch?: typeof withScanActivityWatchdog;
}

/**
 * Let the cycle connect, or hold it back while a pairing nobody confirmed
 * stands for this scale. Resolves with the latest advertisement hint once the
 * cycle may connect; throws PairingDeferredError, untagged, when the budget
 * ends first, so the failure classification decides between idle and a deaf
 * radio. Fails open: when the scale's state cannot be read, it connects as
 * before.
 */
export async function holdUntilPairingAllowed(
  opts: PairingHoldOptions,
): Promise<boolean | undefined> {
  const { device, btAdapter, abortSignal } = opts;
  const mac = formatMac(opts.mac);
  let hint = opts.hint;
  if (!backoff.has(mac)) return hint;

  let paired: boolean;
  try {
    paired = ((await untilAborted(device.isPaired(), abortSignal)) as unknown as boolean) === true;
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    bleLog.debug(`Could not read whether ${mac} is paired (${errMsg(err)}); connecting as before`);
    return hint;
  }
  if (paired) {
    backoff.reset(mac);
    announceCleared(mac, 'is paired now');
    return hint;
  }

  const capMin = opts.capMin ?? DEFAULT_PAIRING_RETRY_MAX_MIN;
  const waitLeft = (): number => backoff.remainingMs(mac, capMin);
  /** Why the attempt goes now, said only when it would otherwise have waited. */
  const triedNow = (why: string): string => {
    const left = waitLeft();
    return (
      `${mac} ${why}, so pairing is tried now` +
      (left > 0 ? ` rather than in ${minutes(left)} min` : '') +
      '. Confirm the pairing on the scale when it shows a code.'
    );
  };
  if (backoff.observeHint(mac, hint)) {
    bleLog.info(triedNow('advertises a stored weigh-in'));
    return hint;
  }
  const decision = backoff.decide(mac, capMin);
  if (decision.go) {
    if (decision.why === 'returned') {
      bleLog.info(triedNow('is back after a scan cycle without it'));
    } else {
      bleLog.debug(`Pairing with ${mac} is no longer held back (${decision.why})`);
    }
    return hint;
  }

  const hookAdapter = hintAdapterFor(mac, opts.adapter, opts.adapters);
  bleLog.debug(
    `Holding the pairing with ${mac} back: ${decision.failures} unconfirmed, ` +
      `${Math.round(decision.waitMs / 1000)}s left, listening for ` +
      `${Math.round(Math.max(0, opts.budgetMs) / 1000)}s, hint ${String(hint)}`,
  );
  const helper = helperOf(device);
  const watch = opts.watch ?? withScanActivityWatchdog;
  return await watch(
    btAdapter,
    abortSignal,
    () =>
      new Promise<boolean | undefined>((resolve, reject) => {
        let lastReportAt: number | undefined;
        let due = false;
        let settled = false;
        const timers: {
          due?: ReturnType<typeof setTimeout>;
          budget?: ReturnType<typeof setTimeout>;
        } = {};
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timers.due);
          clearTimeout(timers.budget);
          abortSignal?.removeEventListener('abort', onAbort);
          try {
            helper.removeListener('PropertiesChanged', onProps);
          } catch {
            /* the teardown releases the proxy either way */
          }
          fn();
        };
        const go = (): void => finish(() => resolve(hint));
        const onAbort = (): void =>
          finish(() => reject(abortSignal?.reason ?? new DOMException('Aborted', 'AbortError')));
        const onProps: PropsChangedHandler = (props) => {
          if (FRESH_REPORT_PROPS.some((p) => p in props)) lastReportAt = Date.now();
          if ('Paired' in props && unwrapVariant(props.Paired) === true) {
            backoff.reset(mac);
            announceCleared(mac, 'is paired now');
            go();
            return;
          }
          if ('ServiceData' in props) {
            const entries = parseServiceDataProp(props.ServiceData);
            const seen = advertisedReadingHint(hookAdapter, mac, entries);
            // The snapshot runs once a cycle; this shows every value in between,
            // also the ones the hook does not know.
            bleLog.debug(
              `${mac} ServiceData while held: ` +
                `${(entries ?? []).map((e) => `${e.uuid}: ${e.data.toString('hex')}`).join(', ') || 'none'}` +
                ` (hint ${String(seen)})`,
            );
            if (seen !== undefined) {
              hint = seen;
              if (backoff.observeHint(mac, seen)) {
                bleLog.info(triedNow('advertises a stored weigh-in'));
                go();
                return;
              }
            }
          }
          // Past the due time only a report itself lets the connect go: some
          // other property changing says nothing about the scale being awake.
          if (due && FRESH_REPORT_PROPS.some((p) => p in props)) go();
        };

        if (abortSignal?.aborted) {
          onAbort();
          return;
        }
        try {
          helper.on('PropertiesChanged', onProps);
        } catch (err) {
          bleLog.debug(`Could not listen to ${mac} (${errMsg(err)}); connecting as before`);
          settled = true;
          resolve(hint);
          return;
        }
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        // The connect after the wait needs the scale awake, and a report in
        // the last few seconds says it is; otherwise the next report does.
        timers.due = setTimeout(() => {
          due = true;
          if (lastReportAt !== undefined && Date.now() - lastReportAt <= RSSI_FRESHNESS_MS) {
            go();
          } else {
            bleLog.debug(`The pairing wait for ${mac} is over; connecting on its next report`);
          }
        }, decision.waitMs);
        timers.budget = setTimeout(
          () => finish(() => reject(new PairingDeferredError(mac, waitLeft()))),
          Math.max(0, opts.budgetMs),
        );
      }),
    opts.scanWatch,
  );
}

/**
 * At the end of a cycle: forget the record after a reading, write one after a
 * pairing nobody confirmed. Never throws, and leaves the device to the
 * teardown that follows.
 */
export async function settlePairingRecord(opts: {
  device: Device | null;
  mac: string;
  /** The bonding adapter this cycle matched, if any. */
  adapter: ScaleAdapter | undefined;
  /** userPromptCount() right before this cycle's connect; undefined: it never got there. */
  promptsBefore: number | undefined;
  reading: boolean;
  hint: boolean | undefined;
  capMin: number | undefined;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { device, adapter, promptsBefore, abortSignal } = opts;
  if (!opts.mac) return;
  try {
    const mac = formatMac(opts.mac);
    if (opts.reading) {
      if (backoff.reset(mac)) announceCleared(mac, 'sent a reading');
      return;
    }
    if (promptsBefore === undefined || adapter?.requiresBonding !== true) return;
    const prompts = userPromptCount(mac) - promptsBefore;
    if (prompts <= 0) {
      bleLog.debug(`No pairing prompt for ${mac} in this cycle; nothing to hold back`);
      return;
    }
    const capMin = opts.capMin ?? DEFAULT_PAIRING_RETRY_MAX_MIN;
    if (capMin <= 0) {
      bleLog.debug(`Pairing with ${mac} went unconfirmed; ble.pairing_retry_max_min is 0`);
      return;
    }
    // Pair() can still complete after our own timeout gave up on it, when
    // somebody presses SET a few seconds late. A deadline or shutdown after a
    // prompt says nobody did, and the memory goes with a shutdown anyway.
    if (!abortSignal?.aborted && device) {
      try {
        const paired =
          ((await untilAborted(device.isPaired(), abortSignal)) as unknown as boolean) === true;
        if (paired) {
          if (backoff.reset(mac)) announceCleared(mac, 'is paired now');
          else bleLog.debug(`${mac} finished pairing late in the cycle`);
          return;
        }
      } catch (err) {
        if (!abortSignal?.aborted) {
          bleLog.debug(`Could not read whether ${mac} is paired: ${errMsg(err)}`);
        }
      }
    }
    const failures = backoff.recordFailure(mac, adapter.name, opts.hint);
    bleLog.info(
      `${mac} asked for the pairing to be confirmed on the scale and it was not ` +
        `(attempt ${failures}). Not connecting to it again for ` +
        `${minutes(pairingRetryDelayMs(failures, capMin))} min, or until it reappears after ` +
        'sleeping or advertises a new weigh-in. Restart ble-scale-sync to pair at once; ' +
        'ble.pairing_retry_max_min sets the longest wait (0 retries on every scan).',
    );
  } catch (err) {
    bleLog.debug(`Could not settle the pairing record: ${errMsg(err)}`);
  }
}
