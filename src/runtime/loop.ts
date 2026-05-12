import type { RawReading } from '../ble/shared.js';
import type { ScaleAdapter, UserProfile } from '../interfaces/scale-adapter.js';
import { abortableSleep } from '../ble/types.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('Sync');

const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Source of `RawReading`s for the runtime loop. The MQTT-proxy and
 * ESPHome-proxy `ReadingWatcher` classes already satisfy this shape natively;
 * the poll-based path uses `PollReadingSource` to wrap `scanAndReadRaw`.
 */
export interface ReadingSource {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  nextReading(signal: AbortSignal): Promise<RawReading>;
  updateConfig?(adapters: ScaleAdapter[], targetMac?: string, profile?: UserProfile): void;
}

export interface RuntimeLoopDeps {
  source: ReadingSource;
  /** Process the reading. Closure typically calls `processReading(ctx, raw, opts)`. */
  processReading: (raw: RawReading) => Promise<boolean>;
  signal: AbortSignal;
  touchHeartbeat: () => void;
  /** SIGHUP / fs.watch flag check. Read each iteration. */
  isReloadRequested: () => boolean;
  /** Reset the flag. Called after `onReload` completes successfully. */
  clearReloadRequest: () => void;
  /** Reload config + rebuild any cached single-user exporters. */
  onReload?: () => Promise<void>;
  /** Push fresh config to the source (e.g. watcher.updateConfig). */
  onSourceReload?: () => void;
  /** After successful processReading. Poll-path: watchdog success + cooldown sleep. */
  onSuccess?: () => Promise<void> | void;
  /** After failed iteration. Poll-path: watchdog failure tick. */
  onFailure?: (err: unknown) => void;
  /**
   * Failure-log prefix. Today the three paths differ:
   *   mqtt-proxy:    'Error processing reading'
   *   esphome-proxy: 'Error processing ESPHome reading'
   *   poll-based:    'No scale found'
   */
  failureLogPrefix?: string;
}

/**
 * Single continuous loop implementation that subsumes the three near-identical
 * loops previously inlined in `src/index.ts` (mqtt-proxy / esphome-proxy /
 * poll-based). Behaviour is preserved verbatim:
 *
 *   - heartbeat on every iteration
 *   - SIGHUP / fs.watch reload before `nextReading`
 *   - source-specific success / failure hooks
 *   - exponential backoff on iteration error (5s -> 10s -> 20s -> 40s -> 60s cap)
 *   - clean exit on abort, with `source.stop()` always called
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
