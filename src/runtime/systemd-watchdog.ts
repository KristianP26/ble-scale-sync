import { execFile } from 'node:child_process';
import { createLogger } from '../logger.js';

/**
 * systemd watchdog integration via the sd_notify protocol (#144).
 *
 * The synchronous D-Bus stall reproduced in #140 freezes the Node event loop
 * inside node-ble / dbus-next, so in-app guards built on `setTimeout` cannot
 * fire (the loop itself stops ticking). External liveness from systemd is the
 * clean fix: when the heartbeat misses for `WatchdogSec`, systemd kills and
 * restarts the unit.
 *
 * Wire-up requirements in the unit file:
 *   Type=notify
 *   WatchdogSec=60
 *   NotifyAccess=main
 *   Restart=on-failure
 *   RestartSec=5
 *
 * No-op when `$NOTIFY_SOCKET` is unset (Docker, `npm start`, non-systemd
 * runs), so this module is safe to import unconditionally.
 *
 * Implementation note: Node's `node:dgram` does not support AF_UNIX
 * SOCK_DGRAM, which is what the sd_notify protocol requires. We shell out to
 * `systemd-notify` instead (always available alongside systemd itself). The
 * spawn is async on purpose — if the event loop is frozen, neither the
 * `setInterval` callback nor the spawn completion will fire, and systemd will
 * fault the unit, which is exactly the desired behaviour.
 */

const log = createLogger('SystemdWatchdog');

const DEFAULT_HEARTBEAT_MS = 30_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let readyNotified = false;

function notify(message: string): void {
  execFile('systemd-notify', [message], (err) => {
    if (err) log.debug(`systemd-notify ${message} failed: ${err.message}`);
  });
}

function isEnabled(): boolean {
  return Boolean(process.env.NOTIFY_SOCKET);
}

/**
 * Send `READY=1` to the supervisor. Required by `Type=notify` units before
 * systemd considers the service active. Idempotent and safe to call multiple
 * times. No-op when `$NOTIFY_SOCKET` is unset.
 */
export function notifyReady(): void {
  if (!isEnabled()) return;
  if (readyNotified) return;
  readyNotified = true;
  notify('READY=1');
  log.info('systemd notify: READY=1');
}

/**
 * Start sending periodic `WATCHDOG=1` keepalives. Interval defaults to
 * `WATCHDOG_USEC / 2` (set automatically by systemd when `WatchdogSec=` is in
 * the unit) or 30 s when the env var is missing. The timer is `unref()`d so
 * it does not keep the process alive on its own. Idempotent. No-op when
 * `$NOTIFY_SOCKET` is unset.
 */
export function startHeartbeat(): void {
  if (!isEnabled()) return;
  if (heartbeatTimer) return;
  const usecRaw = process.env.WATCHDOG_USEC;
  const usec = usecRaw !== undefined ? Number.parseInt(usecRaw, 10) : NaN;
  const intervalMs =
    Number.isFinite(usec) && usec > 0 ? Math.floor(usec / 1000 / 2) : DEFAULT_HEARTBEAT_MS;
  heartbeatTimer = setInterval(() => notify('WATCHDOG=1'), intervalMs);
  heartbeatTimer.unref();
  log.info(`systemd watchdog heartbeat every ${intervalMs}ms`);
}

/** Stop the heartbeat timer. Idempotent. */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** True after a successful `notifyReady()` call. Test/diagnostic helper. */
export function isActive(): boolean {
  return readyNotified;
}

/** Reset internal state. For tests only. */
export function _resetForTesting(): void {
  stopHeartbeat();
  readyNotified = false;
}
