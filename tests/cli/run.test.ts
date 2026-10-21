import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The run path as src/index.ts calls it (architecture audit 2026-10-21, C-12
 * and R-02). Before run(argv) the module started the app when imported, so
 * nothing here could be tested; tests/runtime/sources.test.ts still pins some
 * of its wiring by text.
 *
 * The scan and the process-wide heartbeats are mocked; config loading, the
 * context, the adapter registry and the forced-adapter check are real.
 * process.exit throws, so a test sees the code and the run stops there.
 */

const runSingleShot = vi.fn<() => Promise<boolean>>();
vi.mock(import('../../src/runtime/single-run.js'), () => ({ runSingleShot }));
vi.mock(import('../../src/runtime/poll-source.js'), () => ({
  PollReadingSource: vi.fn() as never,
}));
const heartbeat = { stop: vi.fn(), stopFile: vi.fn() };
vi.mock(import('../../src/runtime/systemd-watchdog.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  notifyReady: vi.fn(),
  startHeartbeat: vi.fn(),
  stopHeartbeat: heartbeat.stop,
}));
vi.mock(import('../../src/runtime/file-heartbeat.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  startFileHeartbeat: vi.fn(),
  stopFileHeartbeat: heartbeat.stopFile,
}));

const { run } = await import('../../src/run.js');

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const USER = `
users:
  - name: Dad
    slug: dad
    height: 183
    birth_date: '1990-06-15'
    gender: male
    is_athlete: false
    weight_range: { min: 75, max: 95 }
runtime:
  dry_run: true
`;

// The listeners run() adds; `as` because the typings split signals from events.
const EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'unhandledRejection'] as NodeJS.Signals[];

let dir = '';
let exit: ReturnType<typeof vi.spyOn>;
let errors: string[];
let before: Map<string, unknown[]>;

function configWith(extra: string): string {
  const path = join(dir, 'config.yaml');
  writeFileSync(path, `version: 1\n${USER}${extra}`);
  return path;
}

describe('run(argv)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bss-run-'));
    before = new Map(EVENTS.map((e) => [e, process.listeners(e)]));
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
    errors = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    runSingleShot.mockReset();
    heartbeat.stop.mockReset();
    heartbeat.stopFile.mockReset();
  });

  afterEach(() => {
    for (const e of EVENTS) {
      for (const l of process.listeners(e)) {
        if (!before.get(e)!.includes(l)) process.removeListener(e, l as () => void);
      }
    }
    process.exitCode = undefined;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('importing it starts nothing', () => {
    expect(exit).not.toHaveBeenCalled();
    expect(runSingleShot).not.toHaveBeenCalled();
  });

  it('exits 2 on a bad flag before loading any config (G-16)', async () => {
    await expect(run(['--bogus'])).rejects.toThrow(ExitCalled);
    expect(exit).toHaveBeenCalledWith(2);
    expect(errors[0]).toMatch(/Unknown option '--bogus'/);
  });

  it('throws a config error to the caller, which prints it and exits 1', async () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'version: 1\nusers: []\n');
    await expect(run(['--config', path])).rejects.toThrow(/At least one user is required/);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits 1 when a forced adapter has no scale MAC', async () => {
    await run(['--config', configWith('ble:\n  force_scale_adapter: QN Scale\n')]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.some((l) => l.includes('ble.force_scale_adapter requires a scale MAC'))).toBe(
      true,
    );
    expect(runSingleShot).not.toHaveBeenCalled();
  });

  it('exits 1 when the forced adapter does not exist', async () => {
    await run([
      '--config',
      configWith('ble:\n  scale_mac: "AA:BB:CC:DD:EE:01"\n  force_scale_adapter: Nope\n'),
    ]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.some((l) => l.includes('no adapter named "Nope"'))).toBe(true);
  });

  it('exits 1 when a single run exports nothing, and stops both heartbeats', async () => {
    runSingleShot.mockResolvedValue(false);
    await run(['--config', configWith('')]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(heartbeat.stop).toHaveBeenCalled();
    expect(heartbeat.stopFile).toHaveBeenCalled();
  });

  it('returns without an exit code after a single run that exported', async () => {
    runSingleShot.mockResolvedValue(true);
    await run(['--config', configWith('')]);
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(heartbeat.stopFile).toHaveBeenCalled();
  });
});
