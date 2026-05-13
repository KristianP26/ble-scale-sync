import type { RawReading } from '../ble/shared.js';
import { abortableSleep } from '../ble/types.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';

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
  failureLogPrefix?: string;
}

/**
 * Exponential backoff on iteration error: 5s -> 10s -> 20s -> 40s -> 60s cap.
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
    failureLogPrefix = 'Error processing reading',
  } = deps;

  let backoffMs = 0;

  try {
    while (!signal.aborted) {
      try {
        touchHeartbeat();

        // Start hook is idempotent for watchers (no-op if already started).
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
        onFailure?.(err);
        backoffMs = backoffMs === 0 ? BACKOFF_INITIAL_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        log.info(`${failureLogPrefix}, retrying in ${backoffMs / 1000}s... (${errMsg(err)})`);
        await abortableSleep(backoffMs, signal).catch(() => {});
      }
    }
  } finally {
    await source.stop?.();
  }
}
