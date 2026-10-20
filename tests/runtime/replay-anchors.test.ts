import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AppConfig, UserConfig } from '../../src/config/schema.js';

// A read that fails with something other than ENOENT (an AV scanner holding
// the file on Windows, EIO on an SD card) cannot be produced on demand, so the
// test switches it on for the anchor file only.
const readFailure: { code: string | undefined } = { code: undefined };
vi.mock(import('node:fs'), async (importOriginal) => {
  const mod = await importOriginal();
  const readFileSync = ((...args: Parameters<typeof mod.readFileSync>) => {
    if (readFailure.code && String(args[0]).endsWith('.last-live-weigh-ins.json')) {
      throw Object.assign(new Error(`${readFailure.code}: simulated`), { code: readFailure.code });
    }
    return mod.readFileSync(...args);
  }) as typeof mod.readFileSync;
  return { ...mod, readFileSync, default: { ...mod, readFileSync } };
});

const {
  REPLAY_ANCHORS_FILENAME,
  resolveReplayAnchorsPath,
  loadReplayAnchors,
  restoreReplayAnchors,
  persistReplayAnchor,
  _resetReplayAnchorStateForTests,
} = await import('../../src/runtime/replay-anchors.js');
const { createAppContext } = await import('../../src/runtime/context.js');
const { resolveRuntimeConfig } = await import('../../src/config/resolve.js');
const { setLogLevel, LogLevel } = await import('../../src/logger.js');

function user(slug: string, lastKnown: number | null): UserConfig {
  return {
    name: slug,
    slug,
    height: 180,
    birth_date: '1990-06-15',
    gender: 'male',
    is_athlete: false,
    weight_range: { min: 50, max: 100 },
    last_known_weight: lastKnown,
  };
}

describe('replay anchor file (D067)', () => {
  let dir: string;
  let file: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const write = (content: unknown): void =>
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  const read = (): unknown => JSON.parse(fs.readFileSync(file, 'utf-8'));
  const maps = (entries: Record<string, [number, string]>) => ({
    weights: new Map(Object.entries(entries).map(([s, [w]]) => [s, w])),
    times: new Map(Object.entries(entries).map(([s, [, t]]) => [s, new Date(t)])),
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-anchors-'));
    file = path.join(dir, REPLAY_ANCHORS_FILENAME);
    readFailure.code = undefined;
    _resetReplayAnchorStateForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    setLogLevel(LogLevel.INFO);
    readFailure.code = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('lives next to the resolved config.yaml, and nowhere without one', () => {
    expect(resolveReplayAnchorsPath(path.join(dir, 'config.yaml'))).toBe(file);
    expect(resolveReplayAnchorsPath('config.yaml')).toBe(
      path.join(process.cwd(), '.last-live-weigh-ins.json'),
    );
    // .env mode: no file holds a weight there today, and this must not start to.
    expect(resolveReplayAnchorsPath(undefined)).toBeUndefined();
  });

  it('saves the exact weight and the ISO time keyed by slug, 0600', () => {
    const { weights, times } = maps({ dad: [80.137, '2026-10-19T06:59:58.000Z'] });
    persistReplayAnchor(file, 'dad', weights, times);

    expect(read()).toEqual({ dad: { weight: 80.137, time: '2026-10-19T06:59:58.000Z' } });
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the other slugs' entries, including ones this config does not know", () => {
    write({
      mom: { weight: 60.2, time: '2026-10-18T07:00:00.000Z' },
      guest: { weight: 70, time: '2026-10-17T07:00:00.000Z' },
    });
    const { weights, times } = maps({ dad: [82.3, '2026-10-19T07:00:00.000Z'] });
    persistReplayAnchor(file, 'dad', weights, times);

    expect(read()).toEqual({
      mom: { weight: 60.2, time: '2026-10-18T07:00:00.000Z' },
      guest: { weight: 70, time: '2026-10-17T07:00:00.000Z' },
      dad: { weight: 82.3, time: '2026-10-19T07:00:00.000Z' },
    });
  });

  it('puts back from memory the entries of a file deleted while running', () => {
    // Mom was restored at startup; the file went away before Dad weighed in.
    const { weights, times } = maps({
      mom: [60.2, '2026-10-18T07:00:00.000Z'],
      dad: [82.3, '2026-10-19T07:00:00.000Z'],
    });
    persistReplayAnchor(file, 'dad', weights, times);

    expect(read()).toEqual({
      mom: { weight: 60.2, time: '2026-10-18T07:00:00.000Z' },
      dad: { weight: 82.3, time: '2026-10-19T07:00:00.000Z' },
    });
  });

  it('does not write over the file when it cannot be read, and warns', () => {
    write({ mom: { weight: 60.2, time: '2026-10-18T07:00:00.000Z' } });
    const before = fs.readFileSync(file, 'utf-8');
    readFailure.code = 'EIO';
    const { weights, times } = maps({ dad: [82.3, '2026-10-19T07:00:00.000Z'] });

    expect(() => persistReplayAnchor(file, 'dad', weights, times)).not.toThrow();

    readFailure.code = undefined;
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('Could not save the last weigh-in of dad');
  });

  it('keeps a time in the future: it is on the scale clock', () => {
    const { weights, times } = maps({ dad: [80, '2026-10-19T09:00:00.000Z'] });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T07:00:00Z'));
    try {
      persistReplayAnchor(file, 'dad', weights, times);
      expect(loadReplayAnchors(file).get('dad')?.time.toISOString()).toBe(
        '2026-10-19T09:00:00.000Z',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('neither saves nor restores a time before 2024 (a host clock not set yet)', () => {
    const { weights, times } = maps({ dad: [80, '1970-01-01T00:05:00.000Z'] });
    persistReplayAnchor(file, 'dad', weights, times);
    expect(fs.existsSync(file)).toBe(false);

    write({ dad: { weight: 80, time: '2023-12-31T23:59:59.000Z' } });
    expect(loadReplayAnchors(file).size).toBe(0);
  });

  it('warns once per process when the file cannot be written, then logs at debug', () => {
    const missing = path.join(dir, 'gone', REPLAY_ANCHORS_FILENAME);
    const { weights, times } = maps({ dad: [80, '2026-10-19T07:00:00.000Z'] });
    setLogLevel(LogLevel.DEBUG);

    expect(() => persistReplayAnchor(missing, 'dad', weights, times)).not.toThrow();
    expect(() => persistReplayAnchor(missing, 'dad', weights, times)).not.toThrow();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain(
      'after a restart, a stored copy of it may be exported again',
    );
    const debug = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('Could not save the last weigh-in of dad'));
    expect(debug).toHaveLength(1);
  });

  it.each([
    ['a missing file', undefined],
    ['an empty file', ''],
    ['broken JSON', '{not json'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string entry', { dad: '80' }],
    ['a non-numeric weight', { dad: { weight: '80', time: '2026-10-19T07:00:00.000Z' } }],
    ['a zero weight', { dad: { weight: 0, time: '2026-10-19T07:00:00.000Z' } }],
    ['a negative weight', { dad: { weight: -80, time: '2026-10-19T07:00:00.000Z' } }],
    ['an unreadable time', { dad: { weight: 80, time: 'yesterday-ish' } }],
    ['no time', { dad: { weight: 80 } }],
  ])('restores nothing from %s', (_label, content) => {
    if (content !== undefined) write(content);
    expect(loadReplayAnchors(file).size).toBe(0);
  });

  it('keeps a good entry next to a bad one', () => {
    write({
      dad: { weight: 'x', time: '2026-10-19T07:00:00.000Z' },
      mom: { weight: 60.2, time: '2026-10-18T07:00:00.000Z' },
    });
    const anchors = loadReplayAnchors(file);
    expect([...anchors.keys()]).toEqual(['mom']);
    expect(anchors.get('mom')).toEqual({ weight: 60.2, time: new Date('2026-10-18T07:00:00Z') });
  });

  it('restores nothing, and does not throw, when the file cannot be read', () => {
    write({ dad: { weight: 80, time: '2026-10-19T07:00:00.000Z' } });
    readFailure.code = 'EACCES';
    expect(loadReplayAnchors(file).size).toBe(0);
  });

  it("restores every configured user's entry into both maps", () => {
    write({
      dad: { weight: 82.3, time: '2026-10-19T07:00:00.000Z' },
      mom: { weight: 60.2, time: '2026-10-18T07:00:00.000Z' },
      guest: { weight: 70, time: '2026-10-17T07:00:00.000Z' },
    });
    const weights = new Map<string, number>();
    const times = new Map<string, Date>();
    restoreReplayAnchors(file, [user('dad', 82), user('mom', null)], weights, times);

    expect(weights).toEqual(
      new Map([
        ['dad', 82.3],
        ['mom', 60.2],
      ]),
    );
    expect(times).toEqual(
      new Map([
        ['dad', new Date('2026-10-19T07:00:00Z')],
        ['mom', new Date('2026-10-18T07:00:00Z')],
      ]),
    );
  });

  it('ignores an entry 0.5 kg or more from last_known_weight, with a debug line', () => {
    write({
      dad: { weight: 80, time: '2026-10-19T07:00:00.000Z' },
      mom: { weight: 60.49, time: '2026-10-18T07:00:00.000Z' },
    });
    setLogLevel(LogLevel.DEBUG);
    const weights = new Map<string, number>();
    const times = new Map<string, Date>();
    restoreReplayAnchors(file, [user('dad', 79.5), user('mom', 60)], weights, times);

    expect([...weights.keys()]).toEqual(['mom']);
    expect([...times.keys()]).toEqual(['mom']);
    expect(
      logSpy.mock.calls.some((c) =>
        String(c[0]).includes('Ignoring the saved last weigh-in of dad'),
      ),
    ).toBe(true);
  });

  describe('createAppContext', () => {
    function config(users: UserConfig[]): AppConfig {
      return {
        version: 1,
        scale: { weight_unit: 'kg', height_unit: 'cm' },
        unknown_user: 'nearest',
        out_of_range: 'warn',
        users,
        update_check: false,
      } as AppConfig;
    }
    function build(replayAnchorsPath?: string) {
      const c = config([user('dad', 82), user('mom', 60)]);
      return createAppContext({
        config: c,
        resolved: { ...resolveRuntimeConfig(c), retryFailedExports: false },
        configSource: 'yaml',
        configPath: path.join(dir, 'config.yaml'),
        ...(replayAnchorsPath ? { replayAnchorsPath } : {}),
        signal: new AbortController().signal,
        abortApp: () => {},
      });
    }

    beforeEach(() => {
      write({
        dad: { weight: 82.3, time: '2026-10-19T07:00:00.000Z' },
        mom: { weight: 60.2, time: '2026-10-18T07:00:00.000Z' },
      });
    });

    it('restores the saved weigh-ins of every user when given the file', () => {
      const ctx = build(file);
      expect(ctx.replayAnchorsPath).toBe(file);
      expect(ctx.lastExportedWeights.get('dad')).toBe(82.3);
      expect(ctx.lastExportedWeights.get('mom')).toBe(60.2);
      expect(ctx.lastExportedAt.get('dad')?.toISOString()).toBe('2026-10-19T07:00:00.000Z');
      expect(ctx.lastExportedAt.get('mom')?.toISOString()).toBe('2026-10-18T07:00:00.000Z');
    });

    it('keeps nothing without it', () => {
      const ctx = build();
      expect(ctx.replayAnchorsPath).toBeUndefined();
      expect(ctx.lastExportedWeights.size).toBe(0);
      expect(ctx.lastExportedAt.size).toBe(0);
    });
  });
});
