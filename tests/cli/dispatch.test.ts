import { describe, it, expect } from 'vitest';
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

  it('rejects a typo instead of silently starting a run', () => {
    expect(classifyArgs(['scna'])).toEqual({ kind: 'unknown', word: 'scna' });
  });

  it('classifies every declared subcommand', () => {
    for (const name of SUBCOMMANDS) {
      expect(classifyArgs([name])).toEqual({ kind: 'command', command: name });
    }
  });
});

describe('SUBCOMMANDS', () => {
  it('speaks the vocabulary docker-entrypoint.sh already exposes', () => {
    // The two CLIs are documented side by side, so a word in one and not the
    // other is a real defect. `help` is excluded: the dispatcher handles it
    // outside the subcommand list. `setup-garmin` needs a TypeScript entry
    // point of its own and joins in the next commit.
    for (const word of ['start', 'setup', 'scan', 'diagnose', 'validate', 'setup-strava']) {
      expect(SUBCOMMANDS).toContain(word);
    }
  });
});
