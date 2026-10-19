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
 * Every Disconnect on the connect and teardown path gets a deadline here
 * (disconnectBounded), so the cycle ends and its teardown reaches the D-Bus
 * reset and the adapter power-cycle that follow it.
 */

import { bleLog, errMsg, DISCONNECT_TIMEOUT_MS } from '../types.js';
import type { Device } from './dbus.js';

/** What a bounded Disconnect ended with. An error answer from BlueZ is `'done'`. */
export type DisconnectOutcome = 'done' | 'timeout' | 'aborted';

/** Monotonic, unlike Date.now(): a Pi without an RTC steps its wall clock. */
const now = (): number => performance.now();

const announced = new Set<string>();

/** Test seam: the announcements are per process on purpose. */
export function _resetStaleLinkStateForTests(): void {
  announced.clear();
}

/** First time at `level`, after that at debug: these repeat while the state lasts. */
function announceOnce(key: string, level: 'info', message: string): void {
  if (announced.has(key)) {
    bleLog.debug(message);
    return;
  }
  announced.add(key);
  bleLog[level](message);
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
    (err: unknown) =>
      bleLog.debug(
        `Disconnect (${label}) answered in ${Math.round(now() - t0)} ms: ${errMsg(err)}`,
      ),
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
