import { describe, it, expect } from 'vitest';
import { diagnoseMacArg, parseRunArgs, toolConfigArg } from '../../src/cli-run-args.js';

/**
 * The run path used to parse argv leniently and ignore anything it did not
 * know, so a misplaced subcommand or a mistyped flag started a real scan and
 * export instead of failing (G-16).
 */
describe('parseRunArgs', () => {
  it('accepts no arguments', () => {
    expect(parseRunArgs([])).toEqual({ kind: 'ok', config: undefined, help: false });
  });

  it('accepts the Home Assistant add-on argv shape', () => {
    // ble-scale-sync-addon/run.sh: exec node dist/index.js --config "$CONFIG"
    expect(parseRunArgs(['--config', '/data/config.yaml'])).toEqual({
      kind: 'ok',
      config: '/data/config.yaml',
      help: false,
    });
    expect(parseRunArgs(['-c', '/data/config.yaml'])).toMatchObject({
      kind: 'ok',
      config: '/data/config.yaml',
    });
    expect(parseRunArgs(['--config=/data/config.yaml'])).toMatchObject({
      kind: 'ok',
      config: '/data/config.yaml',
    });
  });

  it('accepts a bare -- the dispatcher routes here', () => {
    expect(parseRunArgs(['--'])).toMatchObject({ kind: 'ok' });
  });

  it('accepts --help', () => {
    expect(parseRunArgs(['--help'])).toMatchObject({ kind: 'ok', help: true });
  });

  it('refuses a subcommand placed after a flag instead of running a sync', () => {
    const result = parseRunArgs(['-c', 'x.yaml', 'validate']);
    expect(result.kind).toBe('error');
    expect(result).toMatchObject({ message: expect.stringContaining('ble-scale-sync validate') });
  });

  it('refuses any other positional', () => {
    expect(parseRunArgs(['--config', 'x.yaml', 'extra']).kind).toBe('error');
  });

  it('refuses a mistyped flag instead of falling back to the default config', () => {
    expect(parseRunArgs(['--conifg', 'x.yaml']).kind).toBe('error');
  });

  it('refuses --config with no value instead of reading it as true', () => {
    expect(parseRunArgs(['--config']).kind).toBe('error');
  });
});

// G-23: only argv[2] was read, so a MAC after --native was ignored.
describe('diagnoseMacArg', () => {
  it('finds the MAC after a flag', () => {
    expect(diagnoseMacArg(['--native', 'AA:BB:CC:DD:EE:FF'])).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('does not mistake the value of --config for a MAC', () => {
    expect(diagnoseMacArg(['--config', 'x.yaml'])).toBeUndefined();
    expect(diagnoseMacArg(['-c', 'x.yaml', 'AA:BB:CC:DD:EE:FF'])).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('returns nothing without a positional argument', () => {
    expect(diagnoseMacArg([])).toBeUndefined();
    expect(diagnoseMacArg(['--native'])).toBeUndefined();
  });
});

// G-05: scan and diagnose ignored --config and always read the default
// config.yaml, so the documented `--config` path was never scanned with.
describe('toolConfigArg', () => {
  it('reads --config, -c and --config=', () => {
    expect(toolConfigArg(['--config', '/data/config.yaml'])).toEqual({
      kind: 'ok',
      config: '/data/config.yaml',
    });
    expect(toolConfigArg(['-c', 'x.yaml'])).toEqual({ kind: 'ok', config: 'x.yaml' });
    expect(toolConfigArg(['--config=x.yaml'])).toEqual({ kind: 'ok', config: 'x.yaml' });
  });

  it('finds it among the diagnose arguments', () => {
    expect(toolConfigArg(['--native', 'AA:BB:CC:DD:EE:FF', '-c', 'x.yaml'])).toEqual({
      kind: 'ok',
      config: 'x.yaml',
    });
  });

  it('is undefined without one', () => {
    expect(toolConfigArg([])).toEqual({ kind: 'ok', config: undefined });
    expect(toolConfigArg(['AA:BB:CC:DD:EE:FF', '--native'])).toEqual({
      kind: 'ok',
      config: undefined,
    });
  });

  it('refuses --config with no path', () => {
    expect(toolConfigArg(['--config']).kind).toBe('error');
    expect(toolConfigArg(['--config', '--native']).kind).toBe('error');
    expect(toolConfigArg(['--config=']).kind).toBe('error');
  });
});
