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
  type QueuedExport,
} from '../../src/runtime/export-queue.js';
import type { Exporter } from '../../src/interfaces/exporter.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

const PAYLOAD = { weight: 80, bodyFatPercent: 20 } as unknown as BodyComposition;
const NOW = Date.parse('2026-09-09T12:00:00.000Z');

function entry(over: Partial<QueuedExport> = {}): QueuedExport {
  return {
    exporter: 'garmin',
    payload: PAYLOAD,
    queuedAt: new Date(NOW - 60_000).toISOString(),
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

  it('skips an unreadable line instead of losing the file', () => {
    fs.writeFileSync(file, `${JSON.stringify(entry())}\nnot json\n${JSON.stringify(entry())}\n`);
    expect(loadQueue(file, NOW)).toHaveLength(2);
  });

  it('delivers a queued reading and removes it', async () => {
    saveQueue(file, [entry({ timestamp: '2026-09-08T06:00:00.000Z', userSlug: 'k' })]);
    const garmin = fakeExporter('garmin', async () => ({ success: true }));

    const result = await flushQueue(file, [garmin], NOW);

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

    const result = await flushQueue(file, [garmin], NOW);

    expect(result.failed).toBe(1);
    const loaded = loadQueue(file, NOW);
    expect(loaded[0].attempts).toBe(1);
    expect(loaded[0].lastError).toContain('still down');
  });

  it('gives up on the last attempt rather than keeping a dead entry forever', async () => {
    saveQueue(file, [entry({ attempts: 4 })]);
    const garmin = fakeExporter('garmin', async () => ({ success: false, error: 'nope' }));

    const result = await flushQueue(file, [garmin], NOW);

    expect(result.dropped).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('drops an entry whose exporter is no longer configured', async () => {
    saveQueue(file, [entry({ exporter: 'wger' })]);
    const result = await flushQueue(
      file,
      [fakeExporter('garmin', async () => ({ success: true }))],
      NOW,
    );
    expect(result.dropped).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('does not deliver an entry twice when one of several fails', async () => {
    saveQueue(file, [entry({ lastError: 'a' }), entry({ exporter: 'wger', lastError: 'b' })]);
    const garmin = fakeExporter('garmin', async () => ({ success: true }));
    const wger = fakeExporter('wger', async () => ({ success: false, error: 'down' }));

    await flushQueue(file, [garmin, wger], NOW);

    expect(garmin.export).toHaveBeenCalledTimes(1);
    const loaded = loadQueue(file, NOW);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].exporter).toBe('wger');
  });

  it('resolves its path next to the config file', () => {
    const resolved = resolveExportQueuePath(path.join(dir, 'config.yaml'));
    // Same directory as the config, which is the one place writable and
    // persistent on every deployment target.
    expect(path.dirname(resolved)).toBe(fs.realpathSync(dir));
    expect(path.basename(resolved)).toBe('.export-retry-queue.jsonl');
  });
});
