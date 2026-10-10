import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A full disk or a read-only directory, injected rather than simulated with
// permissions, so this runs the same on every platform.
// `failOnWrite` fails only the Nth write from the moment it is set, for a pass
// whose first write works and a later one does not.
const h = vi.hoisted(() => ({ shouldThrow: false, failOnWrite: 0, writes: 0 }));
vi.mock('../../src/config/write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/write.js')>();
  return {
    ...actual,
    atomicWrite: (file: string, content: string) => {
      h.writes += 1;
      if (h.shouldThrow || (h.failOnWrite > 0 && h.writes === h.failOnWrite)) {
        throw new Error('ENOSPC: no space left on device');
      }
      return actual.atomicWrite(file, content);
    },
  };
});

const { saveQueue, flushQueue, enqueue, loadQueue } =
  await import('../../src/runtime/export-queue.js');
import type { QueuedExport } from '../../src/runtime/export-queue.js';
import type { Exporter } from '../../src/interfaces/exporter.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

/**
 * Name lookup over a fixed list, for the cases below that only exercise queue
 * mechanics. Real callers resolve through the entry's OWN user first - see the
 * wrong-account test, which is what that distinction is for.
 */
function lookupIn(...exporters: Exporter[]) {
  return (e: QueuedExport) => exporters.find((x) => x.name === e.exporter);
}

const NOW = Date.parse('2026-09-09T12:00:00.000Z');

/**
 * #412: the at-most-once guarantee rests on the entry being off disk before it
 * is attempted. If that write fails and the attempt goes ahead anyway, the file
 * still holds the entry and the next flush delivers the same reading again.
 */
describe('export queue when the file cannot be written', () => {
  let dir: string;
  let file: string;
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  const linesOf = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c) => c.map(String).join(' '));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-nospc-'));
    file = path.join(dir, 'queue.jsonl');
    h.shouldThrow = false;
    h.failOnWrite = 0;
    h.writes = 0;
    info = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    h.shouldThrow = false;
    h.failOnWrite = 0;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('attempts nothing, rather than delivering from a file that still holds it', async () => {
    // Two entries, so removing the first means WRITING the remainder rather
    // than deleting the file. With a single entry the removal is an unlink,
    // which is a different path and cannot duplicate anything.
    const queued = (weight: number) => ({
      exporter: 'garmin',
      payload: { weight } as unknown as BodyComposition,
      // Due for a retry, so the write failure is the only thing that can stop
      // the attempt (E-01 spaces attempts in time).
      queuedAt: new Date(NOW - 60 * 60_000).toISOString(),
      attempts: 0,
    });
    saveQueue(file, [queued(80), queued(81)]);

    const garmin = {
      name: 'garmin',
      supportsBackdate: true,
      export: vi.fn(async () => ({ success: true })),
    } as unknown as Exporter;

    h.shouldThrow = true;
    const result = await flushQueue(file, lookupIn(garmin), NOW);

    expect(garmin.export).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: 0, failed: 0, dropped: 0 });
    // The entry is still there for the next cycle, which is the point.
    h.shouldThrow = false;
    expect(fs.readFileSync(file, 'utf-8')).toContain('garmin');
  });

  // #460 review: the write failure was logged, and the very next line said the
  // reading was queued, with nothing on disk.
  it('does not claim a reading is queued when writing it failed, and names it', () => {
    h.shouldThrow = true;
    enqueue(
      file,
      {
        exporter: 'garmin',
        payload: { weight: 80.1 } as unknown as BodyComposition,
        timestamp: '2026-09-09T11:59:00.000Z',
        userSlug: 'martin',
        queuedAt: new Date(NOW).toISOString(),
        attempts: 0,
      },
      NOW,
    );
    h.shouldThrow = false;

    expect(fs.existsSync(file)).toBe(false);
    expect(linesOf(info).some((l) => l.includes('queued and will be retried'))).toBe(false);
    expect(linesOf(warn).join(' | ')).toMatch(
      /garmin export for 'martin' measured at 2026-09-09T11:59:00\.000Z \(80\.10 kg\) is NOT queued/,
    );
  });

  // #460 review: a write that fails mid-pass stopped the pass with "nothing is
  // attempted", while the entry that had just failed existed only in memory
  // and vanished without a name.
  it('names an entry that failed this pass when the next write fails', async () => {
    const queued = (weight: number, timestamp: string) => ({
      exporter: 'garmin',
      payload: { weight } as unknown as BodyComposition,
      timestamp,
      userSlug: 'martin',
      queuedAt: new Date(NOW - 60 * 60_000).toISOString(),
      attempts: 0,
    });
    saveQueue(file, [
      queued(80.1, '2026-09-09T10:59:00.000Z'),
      queued(81.2, '2026-09-09T10:59:30.000Z'),
    ]);
    const garmin = {
      name: 'garmin',
      supportsBackdate: true,
      export: vi.fn(async () => ({ success: false, error: 'no Garmin token' })),
    } as unknown as Exporter;

    // Write 1 takes A off disk before its attempt; write 2, before B, fails.
    h.writes = 0;
    h.failOnWrite = 2;
    await flushQueue(file, lookupIn(garmin), NOW);
    h.failOnWrite = 0;

    expect(garmin.export).toHaveBeenCalledTimes(1);
    // B was never attempted and is still on disk; A is not.
    expect(loadQueue(file, NOW).map((e) => e.timestamp)).toEqual(['2026-09-09T10:59:30.000Z']);
    const warned = linesOf(warn).join(' | ');
    expect(warned).not.toContain('nothing is attempted');
    expect(warned).toMatch(
      /Stopping the retry pass.*garmin export for 'martin' measured at 2026-09-09T10:59:00\.000Z \(80\.10 kg\)/,
    );
  });
});
