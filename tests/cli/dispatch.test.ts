import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyArgs, SUBCOMMANDS } from '../../src/cli-dispatch.js';

describe('classifyArgs', () => {
  it('runs the sync flow with no arguments', () => {
    expect(classifyArgs([])).toEqual({ kind: 'run' });
  });

  it('runs the sync flow for the Home Assistant add-on argv shape', () => {
    // ble-scale-sync-addon/run.sh: exec node dist/index.js --config "$CONFIG"
    expect(classifyArgs(['--config', '/data/config.yaml'])).toEqual({ kind: 'run' });
    expect(classifyArgs(['-c', '/data/config.yaml'])).toEqual({ kind: 'run' });
  });

  it('treats a bare -- as a flag, not a command', () => {
    expect(classifyArgs(['--'])).toEqual({ kind: 'run' });
  });

  it('answers help in all three spellings', () => {
    expect(classifyArgs(['--help'])).toEqual({ kind: 'help' });
    expect(classifyArgs(['-h'])).toEqual({ kind: 'help' });
    expect(classifyArgs(['help'])).toEqual({ kind: 'help' });
  });

  it('classifies a subcommand', () => {
    expect(classifyArgs(['setup'])).toEqual({ kind: 'command', command: 'setup' });
    expect(classifyArgs(['start'])).toEqual({ kind: 'command', command: 'start' });
  });

  it('ignores trailing arguments of a subcommand', () => {
    expect(classifyArgs(['diagnose', 'AA:BB:CC:DD:EE:FF'])).toEqual({
      kind: 'command',
      command: 'diagnose',
    });
  });

  it('answers version instead of starting a scan', () => {
    // A leading dash otherwise falls through to the run path, so the universal
    // `--version` used to build the registries and start scanning.
    expect(classifyArgs(['--version'])).toEqual({ kind: 'version' });
    expect(classifyArgs(['-v'])).toEqual({ kind: 'version' });
    expect(classifyArgs(['version'])).toEqual({ kind: 'version' });
  });

  it('rejects a typo instead of silently starting a run', () => {
    expect(classifyArgs(['scna'])).toEqual({ kind: 'unknown', word: 'scna' });
  });

  it('forwards the flags of a subcommand to that subcommand', () => {
    expect(classifyArgs(['setup-garmin', '--all-users'])).toEqual({
      kind: 'command',
      command: 'setup-garmin',
    });
  });

  it('classifies every declared subcommand', () => {
    for (const name of SUBCOMMANDS) {
      expect(classifyArgs([name])).toEqual({ kind: 'command', command: name });
    }
  });
});

describe('SUBCOMMANDS', () => {
  it('speaks the same vocabulary as docker-entrypoint.sh', () => {
    // Read from the shell script rather than a copy of the list, so a command
    // added to one CLI and forgotten in the other fails here. `help` is
    // excluded: the dispatcher answers it outside the subcommand list.
    const entrypoint = readFileSync('docker-entrypoint.sh', 'utf8');
    const cases = [...entrypoint.matchAll(/^ {2}([a-z][a-z-]*)\)/gm)].map((m) => m[1]);
    expect(cases).toContain('setup-garmin');
    for (const word of cases) {
      expect(SUBCOMMANDS).toContain(word);
    }
  });
});
