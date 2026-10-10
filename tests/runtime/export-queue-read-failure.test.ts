import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

// A failing read of the queue file (EIO on a dying SD card, a file owned by
// another UID after an image update), injected rather than simulated with
// permissions, so this runs the same on every platform.
const h = vi.hoisted(() => ({ failPath: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (h.failPath && String(file) === h.failPath) {
      throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    }
    return (actual.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const fs = await import('node:fs');
const { saveQueue, enqueue, flushQueue, _resetExportQueueStateForTests } =
  await import('../../src/runtime/export-queue.js');
import type { QueuedExport } from '../../src/runtime/export-queue.js';
import type { Exporter } from '../../src/interfaces/exporter.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');

function entry(weight: number, over: Partial<QueuedExport> = {}): QueuedExport {
  return {
    exporter: 'garmin',
    payload: { weight } as unknown as BodyComposition,
    timestamp: new Date(NOW - 60 * 60_000 - weight).toISOString(),
    userSlug: 'martin',
    // Due for a first retry, so only the read failure can stop an attempt.
    queuedAt: new Date(NOW - 60 * 60_000).toISOString(),
    attempts: 0,
    ...over,
  };
}

/**
 * #460 review: a failed read came back as an empty queue, and both callers
 * acted on "empty". The flush deleted the file and enqueue replaced it with
 * the one new entry, so one EIO erased every queued reading, logged at debug.
 */
describe('export queue when the file cannot be read', () => {
  let dir: string;
  let file: string;
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-eio-'));
    file = path.join(dir, 'queue.jsonl');
    h.failPath = '';
    _resetExportQueueStateForTests();
    info = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    saveQueue(file, [entry(80.1), entry(80.2), entry(80.3)]);
  });

  afterEach(() => {
    h.failPath = '';
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const linesOf = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c) => c.map(String).join(' '));

  it('flush leaves the file alone, attempts nothing, and warns once', async () => {
    const before = fs.readFileSync(file, 'utf-8');
    const garmin = {
      name: 'garmin',
      supportsBackdate: true,
      export: vi.fn(async () => ({ success: true })),
    } as unknown as Exporter;

    h.failPath = file;
    const first = await flushQueue(file, () => garmin, NOW);
    await flushQueue(file, () => garmin, NOW + 120_000);
    h.failPath = '';

    expect(first).toEqual({ delivered: 0, failed: 0, dropped: 0 });
    expect(garmin.export).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    // A permanently unreadable file would otherwise warn on every cycle.
    const warned = linesOf(warn).filter((l) => l.includes('Could not read the retry queue'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('EIO');
  });

  it('enqueue does not overwrite the file, and names the reading it could not queue', () => {
    h.failPath = file;
    enqueue(
      file,
      entry(81.25, {
        timestamp: '2026-10-09T11:59:00.000Z',
        queuedAt: new Date(NOW).toISOString(),
      }),
      NOW,
    );
    h.failPath = '';

    // The three already queued are intact; the new one is lost, but by name.
    const onDisk = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(onDisk).toHaveLength(3);
    const warned = linesOf(warn).join(' | ');
    expect(warned).toMatch(
      /garmin export for 'martin' measured at 2026-10-09T11:59:00\.000Z \(81\.25 kg\) is NOT queued/,
    );
    expect(linesOf(info).some((l) => l.includes('queued and will be retried'))).toBe(false);
  });
});
