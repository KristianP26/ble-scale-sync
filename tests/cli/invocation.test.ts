import { describe, it, expect } from 'vitest';
import { cliCommand, invokedViaNpmScript } from '../../src/cli-invocation.js';

// Measured on npm 11.6.2; see the module doc comment.
const NPM_START = { npm_command: 'start', npm_lifecycle_event: 'start' };
const NPM_RUN = { npm_command: 'run', npm_lifecycle_event: 'setup' };
const NPX = { npm_command: 'exec', npm_lifecycle_event: 'npx' };
const BIN: Record<string, string | undefined> = {};

describe('invokedViaNpmScript', () => {
  it('is true for npm start and npm run', () => {
    expect(invokedViaNpmScript(NPM_START)).toBe(true);
    expect(invokedViaNpmScript(NPM_RUN)).toBe(true);
  });

  it('is false for npx and for a plain bin', () => {
    // npx sets npm_lifecycle_event too, so the lifecycle variable alone is not
    // a usable signal.
    expect(invokedViaNpmScript(NPX)).toBe(false);
    expect(invokedViaNpmScript(BIN)).toBe(false);
  });

  it('falls back to the lifecycle variable when npm_command is absent', () => {
    expect(invokedViaNpmScript({ npm_lifecycle_event: 'scan' })).toBe(true);
    expect(invokedViaNpmScript({ npm_lifecycle_event: 'npx' })).toBe(false);
  });
});

describe('cliCommand', () => {
  it('names the installed command outside an npm script', () => {
    expect(cliCommand(undefined, [], BIN)).toBe('ble-scale-sync');
    expect(cliCommand('setup', [], BIN)).toBe('ble-scale-sync setup');
    expect(cliCommand('setup', ['--config', 'x.yaml'], BIN)).toBe(
      'ble-scale-sync setup --config x.yaml',
    );
  });

  it('names the npm script inside a checkout, with the -- separator', () => {
    expect(cliCommand(undefined, [], NPM_START)).toBe('npm start');
    expect(cliCommand('validate', [], NPM_RUN)).toBe('npm run validate');
    expect(cliCommand('setup', ['--config', 'x.yaml'], NPM_RUN)).toBe(
      'npm run setup -- --config x.yaml',
    );
  });

  it('names the installed command under npx', () => {
    expect(cliCommand('scan', [], NPX)).toBe('ble-scale-sync scan');
  });
});
