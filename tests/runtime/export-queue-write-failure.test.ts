import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A full disk or a read-only directory, injected rather than simulated with
// permissions, so this runs the same on every platform.
const h = vi.hoisted(() => ({ shouldThrow: false }));
vi.mock('../../src/config/write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/write.js')>();
  return {
    ...actual,
    atomicWrite: (file: string, content: string) => {
      if (h.shouldThrow) throw new Error('ENOSPC: no space left on device');
      return actual.atomicWrite(file, content);
    },
  };
});

const { saveQueue, flushQueue } = await import('../../src/runtime/export-queue.js');
import type { Exporter } from '../../src/interfaces/exporter.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

const NOW = Date.parse('2026-09-09T12:00:00.000Z');

/**
 * #412: the at-most-once guarantee rests on the entry being off disk before it
 * is attempted. If that write fails and the attempt goes ahead anyway, the file
 * still holds the entry and the next flush delivers the same reading again.
 */
describe('export queue when the file cannot be written', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-nospc-'));
    file = path.join(dir, 'queue.jsonl');
    h.shouldThrow = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    h.shouldThrow = false;
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
      queuedAt: new Date(NOW - 60_000).toISOString(),
      attempts: 0,
    });
    saveQueue(file, [queued(80), queued(81)]);

    const garmin = {
      name: 'garmin',
      supportsBackdate: true,
      export: vi.fn(async () => ({ success: true })),
    } as unknown as Exporter;

    h.shouldThrow = true;
    const result = await flushQueue(file, [garmin], NOW);

    expect(garmin.export).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: 0, failed: 0, dropped: 0 });
    // The entry is still there for the next cycle, which is the point.
    h.shouldThrow = false;
    expect(fs.readFileSync(file, 'utf-8')).toContain('garmin');
  });
});
