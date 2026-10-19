/**
 * A link BlueZ keeps listing as connected after the connection is gone (#472).
 *
 * BlueZ answers a Device1.Disconnect for a device it lists as connected only
 * from device_remove_connection(), so only once that connection is gone. When
 * the kernel has already dropped it without telling bluetoothd, the answer
 * never comes: a kernel from v6.11 on answers the MGMT Disconnect for a missing
 * connection with status 0x0e (Disconnected), which BlueZ before 5.84 only
 * logs. From then on Connect "succeeds" at once from BlueZ's own state, no
 * services ever resolve, and every Disconnect and RemoveDevice for the device
 * waits forever. Without a deadline each scan cycle parked on one of them until
 * the 900 s poll deadline, for days.
 *
 * Two parts: every Disconnect on the connect and teardown path gets a deadline
 * (disconnectBounded), and a teardown that saw one go unanswered power-cycles
 * the adapter and checks the result (recoverStaleLink). BlueZ's adapter_stop()
 * removes every connection it holds and answers their pending Disconnects. It
 * cannot clear a device that is missing from its connection list, which only a
 * bluetoothd restart does, so a failed check warns with that command and backs
 * off rather than power-cycling the adapter under every cycle. The brake holds
 * back only this recovery: with `ble.preemptive_adapter_reset` on, a GATT
 * session still ends with the preemptive power-cycle as before.
 *
 * A timeout is taken as evidence about the link, not about our D-Bus
 * connection. A clean close by the daemon does not get here: connection.ts
 * fails every pending and later call on it (A-03), which reads as an answer,
 * and the same goes for a call through a proxy left on a connection we
 * replaced ourselves. A close that only shows up as a stream error, with no
 * end, can still leave the call in flight unanswered. That is rare, and the
 * cost is one needless power-cycle plus a misleading "Cleared a stale BlueZ
 * connection" line.
 */

import {
  bleLog,
  errMsg,
  resetAdapterBtmgmt,
  withTimeout,
  DISCONNECT_TIMEOUT_MS,
} from '../types.js';
import { helperOf, releaseDeviceProxy, type Device } from './dbus.js';
import { getAdapter, parseHciIndex } from './connection.js';
import { powerCycleViaDbus } from './discovery.js';

/** What a bounded Disconnect ended with. An error answer from BlueZ is `'done'`. */
export type DisconnectOutcome = 'done' | 'timeout' | 'aborted';

/**
 * How a call failed because its D-Bus connection closed, rather than with an
 * answer from BlueZ: `'pending'` is the error connection.ts hands a call still
 * waiting when the connection closed (failPendingCalls), `'unsent'` the one
 * dbus-next throws for a write on a stream no longer writable, typically after
 * our own resetConnection() ended it and before the daemon closed its side
 * (`lib/connection.js`, no `.type`). Logged as an answer, the Disconnect a stale-link recovery leaves
 * behind on purpose would show up as "answered" with the time the reset took,
 * the number DISCONNECT_TIMEOUT_MS is tuned against. Matched by name and text
 * rather than imported, since the scan tests replace connection.js wholesale.
 */
function connectionClosedFailure(err: unknown): 'pending' | 'unsent' | undefined {
  if (
    (err as { type?: unknown } | null | undefined)?.type ===
    'org.freedesktop.DBus.Error.Disconnected'
  ) {
    return 'pending';
  }
  return errMsg(err).includes('Cannot send message, stream is closed') ? 'unsent' : undefined;
}

/** How long the check after the power-cycle may take, all of it together. */
const RECOVERY_CHECK_TIMEOUT_MS = 10_000;

/** The brake after a recovery that did not clear the link: 10, 20, 40, then 60 min. */
const BRAKE_FIRST_MS = 10 * 60_000;
const BRAKE_MAX_MS = 60 * 60_000;

/** Monotonic, unlike Date.now(): a Pi without an RTC steps its wall clock. */
const now = (): number => performance.now();

const announced = new Set<string>();

/** First time at `level`, after that at debug: these repeat while the state lasts. */
function announceOnce(key: string, level: 'info' | 'warn', message: string): void {
  if (announced.has(key)) {
    bleLog.debug(message);
    return;
  }
  announced.add(key);
  bleLog[level](message);
}

/** The brake for one scale. */
interface Brake {
  /** Recoveries in a row that did not clear the link, or could not tell. */
  failed: number;
  /** When the last of those ran (process clock). */
  lastFailedAt: number;
  /** No recovery before this (process clock). */
  nextAt: number;
}

/**
 * Per scale: one scale's stuck link says nothing about another's, and a
 * reading from the other one must not let this one power-cycle the adapter
 * every cycle again.
 */
const brakes = new Map<string, Brake>();

/** Any spelling of a MAC to one key; also tolerates a placeholder that is not one. */
const brakeKey = (mac: string): string => mac.replace(/[:-]/g, '').toUpperCase();

/** Test seam: the brake and the announcements are per process on purpose. */
export function _resetStaleLinkStateForTests(): void {
  brakes.clear();
  announced.clear();
}

function liftBrake(mac: string): void {
  brakes.delete(brakeKey(mac));
}

function tightenBrake(mac: string): void {
  const key = brakeKey(mac);
  const failed = (brakes.get(key)?.failed ?? 0) + 1;
  const lastFailedAt = now();
  const delay = Math.min(BRAKE_FIRST_MS * 2 ** (failed - 1), BRAKE_MAX_MS);
  brakes.set(key, { failed, lastFailedAt, nextAt: lastFailedAt + delay });
}

/**
 * The scale sent a reading over a connection, so whatever its link was stuck
 * on is gone. Not a successful connect: with a stuck link BlueZ answers
 * Connect at once from its own state (dev_connect()), so that would lift the
 * brake on every cycle. Not a broadcast reading either, which never touches
 * the link, nor a reading from another scale.
 */
export function noteReadingForStaleLink(mac: string): void {
  liftBrake(mac);
}

/** Whether a stale link to `mac` found now may be recovered, or the brake holds it back. */
export function staleLinkRecoveryDue(mac: string): boolean {
  const brake = brakes.get(brakeKey(mac));
  const at = now();
  if (!brake || at >= brake.nextAt) return true;
  const ago = Math.round((at - brake.lastFailedAt) / 60_000);
  const next = Math.max(1, Math.round((brake.nextAt - at) / 60_000));
  bleLog.debug(
    `Stale BlueZ link recovery for ${mac} skipped: the last attempt ${ago} min ago did not ` +
      `clear it (next in ${next} min)`,
  );
  return false;
}

/**
 * Device1.Disconnect with a deadline.
 *
 * Always sent, an already aborted signal included: on a shutdown during a
 * connect this Disconnect is what cancels the pending Connect in BlueZ (A-07),
 * so skipping it would leave the LE link to the scale up. Only the wait for the
 * answer ends with the abort.
 *
 * node-ble's disconnect() releases the proxy's listeners after BlueZ answers,
 * as before; when the answer never comes, releasing the proxy is up to whoever
 * owns it. One timer, unref'd, and one abort listener, both removed on every
 * path, rather than withTimeout inside untilAborted, whose timer would keep the
 * event loop alive for 10 s after a shutdown.
 */
export function disconnectBounded(
  device: Device,
  opts: { mac: string; label: string; abortSignal?: AbortSignal },
): Promise<DisconnectOutcome> {
  const { mac, label, abortSignal } = opts;
  const t0 = now();
  let answer: Promise<void>;
  try {
    answer = device.disconnect();
  } catch (err) {
    answer = Promise.reject(err);
  }
  // Handled at once, so a late answer or error is never unhandled. Logged even
  // when it comes after the deadline: how long BlueZ takes is the number
  // DISCONNECT_TIMEOUT_MS is tuned against.
  const answered = answer.then(
    () => bleLog.debug(`Disconnect (${label}) answered in ${Math.round(now() - t0)} ms`),
    (err: unknown) => {
      const closed = connectionClosedFailure(err);
      bleLog.debug(
        closed === 'pending'
          ? `Disconnect (${label}) got no answer before the D-Bus connection closed, ` +
              `after ${Math.round(now() - t0)} ms`
          : closed === 'unsent'
            ? `Disconnect (${label}) was not sent: the D-Bus connection was already closed`
            : `Disconnect (${label}) answered in ${Math.round(now() - t0)} ms: ${errMsg(err)}`,
      );
    },
  );
  if (abortSignal?.aborted) return Promise.resolve('aborted');
  return new Promise<DisconnectOutcome>((resolve) => {
    const timer = setTimeout(() => {
      announceOnce(
        'disconnect-timeout',
        'info',
        `BlueZ did not answer Disconnect for ${mac} within ${DISCONNECT_TIMEOUT_MS / 1000}s; ` +
          'it keeps the scale marked as connected (#472)',
      );
      finish('timeout');
    }, DISCONNECT_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = (): void => finish('aborted');
    function finish(outcome: DisconnectOutcome): void {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    void answered.then(() => finish('done'));
  });
}

/**
 * Whether BlueZ still lists `mac` as connected, read on a fresh adapter object.
 * Undefined when it could not tell within RECOVERY_CHECK_TIMEOUT_MS, as one
 * bound over every call in it (getAdapter() also registers the pairing agent),
 * or when `abortSignal` fired first. A proxy that comes back after either is
 * released all the same (#404).
 *
 * Its own unref'd timer and abort listener, as in disconnectBounded, rather
 * than withTimeout inside untilAborted: a shutdown during the check must not
 * wait for it, and that timer would hold the event loop open for the rest of
 * its 10 s.
 */
async function stillConnected(
  mac: string,
  bleAdapter: string | undefined,
  abortSignal?: AbortSignal,
): Promise<boolean | undefined> {
  let abandoned = false;
  let probe: Device | undefined;
  const check = async (): Promise<boolean> => {
    const adapter = await getAdapter(bleAdapter);
    let device: Device;
    try {
      device = await adapter.getDevice(mac);
    } catch (err) {
      // BlueZ dropped the object: nothing left that it could call connected.
      if (errMsg(err).includes('Device not found')) return false;
      throw err;
    }
    if (abandoned) {
      releaseDeviceProxy(device);
      return false;
    }
    probe = device;
    try {
      return (await helperOf(device).prop('Connected')) === true;
    } finally {
      probe = undefined;
      releaseDeviceProxy(device);
    }
  };
  return await new Promise<boolean | undefined>((resolve) => {
    let settled = false;
    const finish = (connected: boolean | undefined, giveUp?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      if (giveUp !== undefined) {
        abandoned = true;
        if (probe) releaseDeviceProxy(probe);
        bleLog.debug(`Could not check ${mac} after the adapter power-cycle: ${giveUp}`);
      }
      resolve(connected);
    };
    const timer = setTimeout(
      () => finish(undefined, `no answer within ${RECOVERY_CHECK_TIMEOUT_MS / 1000}s`),
      RECOVERY_CHECK_TIMEOUT_MS,
    );
    timer.unref?.();
    const onAbort = (): void => finish(undefined, 'shutting down');
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    check().then(
      (connected) => finish(connected),
      (err: unknown) => finish(undefined, errMsg(err)),
    );
  });
}

/**
 * Power-cycle the adapter to clear a link BlueZ keeps listing as connected,
 * then check once that it let go of the scale. Never throws.
 *
 * Called by the teardown after it reset the D-Bus connection. btmgmt first, on
 * the same index as the preemptive power-cycle; where btmgmt cannot run (no
 * CAP_NET_ADMIN, D036) BlueZ's own Powered off/on, which ends in the same
 * adapter_stop(). Runs with `ble.preemptive_adapter_reset: false` too: that
 * option turns off the power-cycle after every GATT session, not this one,
 * which only happens on evidence (D062).
 */
export async function recoverStaleLink(opts: {
  mac: string;
  bleAdapter: string | undefined;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { mac, bleAdapter, abortSignal } = opts;
  if (abortSignal?.aborted) return;
  const index = parseHciIndex(bleAdapter);
  let how: string | undefined;
  try {
    if (await resetAdapterBtmgmt(index)) {
      how = `by power-cycling hci${index}`;
    } else {
      // Bounded like the check below: getAdapter() is an Introspect plus the
      // pairing agent registration, and a bluetoothd whose main loop hangs
      // would otherwise park the teardown until the poll deadline.
      const adapter = await withTimeout(
        getAdapter(bleAdapter),
        RECOVERY_CHECK_TIMEOUT_MS,
        `no adapter from BlueZ within ${RECOVERY_CHECK_TIMEOUT_MS / 1000}s`,
      );
      if (await powerCycleViaDbus(adapter, abortSignal)) how = 'through BlueZ (Powered off/on)';
    }
  } catch (err) {
    bleLog.debug(`Adapter power-cycle for the stale link failed: ${errMsg(err)}`);
  }
  if (!how) {
    bleLog.debug(`Could not power-cycle hci${index} to clear the stale BlueZ link to ${mac}`);
    tightenBrake(mac);
    return;
  }
  // An abort during the power-cycle: nobody reads the result any more. A
  // shutdown would spend up to 10 s of its 5 s grace on the check, and a cycle
  // the poll loop gave up on would build a D-Bus connection that the next
  // cycle, or a transport already released, then inherits. The brake stays
  // as it is.
  if (abortSignal?.aborted) return;
  const connected = await stillConnected(mac, bleAdapter, abortSignal);
  // The same for an abort during the check.
  if (abortSignal?.aborted) return;
  if (connected === false) {
    announceOnce('cleared', 'info', `Cleared a stale BlueZ connection to ${mac} ${how}`);
    liftBrake(mac);
    return;
  }
  if (connected === true) {
    announceOnce(
      'still-connected',
      'warn',
      `BlueZ still reports ${mac} as connected after the adapter power-cycle and does not ` +
        'complete a Disconnect. Restart bluetoothd on the host: sudo systemctl restart bluetooth ' +
        '(on Home Assistant OS, reboot the host with "Reboot system", not just a Home Assistant ' +
        'restart, or run ha host reboot)',
    );
  }
  tightenBrake(mac);
}
