import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Exporter } from '../../src/interfaces/exporter.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

type QueueModule = typeof import('../../src/runtime/export-queue.js');

const at = (hms: string): number => Date.parse(`2026-10-09T${hms}Z`);

/**
 * #460: three Garmin exports failed within a minute, a watchdog restart came
 * in between, and the first pass after it said "Retrying 2". That looked like
 * the restart had lost the third reading. It had not: every entry keeps its
 * own retry clock, the third missed the first pass by 37 s, so its second
 * retry was due three minutes after the pass the reporter saw.
 *
 * The restart is a fresh module instance over the same file, which is what a
 * watchdog exit followed by a container restart is to this code. The test
 * asserts the third DELIVERY, not an empty file at the end: a file that lost
 * the entry at the restart ends empty too.
 */
describe('export retry queue across a process restart (#460)', () => {
  let dir: string;
  let file: string;
  let now = 0;
  const logged: Array<{ now: number; line: string }> = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-restart-'));
    file = path.join(dir, '.export-retry-queue.jsonl');
    logged.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push({ now, line: args.map(String).join(' ') });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('keeps all three entries through the restart and delivers the third when it is due', async () => {
    let garminUp = false;
    const garmin = {
      name: 'garmin',
      supportsBackdate: true,
      export: vi.fn(async () =>
        garminUp ? { success: true } : { success: false, error: 'no Garmin token' },
      ),
    } as unknown as Exporter;
    const lookup = () => garmin;

    const queued = (queuedAt: string, weight: number) => ({
      exporter: 'garmin',
      payload: { weight } as unknown as BodyComposition,
      timestamp: new Date(Date.parse(queuedAt) - 4).toISOString(),
      userSlug: 'martin',
      queuedAt,
      attempts: 0,
    });
    const A = '2026-10-09T11:10:03.643Z';
    const B = '2026-10-09T11:10:07.596Z';
    const C = '2026-10-09T11:10:59.620Z';

    // Process 1: three failed live exports, then the two retry passes.
    let q: QueueModule = await import('../../src/runtime/export-queue.js');
    for (const [queuedAt, weight] of [
      [A, 80.1],
      [B, 80.2],
      [C, 80.3],
    ] as const) {
      now = Date.parse(queuedAt);
      q.enqueue(file, queued(queuedAt, weight), now);
    }
    const flushAt = async (hms: string): Promise<void> => {
      now = at(hms);
      await q.flushQueue(file, lookup, now);
    };
    await flushAt('11:13:00.000');
    await flushAt('11:25:22.851');
    await flushAt('11:28:41.727');
    await flushAt('11:35:00.000');
    await flushAt('11:38:00.000');

    // Watchdog trip at 11:41:00.686, new process at 11:41:06.951.
    vi.resetModules();
    q = await import('../../src/runtime/export-queue.js');
    now = at('11:41:06.951');
    const afterRestart = q.loadQueue(file, now);
    expect(afterRestart.map((e) => e.queuedAt)).toEqual([A, B, C]);
    expect(afterRestart.map((e) => e.attempts)).toEqual([1, 1, 1]);
    expect(afterRestart.map((e) => e.lastAttemptAt)).toEqual([
      '2026-10-09T11:25:22.851Z',
      '2026-10-09T11:25:22.851Z',
      '2026-10-09T11:28:41.727Z',
    ]);

    // Process 2: Garmin works again by the time the next retries are due.
    garminUp = true;
    await flushAt('11:45:00.000');
    await flushAt('12:10:52.221');
    // One millisecond before the third entry's second retry is due.
    await flushAt('12:13:41.726');
    await flushAt('12:13:55.000');

    const retrying = logged
      .map(({ now: t, line }) => ({ t, m: line.match(/Retrying (\d+)/) }))
      .filter((x): x is { t: number; m: RegExpMatchArray } => x.m !== null)
      .map(({ t, m }) => [new Date(t).toISOString(), Number(m[1])]);
    expect(retrying).toEqual([
      ['2026-10-09T11:25:22.851Z', 2],
      ['2026-10-09T11:28:41.727Z', 1],
      ['2026-10-09T12:10:52.221Z', 2],
      ['2026-10-09T12:13:55.000Z', 1],
    ]);

    const delivered = logged
      .map(({ line }) => line.match(/queued reading from (\S+) delivered/)?.[1])
      .filter((x): x is string => x !== undefined);
    expect(delivered).toEqual([A, B, C]);
    expect(fs.existsSync(file)).toBe(false);
  });
});
