/**
 * What one connect attempt's link did, as BlueZ reports it on D-Bus (#471, D066).
 *
 * Every BlueZ answers a refused pairing key and a weak radio link with the
 * same `le-connection-abort-by-local`: att_connect_cb() turns every failed
 * ATT connect into -ECONNABORTED (checked on 5.66 to 5.86 and master). What
 * differs is the link. On a refused key (Encryption Change 0x06) the kernel
 * sends HCI_Disconnect at once, and the connection ends about one connection
 * interval later (#290: 193 ms). The ATT channel is dropped by a 100 ms timer,
 * which is the error Connect() returns, so the connection outlives the error
 * by that interval minus 100 ms (#290: the retry Disconnect waited 74-95 ms).
 * On a lost link the error and the end of the connection come from one kernel
 * event (#229, #471: 4-22 ms). BlueZ 5.83 and later also say why a connection
 * ended, in Device1.Disconnected, sent before Connected goes false and before
 * any Disconnect is answered.
 *
 * Connected comes from the PropertiesChanged that node-ble already forwards
 * on the device's helper, so watching it costs no D-Bus call. The reason
 * needs a ProxyObject of our own: one Introspect, plus a match rule only when
 * BlueZ declares the signal. node-ble's own `_ifaceProxy` is private and
 * replaced on every removeListeners(), so it is not borrowed.
 */

import { bleLog, errMsg } from '../types.js';
import { helperOf, type Device, type PropsChangedHandler, type SignalInterface } from './dbus.js';

const DEVICE_IFACE = 'org.bluez.Device1';

/** Bound on the introspection behind the reason subscription; the connect goes ahead without it. */
export const REASON_PROBE_TIMEOUT_MS = 2_000;

/**
 * The probe raced against its deadline and a shutdown. One timer, unref'd and
 * cleared on every path, rather than withTimeout inside untilAborted, whose
 * timer would keep the event loop alive for the rest of its 2 s after a
 * shutdown (the same reason as disconnectBounded in stale-link.ts).
 */
function boundedProbe<T>(probe: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): unknown => abortSignal?.reason ?? new DOMException('Aborted', 'AbortError');
    if (abortSignal?.aborted) {
      probe.catch(() => {});
      reject(aborted());
      return;
    }
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      settle();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error(`no introspection answer within ${REASON_PROBE_TIMEOUT_MS / 1000}s`)),
        ),
      REASON_PROBE_TIMEOUT_MS,
    );
    timer.unref?.();
    const onAbort = (): void => finish(() => reject(aborted()));
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    probe.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}

export interface AttemptLinkView {
  /** Device1.Connected went true after the Connect call (a stuck link never does, #472). */
  linkUp: boolean;
  /** From markConnectStart() to that change. */
  linkUpAfterMs?: number;
  /**
   * From markError() to Connected false, Disconnected or the answer to a
   * Disconnect (markGone), whichever came first; below 0 if before.
   */
  downAfterErrorMs?: number;
  /** This BlueZ declares Device1.Disconnected (5.83 and later) and the observer listens to it. */
  reasonSupported: boolean;
  /** The first reason Device1.Disconnected gave during this attempt. */
  reason?: string;
}

export interface LinkObserver {
  /** Right before Connect: the link only counts from here on. */
  markConnectStart(): void;
  /** When the connect failed. First call wins. */
  markError(): void;
  /**
   * BlueZ answered a Disconnect, which it does only once the connection is
   * gone. The end of the connection when no Connected=false was seen: BlueZ
   * before 5.79 sends that after the answer, and node-ble drops our listener
   * on the answer.
   */
  markGone(): void;
  /** At once if the connection never came up or is down already; else when it goes down, or after maxMs. */
  settle(maxMs: number, abortSignal?: AbortSignal): Promise<void>;
  view(): AttemptLinkView;
  /** Both listeners off. Idempotent. */
  stop(): void;
}

let clock: () => number = () => performance.now();
let supportAnnounced = false;

const variantValue = (v: unknown): unknown =>
  typeof v === 'object' && v !== null && 'value' in v ? (v as { value: unknown }).value : v;

/**
 * Start watching one connect attempt on `device`. With `probeReasons`, also
 * subscribe to Device1.Disconnected where BlueZ has it, on the bus of this
 * device (the retry loop may have moved to a new D-Bus connection). Never
 * throws: a probe that fails, or gets no answer within
 * REASON_PROBE_TIMEOUT_MS, leaves the attempt without reasons.
 */
export async function observeConnectAttempt(
  device: Device,
  opts: { probeReasons: boolean; abortSignal?: AbortSignal },
): Promise<LinkObserver> {
  const helper = helperOf(device) as ReturnType<typeof helperOf> | undefined;
  let started = false;
  let connectAt = clock();
  let errorAt: number | undefined;
  let upAt: number | undefined;
  let downAt: number | undefined;
  let reason: string | undefined;
  let reasonSupported = false;
  let iface: SignalInterface | undefined;
  let wake: (() => void) | undefined;

  const markDown = (): void => {
    if (upAt !== undefined && downAt === undefined) downAt = clock();
    wake?.();
  };
  const onProps: PropsChangedHandler = (props) => {
    // A change before the Connect call belongs to an earlier connection.
    if (!started || !('Connected' in props)) return;
    const value = variantValue(props.Connected);
    if (value === true && upAt === undefined) upAt = clock();
    else if (value === false) markDown();
  };
  const onDisconnected = (r: unknown): void => {
    if (!started) return;
    if (reason === undefined && typeof r === 'string') reason = r;
    markDown();
  };

  try {
    helper?.on('PropertiesChanged', onProps);
  } catch {
    // A torn-down helper or a test double: nothing to observe.
  }

  if (opts.probeReasons && helper?.dbus?.getProxyObject) {
    try {
      const obj = await boundedProbe(
        helper.dbus.getProxyObject('org.bluez', helper.object),
        opts.abortSignal,
      );
      const candidate = obj.getInterface(DEVICE_IFACE);
      if (candidate.$signals?.some((s) => s.name === 'Disconnected')) {
        // The match rule is added here, on the same connection and before the
        // Connect call, so the daemon has it before any reason is sent.
        candidate.on('Disconnected', onDisconnected);
        iface = candidate;
        reasonSupported = true;
      }
      if (!supportAnnounced) {
        supportAnnounced = true;
        bleLog.debug(
          reasonSupported
            ? 'BlueZ on this host says why a connection ended (Device1.Disconnected)'
            : 'BlueZ on this host does not say why a connection ended (Device1.Disconnected needs BlueZ 5.83)',
        );
      }
    } catch (err) {
      // A late answer finds no listener to add, so it leaves no match rule.
      bleLog.debug(`Disconnect reasons unavailable for this connect attempt: ${errMsg(err)}`);
    }
  }

  let stopped = false;
  return {
    markConnectStart: () => {
      started = true;
      connectAt = clock();
    },
    markError: () => {
      errorAt ??= clock();
    },
    markGone: () => {
      if (upAt !== undefined && downAt === undefined) downAt = clock();
    },
    settle: (maxMs, abortSignal) => {
      if (upAt === undefined || downAt !== undefined || abortSignal?.aborted) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          abortSignal?.removeEventListener('abort', done);
          wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, maxMs);
        timer.unref?.();
        wake = done;
        abortSignal?.addEventListener('abort', done, { once: true });
      });
    },
    view: () => ({
      linkUp: upAt !== undefined,
      linkUpAfterMs: upAt === undefined ? undefined : Math.round(upAt - connectAt),
      downAfterErrorMs:
        downAt === undefined || errorAt === undefined ? undefined : Math.round(downAt - errorAt),
      reasonSupported,
      reason,
    }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        helper?.removeListener('PropertiesChanged', onProps);
      } catch {
        // Helper already torn down.
      }
      try {
        iface?.removeListener('Disconnected', onDisconnected);
      } catch {
        // Bus already gone.
      }
      iface = undefined;
    },
  };
}

/** The clock the link gaps are measured on; connect.ts times its retry Disconnect with it. */
export function linkNow(): number {
  return clock();
}

/** Test seam: the clock (fake timers do not move performance.now()) and the one-time support line. */
export function _resetLinkObserverForTests(now?: () => number): void {
  clock = now ?? (() => performance.now());
  supportAnnounced = false;
}
