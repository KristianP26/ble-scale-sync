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
   * Started at the top of every iteration, before the source is asked for a
   * reading. Used to drain the failed-export queue (#412): the network is as
   * likely to be back here as anywhere.
   *
   * Started, not awaited (E-02). A queued Garmin upload can take up to three
   * times `upload_timeout_sec` per entry, and while it was awaited here the
   * scan did not run, so a scale that only advertises while somebody stands on
   * it went unheard for the whole flush. At most one runs at a time: an
   * iteration that finds the previous one still running starts nothing, since
   * two passes over the same file would attempt the same entries twice. A
   * rejection is logged and is not an iteration failure; the queue says
   * nothing about the radio. Not awaited on the way out either: a shutdown is
   * bounded by the force-exit timer, which a hanging upload would outlast.
   *
   * Not a timer. On the watcher transports an iteration begins right after
   * the previous reading was processed and then blocks until the next one, so
   * a queue in a house that stops using the scale is attempted once more and
   * then waits until the scale is used again.
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
  /**
   * A minimum wait for this error on the backoff path, or undefined for none
   * (#475). The backoff still advances as usual and the loop waits the longer
   * of the two, so a floor can lengthen a wait but never shorten one, and
   * without a floor the wait and the log line are exactly the backoff's.
   * `label` is named in the log line when the floor sets the wait. Not asked
   * when `failureDelayMs` claims the error. Like that hook it sees every
   * iteration error, including one thrown by `processReading`, so an
   * implementation must recognise the errors it means.
   */
  failureDelayFloor?: (err: unknown) => { ms: number; label: string } | undefined;
  failureLogPrefix?: string;
  /** A prefix for this error instead of `failureLogPrefix`, or undefined to keep it. */
  failureLogPrefixFor?: (err: unknown) => string | undefined;
}

/**
 * Exponential backoff on iteration error: 5s -> 10s -> 20s -> 40s -> 60s cap,
 * unless `failureDelayMs` claims the error and names a shorter wait (#398).
 * `failureDelayFloor` can make a backoff wait longer, never shorter (#475).
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
    failureDelayFloor,
    failureLogPrefix = 'Error processing reading',
    failureLogPrefixFor,
  } = deps;

  let backoffMs = 0;
  let cycleStartRunning = false;

  try {
    while (!signal.aborted) {
      try {
        touchHeartbeat();

        // A pending reload goes first, so the queue flush below already sees
        // the new config (dry_run, a removed exporter) instead of delivering
        // with the old one (E-17).
        if (isReloadRequested()) {
          await onReload?.();
          clearReloadRequest();
          onSourceReload?.();
        }

        // Before the source is asked for anything: a queued export must not
        // wait for the next weigh-in to even be attempted on the poll
        // transports, where an iteration is a scan cycle. Not awaited, see
        // onCycleStart.
        if (onCycleStart && !cycleStartRunning) {
          cycleStartRunning = true;
          void (async () => {
            try {
              await onCycleStart();
            } catch (err) {
              log.debug(`Cycle-start task failed: ${errMsg(err)}`);
            } finally {
              cycleStartRunning = false;
            }
          })();
        }

        // Start hook is idempotent in every concrete source: ReadingWatcher
        // (mqtt-proxy, esphome-proxy) early-returns when `this.started === true`,
        // and PollReadingSource has no `start` at all. Calling on every iteration
        // costs one branch and lets the loop handle late-init sources uniformly.
        await source.start?.();

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
        const prefix = failureLogPrefixFor?.(err) ?? failureLogPrefix;
        const shortDelayMs = failureDelayMs?.(err);
        if (shortDelayMs !== undefined) {
          // An idle cycle neither advances nor resets a real failure streak:
          // nobody standing on the scale says nothing about the radio, in
          // either direction.
          log.info(`${prefix}, rescanning in ${shortDelayMs / 1000}s... (${errMsg(err)})`);
          await abortableSleep(shortDelayMs, signal).catch(() => {});
          continue;
        }
        backoffMs = backoffMs === 0 ? BACKOFF_INITIAL_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        // The ladder moves on under a floor too, so a real failure after a
        // run of floored waits continues where it would have (D041).
        const floor = failureDelayFloor?.(err);
        const floored = floor !== undefined && floor.ms > backoffMs ? floor : undefined;
        const waitMs = floored?.ms ?? backoffMs;
        const why = floored ? ` (${floored.label})` : '';
        log.info(`${prefix}, retrying in ${waitMs / 1000}s${why}... (${errMsg(err)})`);
        await abortableSleep(waitMs, signal).catch(() => {});
      }
    }
  } finally {
    await source.stop?.();
  }
}
