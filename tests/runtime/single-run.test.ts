import { describe, it, expect, vi } from 'vitest';
import { runSingleShot } from '../../src/runtime/single-run.js';
import type { ReadingSource } from '../../src/runtime/loop.js';
import type { RawReading } from '../../src/ble/shared.js';

/**
 * A single run (`continuous_mode: false`, the default) ends only when the event
 * loop drains. On node-ble the D-Bus socket was never closed after a broadcast
 * reading or a failed scan, so the run exported and then hung (A-02 / E-12),
 * and the queue flush ran to completion before the scan even began (E-02).
 */

const RAW = { reading: { weight: 70, impedance: 0 }, adapter: {} } as unknown as RawReading;

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function source(calls: string[], next: () => Promise<RawReading>): ReadingSource {
  return {
    nextReading: vi.fn(async () => {
      calls.push('nextReading');
      return next();
    }),
    stop: vi.fn(async () => {
      calls.push('stop');
    }),
  };
}

describe('runSingleShot', () => {
  it('releases the transport after the scan and before the export', async () => {
    const calls: string[] = [];
    const ok = await runSingleShot({
      source: source(calls, async () => RAW),
      signal: new AbortController().signal,
      processReading: async () => {
        calls.push('process');
        return true;
      },
    });

    expect(ok).toBe(true);
    expect(calls).toEqual(['nextReading', 'stop', 'process']);
  });

  it('releases the transport when the scan fails, and still reports the failure', async () => {
    const calls: string[] = [];
    const run = runSingleShot({
      source: source(calls, async () => {
        throw new Error('Device not found within 120s');
      }),
      signal: new AbortController().signal,
      processReading: async () => true,
    });

    await expect(run).rejects.toThrow('Device not found');
    expect(calls).toEqual(['nextReading', 'stop']);
  });

  it('scans while the queue flush runs, and does not return before it finishes', async () => {
    const calls: string[] = [];
    const flush = deferred<void>();
    let settled = false;

    const run = runSingleShot({
      source: source(calls, async () => RAW),
      signal: new AbortController().signal,
      processReading: async () => {
        calls.push('process');
        return false;
      },
      flush: () => flush.promise,
    }).then((ok) => {
      settled = true;
      return ok;
    });

    // The scan and the export happened with the flush still in flight...
    await vi.waitFor(() => expect(calls).toEqual(['nextReading', 'stop', 'process']));
    await new Promise((r) => setTimeout(r, 0));
    // ...but the run is not over: a queued entry is off disk while it is being
    // attempted, so exiting now would lose it.
    expect(settled).toBe(false);

    flush.resolve();
    expect(await run).toBe(false);
  });

  it('a failing flush does not fail the run', async () => {
    const ok = await runSingleShot({
      source: source([], async () => RAW),
      signal: new AbortController().signal,
      processReading: async () => true,
      flush: async () => {
        throw new Error('queue unreadable');
      },
    });
    expect(ok).toBe(true);
  });
});
