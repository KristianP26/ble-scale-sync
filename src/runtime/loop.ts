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
    failureDelayMs,
    failureLogPrefix = 'Error processing reading',
  } = deps;

  let backoffMs = 0;

  try {
    while (!signal.aborted) {
      try {
        touchHeartbeat();

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
