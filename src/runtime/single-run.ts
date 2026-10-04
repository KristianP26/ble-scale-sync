import type { RawReading } from '../ble/shared.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
import type { ReadingSource } from './loop.js';

const log = createLogger('Sync');

export interface SingleShotDeps {
  source: ReadingSource;
  signal: AbortSignal;
  processReading: (raw: RawReading) => Promise<boolean>;
  /** Drains the failed-export queue (#412). Must not be started twice at once. */
  flush?: () => Promise<void>;
}

/**
 * One scan, one export: the `continuous_mode: false` path.
 *
 * The run ends only when the event loop drains, so everything it opens has to
 * be closed here. The source is stopped as soon as the scan settles, success
 * or not: node-ble keeps its D-Bus connection across scans and, before this,
 * reset it only after a GATT attempt, so a broadcast reading or a scale that
 * never showed up left the socket open and the process never exited (A-02,
 * E-12). Stopping before the export also frees the adapter for whoever runs
 * next.
 *
 * The queue flush runs alongside the scan instead of in front of it (E-02):
 * a queued upload to a slow server used to delay the scan for as long as it
 * took, while the person who started the run was already standing on the
 * scale. It is awaited before returning, whatever the outcome, because the
 * entry being attempted is already off disk (at-most-once, ADR D014) and
 * exiting under it would lose that reading.
 *
 * Resolves with the export result; rejects with the scan error.
 */
export async function runSingleShot(deps: SingleShotDeps): Promise<boolean> {
  const { source, signal, processReading, flush } = deps;
  const flushing = flush
    ? flush().catch((err: unknown) => log.debug(`Retrying queued exports failed: ${errMsg(err)}`))
    : Promise.resolve();

  try {
    let raw: RawReading;
    try {
      raw = await source.nextReading(signal);
    } finally {
      await source.stop?.();
    }
    return await processReading(raw);
  } finally {
    await flushing;
  }
}
