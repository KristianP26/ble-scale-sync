import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  loadQueue,
  saveQueue,
  enqueue,
  flushQueue,
  resolveExportQueuePath,
  describeQueue,
  logQueueAtStartup,
  type QueuedExport,
} from '../../src/runtime/export-queue.js';
import type { Exporter } from '../../src/interfaces/exporter.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

const PAYLOAD = { weight: 80, bodyFatPercent: 20 } as unknown as BodyComposition;
/**
 * Name lookup over a fixed list, for the cases below that only exercise queue
 * mechanics. Real callers resolve through the entry's OWN user first - see the
 * wrong-account test, which is what that distinction is for.
 */
function lookupIn(...exporters: Exporter[]) {
  return (e: QueuedExport) => exporters.find((x) => x.name === e.exporter);
}

const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

function entry(over: Partial<QueuedExport> = {}): QueuedExport {
  return {
    exporter: 'garmin',
    payload: PAYLOAD,
    // An hour back, so a first retry is due: the fixture is about queue
    // mechanics, not about the spacing between attempts (E-01).
    queuedAt: new Date(NOW - 60 * 60_000).toISOString(),
    attempts: 0,
    ...over,
  };
}

function fakeExporter(
  name: string,
  behaviour: () => Promise<{ success: boolean; error?: string }>,
) {
  return {
    name,
    supportsBackdate: true,
    export: vi.fn(behaviour),
  } as unknown as Exporter;
}

describe('export retry queue (#412)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-'));
    file = path.join(dir, 'queue.jsonl');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('round-trips an entry', () => {
    saveQueue(file, [entry()]);
    const loaded = loadQueue(file, NOW);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].exporter).toBe('garmin');
  });

  it('writes the file 0600, because it holds body composition and a name', () => {
    saveQueue(file, [entry({ userName: 'Kristian' })]);
    // Windows does not model POSIX permission bits, so assert only where it means something.
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(file, 'utf-8')).toContain('Kristian');
  });

  it('deletes the file when it drains, so health data does not linger', () => {
    saveQueue(file, [entry()]);
    expect(fs.existsSync(file)).toBe(true);
    saveQueue(file, []);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('drops an entry older than the age bound', () => {
    saveQueue(file, [entry({ queuedAt: new Date(NOW - 73 * 60 * 60 * 1000).toISOString() })]);
    expect(loadQueue(file, NOW)).toHaveLength(0);
  });

  it('drops an entry that has already used its attempts', () => {
    saveQueue(file, [entry({ attempts: 5 })]);
    expect(loadQueue(file, NOW)).toHaveLength(0);
  });

  it('caps the queue and drops the oldest first', () => {
    const many = Array.from({ length: 60 }, (_, i) => entry({ lastError: `e${i}` }));
    saveQueue(file, many);
    enqueue(file, entry({ lastError: 'newest' }), NOW);

    const loaded = loadQueue(file, NOW);
    expect(loaded).toHaveLength(50);
    expect(loaded[loaded.length - 1].lastError).toBe('newest');
    expect(loaded.some((e) => e.lastError === 'e0')).toBe(false);
  });

  // E-19: the log counted the entries before the cap and could report 51.
  it('reports the capped count when the queue is full', () => {
    saveQueue(
      file,
      Array.from({ length: 50 }, () => entry()),
    );
    enqueue(file, entry(), NOW);
    const lines = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('(50 waiting)'))).toBe(true);
  });

  // E-19: NaN never exceeds the age bound, so such an entry could never age out.
  it('skips an entry whose queuedAt cannot be parsed', () => {
    saveQueue(file, [entry({ queuedAt: 'not a date' }), entry()]);
    expect(loadQueue(file, NOW)).toHaveLength(1);
  });

  it('skips an unreadable line instead of losing the file', () => {
    fs.writeFileSync(file, `${JSON.stringify(entry())}\nnot json\n${JSON.stringify(entry())}\n`);
    expect(loadQueue(file, NOW)).toHaveLength(2);
  });

  it('delivers a queued reading and removes it', async () => {
    saveQueue(file, [entry({ timestamp: '2026-09-08T06:00:00.000Z', userSlug: 'k' })]);
    const garmin = fakeExporter('garmin', async () => ({ success: true }));

    const result = await flushQueue(file, lookupIn(garmin), NOW);

    expect(result.delivered).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    // The measured time is what makes a late delivery honest.
    const context = (garmin.export as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1];
    expect((context as { timestamp: Date }).timestamp.toISOString()).toBe(
      '2026-09-08T06:00:00.000Z',
    );
  });

  it('keeps a failed entry with its attempt count raised', async () => {
    saveQueue(file, [entry()]);
    const garmin = fakeExporter('garmin', async () => ({ success: false, error: 'still down' }));

    const result = await flushQueue(file, lookupIn(garmin), NOW);

    expect(result.failed).toBe(1);
    const loaded = loadQueue(file, NOW);
    expect(loaded[0].attempts).toBe(1);
    expect(loaded[0].lastError).toContain('still down');
  });

  it('gives up on the last attempt rather than keeping a dead entry forever', async () => {
    saveQueue(file, [
      entry({
        attempts: 4,
        queuedAt: new Date(NOW - 71 * HOUR).toISOString(),
        lastAttemptAt: new Date(NOW - 48 * HOUR).toISOString(),
      }),
    ]);
    const garmin = fakeExporter('garmin', async () => ({ success: false, error: 'nope' }));

    const result = await flushQueue(file, lookupIn(garmin), NOW);

    expect(result.dropped).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('drops an entry whose exporter is no longer configured', async () => {
    saveQueue(file, [entry({ exporter: 'wger' })]);
    const result = await flushQueue(
      file,
      lookupIn(fakeExporter('garmin', async () => ({ success: true }))),
      NOW,
    );
    expect(result.dropped).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps an entry whose exporter cannot be built instead of deleting it (E-08)', async () => {
    // The entry is taken off disk before the lookup, and building an exporter
    // from a config entry the operator just broke throws. That throw used to
    // escape the flush with the entry already gone.
    saveQueue(file, [entry(), entry({ exporter: 'wger' })]);
    const wger = fakeExporter('wger', async () => ({ success: true }));
    const lookup = (e: QueuedExport): Exporter | undefined => {
      if (e.exporter === 'garmin') throw new Error('garmin: upload_timeout_sec must be >= 30');
      return wger;
    };

    const outcome = await flushQueue(file, lookup, NOW).catch((err: unknown) => err);

    const loaded = loadQueue(file, NOW);
    expect(loaded.map((e) => e.exporter)).toEqual(['garmin']);
    // A config problem says nothing about the target, so no attempt is spent.
    expect(loaded[0].attempts).toBe(0);
    expect(wger.export).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ delivered: 1, failed: 1, dropped: 0 });
  });

  it('does not deliver an entry twice when one of several fails', async () => {
    saveQueue(file, [entry({ lastError: 'a' }), entry({ exporter: 'wger', lastError: 'b' })]);
    const garmin = fakeExporter('garmin', async () => ({ success: true }));
    const wger = fakeExporter('wger', async () => ({ success: false, error: 'down' }));

    await flushQueue(file, lookupIn(garmin, wger), NOW);

    expect(garmin.export).toHaveBeenCalledTimes(1);
    const loaded = loadQueue(file, NOW);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].exporter).toBe('wger');
  });

  it('resolves its path next to the config file', () => {
    const resolved = resolveExportQueuePath(path.join(dir, 'config.yaml'));
    // Same directory as the config, which is the one place writable and
    // persistent on every deployment target. Both sides go through realpath:
    // the resolver does not follow symlinks, and on macOS the temp dir under
    // /var is a symlink to /private/var.
    expect(fs.realpathSync(path.dirname(resolved))).toBe(fs.realpathSync(dir));
    expect(path.basename(resolved)).toBe('.export-retry-queue.jsonl');
  });
});

describe('export retry queue: the cases that could lose a reading (#412)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-edge-'));
    file = path.join(dir, 'queue.jsonl');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not discard entries it never attempted when the file is oversized', async () => {
    // A file with more than the write-path cap: hand-edited, or written by a
    // version with a bigger bound. Capping on READ would delete readings that
    // were never even tried.
    const many = Array.from({ length: 60 }, (_, i) =>
      entry({ exporter: 'garmin', lastError: `e${i}` }),
    );
    saveQueue(file, many);
    expect(loadQueue(file, NOW)).toHaveLength(60);

    const garmin = fakeExporter('garmin', async () => ({ success: true }));
    const result = await flushQueue(file, lookupIn(garmin), NOW);
    expect(result.delivered).toBe(60);
  });

  it('takes an entry off disk before attempting it, so a crash cannot duplicate it', async () => {
    saveQueue(file, [entry({ lastError: 'first' }), entry({ lastError: 'second' })]);
    const seenDuringFirstExport: string[] = [];

    let call = 0;
    const garmin = fakeExporter('garmin', async () => {
      call += 1;
      if (call === 1) {
        // What is on disk while the first entry is in flight: the second only.
        for (const line of fs.readFileSync(file, 'utf-8').trim().split(String.fromCharCode(10))) {
          seenDuringFirstExport.push((JSON.parse(line) as { lastError?: string }).lastError ?? '');
        }
      }
      return { success: true };
    });

    await flushQueue(file, lookupIn(garmin), NOW);

    expect(seenDuringFirstExport).toEqual(['second']);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps a failure and still delivers the entry after it', async () => {
    // The reverse order of the other multi-entry test: `keep` accumulates, so
    // a failure first must not swallow the success behind it.
    saveQueue(file, [entry({ exporter: 'wger' }), entry({ exporter: 'garmin' })]);
    const wger = fakeExporter('wger', async () => ({ success: false, error: 'down' }));
    const garmin = fakeExporter('garmin', async () => ({ success: true }));

    const result = await flushQueue(file, lookupIn(wger, garmin), NOW);

    expect(result).toMatchObject({ delivered: 1, failed: 1 });
    const left = loadQueue(file, NOW);
    expect(left).toHaveLength(1);
    expect(left[0].exporter).toBe('wger');
  });

  it('delivers a queued reading through the exporter of ITS OWN user', async () => {
    // Two users, each with their own Garmin account. Both instances answer to
    // the name 'garmin' - `name` is the exporter TYPE, a class constant - so a
    // name-keyed union across users silently picked whichever came first and
    // uploaded one user's weigh-in into the other's account.
    const seen: string[] = [];
    const annaGarmin = fakeExporter('garmin', async () => {
      seen.push('anna-account');
      return { success: true };
    });
    const petrGarmin = fakeExporter('garmin', async () => {
      seen.push('petr-account');
      return { success: true };
    });
    const perUser: Record<string, Exporter[]> = { anna: [annaGarmin], petr: [petrGarmin] };

    saveQueue(file, [entry({ userSlug: 'petr', userName: 'Petr' })]);

    const result = await flushQueue(
      file,
      (e) => (e.userSlug ? (perUser[e.userSlug] ?? []) : []).find((x) => x.name === e.exporter),
      NOW,
    );

    expect(seen).toEqual(['petr-account']);
    expect(annaGarmin.export).not.toHaveBeenCalled();
    expect(result.delivered).toBe(1);
  });

  it('drops an entry whose user is gone rather than falling back to another', async () => {
    const annaGarmin = fakeExporter('garmin', async () => ({ success: true }));
    const perUser: Record<string, Exporter[]> = { anna: [annaGarmin] };
    saveQueue(file, [entry({ userSlug: 'deleted-user' })]);

    const result = await flushQueue(
      file,
      (e) => (e.userSlug ? (perUser[e.userSlug] ?? []) : []).find((x) => x.name === e.exporter),
      NOW,
    );

    expect(annaGarmin.export).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: 0, dropped: 1 });
  });
});

/**
 * E-01: the attempt budget used to be spent per loop iteration, not per unit
 * of time. ADR D014 sets 72 h / 5 attempts and says the age bound is the one
 * that decides in practice, but with a flush at the start of every scan cycle
 * (about two minutes on node-ble) the fifth failure landed some ten minutes
 * after the first, and an overnight outage still cost the reading.
 */
describe('export retry queue: attempts are spaced in time (E-01)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-spacing-'));
    file = path.join(dir, 'queue.jsonl');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not spend an attempt on an entry whose retry is not due yet', async () => {
    // Queued a few seconds ago, which is exactly where the watcher transports
    // used to burn the first retry: the next iteration starts right after the
    // failed dispatch.
    saveQueue(file, [entry({ queuedAt: new Date(NOW - 5_000).toISOString() })]);
    const garmin = fakeExporter('garmin', async () => ({ success: false, error: 'down' }));

    await flushQueue(file, lookupIn(garmin), NOW);

    expect(garmin.export).not.toHaveBeenCalled();
    expect(loadQueue(file, NOW)[0].attempts).toBe(0);
  });

  it('keeps an entry alive across a long outage at poll cadence, then delivers it', async () => {
    const t0 = NOW;
    saveQueue(file, [entry({ queuedAt: new Date(t0).toISOString() })]);
    let targetUp = false;
    const garmin = fakeExporter('garmin', async () =>
      targetUp ? { success: true } : { success: false, error: 'ENOTFOUND' },
    );

    // A flush every two minutes, the node-ble idle cadence, for a full day
    // with the target down the whole time.
    for (let t = t0; t <= t0 + 24 * HOUR; t += 2 * MIN) {
      await flushQueue(file, lookupIn(garmin), t);
    }
    const afterOutage = loadQueue(file, t0 + 24 * HOUR);
    expect(afterOutage).toHaveLength(1);
    expect(afterOutage[0].attempts).toBeLessThan(5);

    // The target is back on day two. The reading must still get through
    // before the 72 h age bound retires it.
    targetUp = true;
    let delivered = 0;
    for (let t = t0 + 24 * HOUR; t <= t0 + 72 * HOUR; t += 2 * MIN) {
      delivered += (await flushQueue(file, lookupIn(garmin), t)).delivered;
    }
    expect(delivered).toBe(1);
  });
});

/**
 * E-02: the flush no longer blocks the scan, so a live weigh-in can fail and
 * be queued while a flush is still waiting on an earlier upload. The flush
 * used to finish by writing its own in-memory view back, which erased that
 * newly queued reading.
 */
describe('export retry queue: concurrent enqueue during a flush (E-02)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-concurrent-'));
    file = path.join(dir, 'queue.jsonl');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps a reading queued while the flush was waiting on an export', async () => {
    saveQueue(file, [entry({ lastError: 'old' })]);
    const live = entry({
      exporter: 'file',
      queuedAt: new Date(NOW).toISOString(),
      lastError: 'live',
    });
    const garmin = fakeExporter('garmin', async () => {
      // The live dispatch fails and queues its reading mid-flush.
      enqueue(file, live, NOW);
      return { success: false, error: 'slow server' };
    });

    await flushQueue(file, lookupIn(garmin), NOW);

    const left = loadQueue(file, NOW);
    expect(left.map((e) => e.lastError).sort()).toEqual(['live', 'slow server']);
  });

  it('keeps a reading queued mid-flush even when the flush empties its own entries', async () => {
    saveQueue(file, [entry()]);
    const live = entry({ exporter: 'file', queuedAt: new Date(NOW).toISOString() });
    const garmin = fakeExporter('garmin', async () => {
      enqueue(file, live, NOW);
      return { success: true };
    });

    const result = await flushQueue(file, lookupIn(garmin), NOW);

    expect(result.delivered).toBe(1);
    const left = loadQueue(file, NOW);
    expect(left).toHaveLength(1);
    expect(left[0].exporter).toBe('file');
  });
});

describe('export retry queue: two exporters of one type (D029) and shutdown (E-10)', () => {
  let dir: string;
  let file: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-d029-'));
    file = path.join(dir, 'queue.jsonl');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps a mid-flush entry that differs from one being flushed only in its slot', async () => {
    // Two webhooks of one user failing on one reading in one millisecond: same
    // type, user, queuedAt and timestamp. Without the slot in the identity the
    // re-read took the second for the first and the next write dropped it.
    const shared = { exporter: 'webhook', userSlug: 'dad', timestamp: '2026-09-09T07:00:00.000Z' };
    saveQueue(file, [entry({ ...shared, exporterList: 'global', exporterIndex: 0 })]);
    const sibling = entry({ ...shared, exporterList: 'global', exporterIndex: 1 });
    const webhook = fakeExporter('webhook', async () => {
      enqueue(file, sibling, NOW);
      return { success: true };
    });

    await flushQueue(file, lookupIn(webhook), NOW);

    const left = loadQueue(file, NOW);
    expect(left).toHaveLength(1);
    expect(left[0].exporterIndex).toBe(1);
  });

  it('starts nothing once the app is stopping, and keeps every entry on disk', async () => {
    saveQueue(file, [entry(), entry({ exporter: 'file' })]);
    const garmin = fakeExporter('garmin', async () => ({ success: true }));
    const ac = new AbortController();
    ac.abort();

    const result = await flushQueue(file, lookupIn(garmin), NOW, ac.signal);

    expect(garmin.export).not.toHaveBeenCalled();
    expect(result.delivered).toBe(0);
    expect(loadQueue(file, NOW)).toHaveLength(2);
  });

  it('names the entry in flight when the app is told to stop during its attempt', async () => {
    saveQueue(file, [
      entry({ userSlug: 'dad', timestamp: '2026-09-09T07:00:00.000Z' }),
      entry({ exporter: 'file' }),
    ]);
    const ac = new AbortController();
    const garmin = fakeExporter('garmin', async () => {
      ac.abort();
      return { success: true };
    });
    const fileExp = fakeExporter('file', async () => ({ success: true }));

    await flushQueue(file, lookupIn(garmin, fileExp), NOW, ac.signal);

    const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).join(' | ');
    expect(lines).toMatch(
      /Shutdown requested while retrying a queued garmin export for 'dad' measured at 2026-09-09T07:00:00\.000Z/,
    );
    // The next entry is not started under a shutdown, and stays queued.
    expect(fileExp.export).not.toHaveBeenCalled();
    expect(loadQueue(file, NOW).map((e) => e.exporter)).toEqual(['file']);
  });
});

/**
 * #460: "Retrying 2" counted only the entries that were due, and nothing at
 * INFO said a third was still waiting or when, so a partial pass right after
 * a restart read exactly like a queue that had lost an entry.
 */
describe('export retry queue: the log says what waits and when (#460)', () => {
  let dir: string;
  let file: string;
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  const linesOf = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c) => c.map(String).join(' '));

  // The reporter's three entries after their first retries.
  const A = '2026-10-09T11:10:03.643Z';
  const B = '2026-10-09T11:10:07.596Z';
  const C = '2026-10-09T11:10:59.620Z';
  const reporterQueue = (): QueuedExport[] => [
    entry({ queuedAt: A, attempts: 1, lastAttemptAt: '2026-10-09T11:25:22.851Z' }),
    entry({ queuedAt: B, attempts: 1, lastAttemptAt: '2026-10-09T11:25:22.851Z' }),
    entry({ queuedAt: C, attempts: 1, lastAttemptAt: '2026-10-09T11:28:41.727Z' }),
  ];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-log-'));
    file = path.join(dir, 'queue.jsonl');
    info = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('says how many of how many it retries, and when the rest is due', async () => {
    saveQueue(file, reporterQueue());
    const garmin = fakeExporter('garmin', async () => ({ success: true }));

    await flushQueue(file, lookupIn(garmin), Date.parse('2026-10-09T12:10:52.221Z'));

    const lines = linesOf(info).join(' | ');
    expect(lines).toContain('Retrying 2 of 3 queued export(s)...');
    expect(lines).toContain(
      '1 queued export(s) still waiting; next retry not before 2026-10-09T12:13:41.727Z.',
    );
  });

  it('says "on the next cycle" rather than a time in the past for an entry already due', async () => {
    // A lookup that throws keeps the entry without spending an attempt (E-08),
    // so it is due again at once.
    saveQueue(file, [entry()]);
    const lookup = (): Exporter => {
      throw new Error('garmin: upload_timeout_sec must be >= 30');
    };

    await flushQueue(file, lookup, NOW);

    expect(linesOf(info).join(' | ')).toContain(
      '1 queued export(s) still waiting; next retry on the next cycle.',
    );
  });

  it('describes the queue at startup, and nothing for an empty one', () => {
    expect(describeQueue(file, NOW)).toBeUndefined();
    saveQueue(file, reporterQueue());
    expect(describeQueue(file, Date.parse('2026-10-09T11:41:07.000Z'))).toBe(
      '3 queued export(s) waiting; next retry not before 2026-10-09T12:10:22.851Z.',
    );
  });

  // The startup line went out under run.ts's [Sync] prefix, so a search for the
  // queue's [Retry] lines, the first thing to read after a restart, missed it.
  it('logs the startup summary under the [Retry] prefix, with a note in a dry run', () => {
    logQueueAtStartup(file, false, NOW);
    expect(info).not.toHaveBeenCalled();

    saveQueue(file, reporterQueue());
    const at = Date.parse('2026-10-09T11:41:07.000Z');
    logQueueAtStartup(file, false, at);
    logQueueAtStartup(file, true, at);

    const lines = linesOf(info);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /\[Retry\] 3 queued export\(s\) waiting; next retry not before 2026-10-09T12:10:22\.851Z\.$/,
    );
    expect(lines[1]).toMatch(
      /\[Retry\] 3 queued export\(s\) waiting; .* Not retried in a dry run\.$/,
    );
  });

  it('warns once, by name, when an entry ages out', async () => {
    saveQueue(file, [
      entry({
        queuedAt: new Date(NOW - 73 * HOUR).toISOString(),
        lastAttemptAt: new Date(NOW - 2 * HOUR).toISOString(),
        attempts: 4,
        timestamp: '2026-09-06T10:59:00.000Z',
        userSlug: 'martin',
      }),
      // Not due, so the pass attempts nothing and only the pruning is written.
      entry({ queuedAt: new Date(NOW - 5 * MIN).toISOString() }),
    ]);
    const garmin = fakeExporter('garmin', async () => ({ success: true }));

    await flushQueue(file, lookupIn(garmin), NOW);
    await flushQueue(file, lookupIn(garmin), NOW + 2 * MIN);

    const dropped = linesOf(warn).filter((l) => l.includes('Dropping a queued'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain(
      "garmin export for 'martin' measured at 2026-09-06T10:59:00.000Z (80.00 kg): older than 72 h",
    );
    expect(garmin.export).not.toHaveBeenCalled();
    expect(loadQueue(file, NOW)).toHaveLength(1);
  });

  it('warns when it skips an unreadable line', async () => {
    fs.writeFileSync(
      file,
      `not json\n${JSON.stringify(entry({ queuedAt: new Date(NOW - 5 * MIN).toISOString() }))}\n`,
    );

    await flushQueue(file, lookupIn(), NOW);

    expect(linesOf(warn).join(' | ')).toContain(
      'Skipping an unreadable line in the retry queue; a queued reading may be lost.',
    );
  });
});
