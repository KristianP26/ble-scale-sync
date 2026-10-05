import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { appendEnvFile, formatEnvLine } from '../src/config/env-file.js';

describe('formatEnvLine', () => {
  const accepted = [
    'plain',
    'say "hi"',
    'has # hash',
    ' padded ',
    'back\\slash',
    'back\\nslash-n',
    'pa$word',
    'a`b',
  ];

  it.each(accepted)('writes %j single-quoted so dotenv reads it back unchanged', (value) => {
    const line = formatEnvLine('KEY', value);
    expect(line).toBe(`KEY='${value}'`);
    expect(parseDotenv(line!).KEY).toBe(value);
  });

  // The .env is also read by python-dotenv (setup_garmin.py), systemd
  // EnvironmentFile and compose env_file. python-dotenv expands ${...} even in
  // single quotes and reads \\ as one backslash; backtick quoting is dotenv's
  // alone; a newline ends the line for systemd and compose.
  const refused = [
    "it's",
    `both ' and "`,
    'two\nlines',
    'carriage\rreturn',
    '${NOT_A_REF}',
    'pre${X}post',
    'a\\\\b',
  ];

  it.each(refused)('refuses %j', (value) => {
    expect(formatEnvLine('KEY', value)).toBeUndefined();
  });

  it('refuses a key that is not a variable name', () => {
    expect(formatEnvLine('1BAD', 'x')).toBeUndefined();
    expect(formatEnvLine('A-B', 'x')).toBeUndefined();
  });
});

describe('appendEnvFile', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function envPath(content?: string): string {
    dir = mkdtempSync(join(tmpdir(), 'bss-env-file-'));
    const path = join(dir, '.env');
    if (content !== undefined) writeFileSync(path, content);
    return path;
  }

  it('creates the file', () => {
    const path = envPath();

    expect(appendEnvFile(path, new Map([['HA_TOKEN', 'abc']]))).toEqual(['HA_TOKEN']);

    expect(parseDotenv(readFileSync(path))).toEqual({ HA_TOKEN: 'abc' });
  });

  it('appends after existing lines without touching them, also with no final newline', () => {
    const path = envPath('# mine\nGARMIN_PASSWORD=old');

    appendEnvFile(path, new Map([['HA_TOKEN', 'abc']]));

    const text = readFileSync(path, 'utf8');
    expect(text.startsWith('# mine\nGARMIN_PASSWORD=old\n')).toBe(true);
    expect(parseDotenv(text)).toEqual({ GARMIN_PASSWORD: 'old', HA_TOKEN: 'abc' });
  });

  it('skips a key the file already has with the same value', () => {
    const path = envPath('HA_TOKEN=keep\n');

    expect(appendEnvFile(path, new Map([['HA_TOKEN', 'keep']]))).toEqual([]);

    expect(readFileSync(path, 'utf8')).toBe('HA_TOKEN=keep\n');
  });

  // Skipping it silently left the config reading the file's value, not the
  // one the person typed. Some other entry may read the key, so it is never
  // rewritten either: nothing is written and the save stops.
  it('throws for a key the file already has with a different value, writing nothing', () => {
    const path = envPath('HA_TOKEN=keep\n');

    expect(() =>
      appendEnvFile(
        path,
        new Map([
          ['MQTT_PASSWORD', 'pw'],
          ['HA_TOKEN', 'new'],
        ]),
      ),
    ).toThrow(/HA_TOKEN is already set/);

    expect(readFileSync(path, 'utf8')).toBe('HA_TOKEN=keep\n');
  });
});
