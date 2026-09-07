import type { Logger } from '../logger.js';

/**
 * Hard-exit safety net for shutdown (#194).
 *
 * Graceful shutdown aborts the {@link AbortController} and relies on the Node
 * event loop draining so the process exits naturally (and Docker
 * `restart: unless-stopped` / systemd restarts it). But the scenario that most
 * often triggers the continuous-mode watchdog is a *wedged* BlueZ controller,
 * and node-ble / dbus-next keeps an open D-Bus socket that pins the event loop
 * open. The loop logs `Stopped.` but the process never exits: the container
 * stays running with a stale heartbeat (HEALTHCHECK → "unhealthy") and is
 * never restarted, because plain Docker only restarts on process *exit*, not
 * on an unhealthy status.
 *
 * `armHardExit` bounds every abort-driven shutdown: once the grace window
 * elapses, the process is force-exited so the supervisor can recover. The
 * timer is `unref()`d, so a clean drain still exits naturally well before it
 * fires — this is only the floor, not the normal path.
 */

let armed = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export interface ArmHardExitOptions {
  /** Grace window before force-exit, in milliseconds. */
  timeoutMs: number;
  log: Logger;
  /**
   * Exit code to use when `process.exitCode` was never set. Defaults to 1.
   *
   * A shutdown that could not drain is a failure when nobody asked for it, and
   * ordinary housekeeping when somebody did. A supervisor sees the difference:
   * a Home Assistant add-on stopped by hand and force-exited with 1 is reported
   * to its owner as a failed add-on (#335). Pass 0 for a stop the operator
   * asked for.
   */
  fallbackCode?: number;
  /** Injectable for tests. Defaults to `process.exit`. */
  exit?: (code: number) => never;
}

/**
 * Arm the hard-exit timer. Idempotent: only the first call arms it, so
 * multiple abort paths (watchdog trip, then a SIGTERM) do not stack timers.
 */
export function armHardExit({ timeoutMs, log, fallbackCode = 1, exit }: ArmHardExitOptions): void {
  if (armed) return;
  armed = true;

  const doExit = exit ?? ((code: number) => process.exit(code));

  timer = setTimeout(() => {
    // Preserve an explicitly-set exit code: both watchdog paths set 1 before
    // aborting, and that must win. `fallbackCode` decides only the case where
    // nothing set one, which is the plain signal path.
    const code = typeof process.exitCode === 'number' ? process.exitCode : fallbackCode;
    log.warn(
      `Shutdown did not complete within ${timeoutMs / 1000}s ` +
        `(event loop still pinned, likely a wedged D-Bus/BlueZ handle). ` +
        `Force-exiting with code ${code}` +
        (code === 0
          ? ', which is a stop you asked for rather than a failure.'
          : ' so the supervisor can restart cleanly.'),
    );
    doExit(code);
  }, timeoutMs);

  // The timer must not itself keep the process alive: if cleanup drains the
  // loop first, Node exits naturally before this fires (the desired outcome).
  timer.unref();
}

/**
 * Cancel a pending hard-exit timer and disarm so it can be re-armed. Lets a
 * shutdown path that has fully drained opt out of the force-exit floor, and
 * resets module state between tests.
 */
export function cancelHardExit(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  armed = false;
}
