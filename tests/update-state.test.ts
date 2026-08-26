import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  UPDATE_STATE_FILENAME,
  resolveUpdateStatePath,
  configureUpdateState,
  readUpdateState,
  writeUpdateState,
  resetUpdateState,
} from '../src/update-state.js';
import { ROOT } from '../src/config/paths.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'update-state-'));
  resetUpdateState();
});

afterEach(() => {
  resetUpdateState();
  rmSync(tempDir, { recursive: true, force: true });
});

/** Path of the config.yaml the state file should sit next to. */
function tempConfig(): string {
  return join(tempDir, 'config.yaml');
}

function statePath(): string {
  return join(tempDir, UPDATE_STATE_FILENAME);
}

// ─── resolveUpdateStatePath ─────────────────────────────────────────────────

describe('resolveUpdateStatePath()', () => {
  it('puts the state file next to the resolved config file', () => {
    expect(resolveUpdateStatePath(tempConfig())).toBe(statePath());
  });

  it('falls back to the repo root when there is no config.yaml (.env-only)', () => {
    expect(resolveUpdateStatePath(undefined)).toBe(join(ROOT, UPDATE_STATE_FILENAME));
  });

  it('resolves a relative config path against the cwd', () => {
    const resolved = resolveUpdateStatePath('config.yaml');
    expect(resolved.endsWith(UPDATE_STATE_FILENAME)).toBe(true);
    expect(dirname(resolved)).toBe(process.cwd());
  });
});

// ─── persistence disabled by default ────────────────────────────────────────

describe('unconfigured (persistence off)', () => {
  it('reads null and writes nothing to disk', () => {
    expect(readUpdateState()).toBeNull();
    writeUpdateState({ lastCheckDate: '2026-08-26' });
    expect(existsSync(statePath())).toBe(false);
  });

  it('still caches in memory so one process checks once', () => {
    writeUpdateState({ lastCheckDate: '2026-08-26' });
    expect(readUpdateState()).toEqual({ lastCheckDate: '2026-08-26' });
  });
});

// ─── configured ─────────────────────────────────────────────────────────────

describe('configureUpdateState()', () => {
  it('writes the state file next to the config file', () => {
    configureUpdateState(tempConfig());
    writeUpdateState({ lastCheckDate: '2026-08-26' });

    expect(existsSync(statePath())).toBe(true);
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({
      lastCheckDate: '2026-08-26',
    });
  });

  it('reads back state written by a previous process', () => {
    writeFileSync(statePath(), '{"lastCheckDate":"2026-08-25"}\n', 'utf8');
    configureUpdateState(tempConfig());

    expect(readUpdateState()).toEqual({ lastCheckDate: '2026-08-25' });
  });

  it('leaves no .tmp file behind', () => {
    configureUpdateState(tempConfig());
    writeUpdateState({ lastCheckDate: '2026-08-26' });

    expect(existsSync(statePath() + '.tmp')).toBe(false);
  });

  it('reads the file at most once per process', () => {
    writeFileSync(statePath(), '{"lastCheckDate":"2026-08-25"}\n', 'utf8');
    configureUpdateState(tempConfig());

    expect(readUpdateState()).toEqual({ lastCheckDate: '2026-08-25' });

    // A different process rewrote the file. We must NOT pick it up.
    writeFileSync(statePath(), '{"lastCheckDate":"2026-08-26"}\n', 'utf8');
    expect(readUpdateState()).toEqual({ lastCheckDate: '2026-08-25' });
  });

  it('drops the cache when reconfigured', () => {
    writeFileSync(statePath(), '{"lastCheckDate":"2026-08-25"}\n', 'utf8');
    configureUpdateState(tempConfig());
    expect(readUpdateState()).toEqual({ lastCheckDate: '2026-08-25' });

    writeFileSync(statePath(), '{"lastCheckDate":"2026-08-26"}\n', 'utf8');
    configureUpdateState(tempConfig());
    expect(readUpdateState()).toEqual({ lastCheckDate: '2026-08-26' });
  });
});

// ─── corrupt / absent behaves like "never checked" ──────────────────────────

describe('corrupt or absent state', () => {
  it('returns null when the file does not exist', () => {
    configureUpdateState(tempConfig());
    expect(readUpdateState()).toBeNull();
  });

  it.each([
    ['not json at all', 'this is not json'],
    ['truncated json', '{"lastCheckDate":"2026-08-'],
    ['empty file', ''],
    ['json array', '[1,2,3]'],
    ['json null', 'null'],
    ['missing field', '{"other":1}'],
    ['wrong type', '{"lastCheckDate":20260826}'],
    ['malformed date', '{"lastCheckDate":"26-08-2026"}'],
  ])('returns null for %s', (_label, content) => {
    writeFileSync(statePath(), content, 'utf8');
    configureUpdateState(tempConfig());
    expect(readUpdateState()).toBeNull();
  });

  it('returns null for a date in the future', () => {
    writeFileSync(statePath(), '{"lastCheckDate":"2999-01-01"}\n', 'utf8');
    configureUpdateState(tempConfig());
    expect(readUpdateState()).toBeNull();
  });

  it('ignores unknown extra fields but keeps a valid date', () => {
    writeFileSync(statePath(), '{"lastCheckDate":"2026-08-25","future":"field"}', 'utf8');
    configureUpdateState(tempConfig());
    expect(readUpdateState()).toEqual({ lastCheckDate: '2026-08-25' });
  });

  it('never throws when the state path is a directory', () => {
    mkdirSync(statePath());
    configureUpdateState(tempConfig());

    expect(() => readUpdateState()).not.toThrow();
    expect(readUpdateState()).toBeNull();
    expect(() => writeUpdateState({ lastCheckDate: '2026-08-26' })).not.toThrow();
  });

  it('keeps the in-memory value when the write fails', () => {
    mkdirSync(statePath());
    configureUpdateState(tempConfig());

    writeUpdateState({ lastCheckDate: '2026-08-26' });
    expect(readUpdateState()).toEqual({ lastCheckDate: '2026-08-26' });
  });
});

// ─── resetUpdateState ───────────────────────────────────────────────────────

describe('resetUpdateState()', () => {
  it('disables persistence and clears the cache', () => {
    configureUpdateState(tempConfig());
    writeUpdateState({ lastCheckDate: '2026-08-26' });
    expect(readUpdateState()).toEqual({ lastCheckDate: '2026-08-26' });

    resetUpdateState();

    expect(readUpdateState()).toBeNull();
    writeUpdateState({ lastCheckDate: '2026-08-27' });
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({
      lastCheckDate: '2026-08-26',
    });
  });
});
