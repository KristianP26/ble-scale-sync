import type { RawReading } from '../ble/shared.js';
import { abortableSleep } from '../ble/types.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
import { MissingTransportModuleError } from '../ble/transport-availability.js';

const log = createLogger('Sync');

const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

export interface ReadingSource {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  nextReading(signal: AbortSignal): Promise<RawReading>;
}

export interface RuntimeLoopDeps {
  source: ReadingSource;
  processReading: (raw: RawReading) => Promise<boolean>;
  signal: AbortSignal;
  touchHeartbeat: () => void;
  isReloadRequested: () => boolean;
  clearReloadRequest: () => void;
  onReload?: () => Promise<void>;
  onSourceReload?: () => void;
  onSuccess?: () => Promise<void> | void;
  onFailure?: (err: unknown) => void;
  /**
   * Run at the start of every iteration, before the source is asked for a
   * reading. Used to drain the failed-export queue (#412): the network is as
   * likely to be back here as anywhere, and nothing else is competing for it.
   *
   * Not a timer. On the watcher transports an iteration begins when somebody
   * steps on the scale, so a queue in a house that stops using the scale waits
   * until it is used again.
   */
  onCycleStart?: () => Promise<void>;
  /**
   * Delay to wait after this error instead of the exponential backoff, or
   * undefined to back off as usual. The loop asks; the policy belongs to
   * whoever built the source, because only it can tell an idle scan from a
   * broken one (#398).
   *
   * It sees every iteration error, including a failure thrown by
   * `processReading` rather than by the source, so an implementation must
   * recognise the errors it means rather than assuming what it is handed.
   */
  failureDelayMs?: (err: unknown) => number | undefined;
  failureLogPrefix?: string;
}

/**
 * Exponential backoff on iteration error: 5s -> 10s -> 20s -> 40s -> 60s cap,
 * unless `failureDelayMs` claims the error and names a shorter wait (#398).
 */
export async function runContinuousLoop(deps: RuntimeLoopDeps): Promise<void> {
  const {
    source,
    processReading,
    signal,
    touchHeartbeat,
    isReloadRequested,
    clearReloadRequest,
    onReload,
    onSourceReload,
    onSuccess,
    onFailure,
    onCycleStart,
    failureDelayMs,
    failureLogPrefix = 'Error processing reading',
  } = deps;

  let backoffMs = 0;

  try {
    while (!signal.aborted) {
      try {
        touchHeartbeat();
        // Before the source is asked for anything: a queued export must not
        // wait for the next weigh-in to even be attempted on the poll
        // transports, where an iteration is a scan cycle.
        if (onCycleStart) await onCycleStart();

        // Start hook is idempotent in every concrete source: ReadingWatcher
        // (mqtt-proxy, esphome-proxy) early-returns when `this.started === true`,
        // and PollReadingSource has no `start` at all. Calling on every iteration
        // costs one branch and lets the loop handle late-init sources uniformly.
        await source.start?.();

        if (isReloadRequested()) {
          await onReload?.();
          clearReloadRequest();
          onSourceReload?.();
        }

        const raw = await source.nextReading(signal);
        await processReading(raw);

        backoffMs = 0;

        if (signal.aborted) break;
        await onSuccess?.();
      } catch (err) {
        if (signal.aborted) break;
        // A missing npm package never fixes itself on the next cycle. Retrying
        // it would bury the install instruction inside a "retrying in 60s" info
        // line, once per cycle, making an unrecoverable install problem look
        // exactly like a scale nobody stepped on. The caller's top-level catch
        // logs the message as an error and exits non-zero.
        if (err instanceof MissingTransportModuleError) throw err;
        onFailure?.(err);
        const shortDelayMs = failureDelayMs?.(err);
        if (shortDelayMs !== undefined) {
          // An idle cycle neither advances nor resets a real failure streak:
          // nobody standing on the scale says nothing about the radio, in
          // either direction.
          log.info(
            `${failureLogPrefix}, rescanning in ${shortDelayMs / 1000}s... (${errMsg(err)})`,
          );
          await abortableSleep(shortDelayMs, signal).catch(() => {});
          continue;
        }
        backoffMs = backoffMs === 0 ? BACKOFF_INITIAL_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        log.info(`${failureLogPrefix}, retrying in ${backoffMs / 1000}s... (${errMsg(err)})`);
        await abortableSleep(backoffMs, signal).catch(() => {});
      }
    }
  } finally {
    await source.stop?.();
  }
}
