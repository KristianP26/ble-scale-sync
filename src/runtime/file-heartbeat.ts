import { writeFileSync, openSync, closeSync, constants } from 'node:fs';

/**
 * Liveness heartbeat file consumed by the Docker HEALTHCHECK (#277).
 *
 * The check asks one question: is this process still alive? It answers it by
 * requiring the file's mtime to be within 5 minutes. That only works if the
 * file is touched on a timer.
 *
 * It used to be touched once per `runContinuousLoop` iteration, and the
 * iteration then blocks in `source.nextReading()`. On the proxy transports that
 * blocks until somebody stands on the scale, so the file was really a
 * "last reading" marker being read as a "process is alive" marker. Any idle
 * period over 5 minutes flipped the container to unhealthy. On plain Docker
 * that is inert, but the Home Assistant Supervisor watchdog restarts an add-on
 * whose container reports unhealthy, which turned normal idle into a permanent
 * restart loop.
 *
 * Scope, matching the systemd watchdog's contract: this catches whole-loop
 * freezes only. A frozen event loop (the synchronous D-Bus stall in #140)
 * cannot run this interval callback either, so the file goes stale exactly when
 * it should. If the event loop is alive but a specific BLE handler is wedged,
 * the heartbeat keeps ticking; that case belongs to
 * `runtime.watchdog_max_consecutive_failures` and the hard-exit floor.
 */

const HEARTBEAT_PATH = '/tmp/.ble-scale-sync-heartbeat';

/** Matches DEFAULT_HEARTBEAT_MS in systemd-watchdog.ts; 10x margin under the 5 min window. */
const DEFAULT_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Open flags for the heartbeat file.
 *
 * O_NOFOLLOW is the point. The path is fixed and world-predictable, it lives in
 * a world-writable directory, and it is rewritten every 30 s with every error
 * swallowed - so if a local user could plant a symlink here, each tick would
 * follow it and truncate the target in silence.
 *
 * Defence in depth rather than a live hole: on the supported deployments the
 * kernel already refuses that. Debian and Raspberry Pi OS ship
 * `fs.protected_symlinks=1`, which will not follow a symlink in a sticky
 * directory owned by another uid, and `fs.protected_regular=1`, which refuses
 * O_CREAT on another user's file there; Docker and the HA add-on get a private
 * /tmp. What is left is a multi-user host with that hardening switched off. The
 * flag costs nothing, so it is not worth relying on someone else's sysctl.
 *
 * The path cannot move: the Docker HEALTHCHECK reads it by name.
 *
 * O_NOFOLLOW is POSIX-only; on Windows the constant is undefined, so it falls
 * back to 0 and the flags stay valid.
 */
const HEARTBEAT_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);

/** Write the heartbeat file. Never throws (e.g. /tmp is not writable on Windows). */
export function touchHeartbeat(): void {
  let fd: number | undefined;
  try {
    fd = openSync(HEARTBEAT_PATH, HEARTBEAT_FLAGS, 0o644);
    writeFileSync(fd, new Date().toISOString());
  } catch {
    // ignore
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Touch the heartbeat immediately, then every `intervalMs` for as long as the
 * process lives. Idempotent. No-op if already started.
 *
 * The timer is `unref()`d on purpose: a ref'd interval would keep the process
 * alive forever, which would break the consecutive-failure watchdog's recovery
 * (it works by letting the process exit so the supervisor restarts it).
 */
export function startFileHeartbeat(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  touchHeartbeat();
  timer = setInterval(touchHeartbeat, intervalMs);
  timer.unref();
}

/**
 * Stop the heartbeat. Idempotent.
 *
 * Load-bearing, not hygiene: the heartbeat starts at the top of main(), so if
 * main() throws without aborting (a failing healthcheck, an unreachable broker)
 * and some handle pins the event loop open, the process would otherwise sit
 * there reporting healthy forever. Stopping it lets the file go stale so the
 * supervisor restarts the container.
 */
export function stopFileHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Reset internal state. For tests only. */
export function _resetForTesting(): void {
  stopFileHeartbeat();
}
