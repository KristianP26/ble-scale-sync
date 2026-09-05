import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isSupportedPython,
  parsePythonVersion,
  translateGarminArgs,
} from '../../src/garmin-cli.js';

describe('translateGarminArgs', () => {
  it('passes no arguments through as the legacy env-var flow', () => {
    expect(translateGarminArgs([])).toEqual([]);
  });

  it('translates --all-users, which argparse does not accept at all', () => {
    expect(translateGarminArgs(['--all-users'])).toEqual(['--from-config']);
  });

  it('adds --from-config to --user, which argparse silently ignores without it', () => {
    // Without this the script falls through to run_legacy() and authenticates
    // GARMIN_EMAIL / GARMIN_PASSWORD, that is, a different account than asked.
    expect(translateGarminArgs(['--user', 'Bob'])).toEqual(['--from-config', '--user', 'Bob']);
  });

  it('keeps trailing arguments after a translated one', () => {
    expect(translateGarminArgs(['--user', 'Bob', '--token-dir', '/tokens'])).toEqual([
      '--from-config',
      '--user',
      'Bob',
      '--token-dir',
      '/tokens',
    ]);
    expect(translateGarminArgs(['--all-users', '--token-dir', '/tokens'])).toEqual([
      '--from-config',
      '--token-dir',
      '/tokens',
    ]);
  });

  it('forwards anything the script already understands', () => {
    expect(translateGarminArgs(['--from-config', '--config-path', 'c.yaml'])).toEqual([
      '--from-config',
      '--config-path',
      'c.yaml',
    ]);
    expect(translateGarminArgs(['--user'])).toEqual(['--user']);
  });

  it('matches what docker-entrypoint.sh does with the same words', () => {
    // The two CLIs are documented as one vocabulary, so the translation has to
    // stay in step with the shell script.
    const entrypoint = readFileSync('docker-entrypoint.sh', 'utf8');
    expect(entrypoint).toContain('--all-users');
    expect(entrypoint).toContain('--from-config');
  });
});

describe('parsePythonVersion', () => {
  it('reads the version from either stream', () => {
    expect(parsePythonVersion('Python 3.12.4\n')).toEqual({ major: 3, minor: 12 });
    expect(parsePythonVersion('Python 2.7.18')).toEqual({ major: 2, minor: 7 });
  });

  it('returns null for output that names no version', () => {
    expect(parsePythonVersion('command not found')).toBeNull();
  });
});

describe('isSupportedPython', () => {
  it('accepts 3.9 and newer', () => {
    expect(isSupportedPython({ major: 3, minor: 9 })).toBe(true);
    expect(isSupportedPython({ major: 3, minor: 12 })).toBe(true);
    expect(isSupportedPython({ major: 4, minor: 0 })).toBe(true);
  });

  it('rejects Python 2 and 3.8, whose failure is a raw f-string SyntaxError', () => {
    expect(isSupportedPython({ major: 2, minor: 7 })).toBe(false);
    expect(isSupportedPython({ major: 3, minor: 8 })).toBe(false);
    expect(isSupportedPython(null)).toBe(false);
  });
});
