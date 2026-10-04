import { describe, it, expect } from 'vitest';
import { parseRunArgs } from '../../src/cli-run-args.js';

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
