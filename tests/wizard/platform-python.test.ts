import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What running `<cmd> --version` does on the fake host. */
interface FakeRun {
  stdout?: string;
  stderr?: string;
  status?: number;
  /** spawn failed: ENOENT (not installed) or ETIMEDOUT (killed at the timeout). */
  error?: 'ENOENT' | 'ETIMEDOUT';
}

const host: Record<string, FakeRun> = {};

function fakeError(code: string, run: FakeRun): Error {
  return Object.assign(new Error(`spawnSync ${code}`), {
    code,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
  });
}

// Both child_process entry points answer from the same table, the way the
// real ones would: execFileSync returns stdout on exit 0 and throws otherwise,
// spawnSync reports everything without throwing.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw fakeError('ENOENT', {});
  }),
  spawnSync: vi.fn((cmd: string) => {
    const run = host[cmd] ?? { error: 'ENOENT' };
    return {
      pid: 1,
      output: [null, run.stdout ?? '', run.stderr ?? ''],
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
      status: run.error ? null : (run.status ?? 0),
      signal: run.error === 'ETIMEDOUT' ? 'SIGTERM' : null,
      ...(run.error ? { error: fakeError(run.error, run) } : {}),
    };
  }),
  execFileSync: vi.fn((cmd: string) => {
    const run = host[cmd] ?? { error: 'ENOENT' };
    if (run.error) throw fakeError(run.error, run);
    if ((run.status ?? 0) !== 0) throw fakeError('EXIT', run);
    return run.stdout ?? '';
  }),
}));

const { detectPlatform } = await import('../../src/wizard/platform.js');

function setHost(runs: Record<string, FakeRun>): void {
  for (const k of Object.keys(host)) delete host[k];
  Object.assign(host, runs);
}

describe('detectPlatform() Python probe', () => {
  beforeEach(() => setHost({}));

  it('reads a version printed to stdout', () => {
    setHost({ python3: { stdout: 'Python 3.12.4\n' } });

    const info = detectPlatform();

    expect(info).toMatchObject({
      hasPython: true,
      pythonCommand: 'python3',
      pythonVersion: '3.12',
    });
  });

  // Python 2 prints its version to stderr and exits 0. execFileSync returns
  // only stdout on success, so it was never seen and the message about an
  // interpreter too old for Garmin could not name it.
  it('reads a version printed to stderr with exit 0 (Python 2)', () => {
    setHost({ python: { stderr: 'Python 2.7.18\n', status: 0 } });

    const info = detectPlatform();

    expect(info).toMatchObject({ hasPython: true, pythonCommand: null, pythonVersion: '2.7' });
  });

  it('reports no Python when neither command exists', () => {
    const info = detectPlatform();

    expect(info).toMatchObject({ hasPython: false, pythonCommand: null });
    expect(info.pythonVersion).toBeUndefined();
  });

  it('treats a probe killed at the timeout as no answer', () => {
    setHost({
      python3: { error: 'ETIMEDOUT', stdout: 'Python 3.13.0\n' },
      python: { stdout: 'Python 3.13.1\n' },
    });

    expect(detectPlatform()).toMatchObject({ pythonCommand: 'python', pythonVersion: '3.13' });
  });

  it('picks python 3.12 over an older python3', () => {
    setHost({
      python3: { stdout: 'Python 3.10.12\n' },
      python: { stdout: 'Python 3.12.1\n' },
    });

    expect(detectPlatform()).toMatchObject({
      hasPython: true,
      pythonCommand: 'python',
      pythonVersion: '3.12',
    });
  });

  it('records the first older version when none is new enough', () => {
    setHost({
      python3: { stdout: 'Python 3.9.2\n' },
      python: { stderr: 'Python 2.7.18\n' },
    });

    expect(detectPlatform()).toMatchObject({
      hasPython: true,
      pythonCommand: null,
      pythonVersion: '3.9',
    });
  });
});
