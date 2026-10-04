import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PlatformInfo, PromptProvider } from '../../src/wizard/types.js';
import { scriptedPrompts } from '../helpers/scripted-prompts.js';

vi.mock('../../src/update-check.js', () => ({ checkForUpdate: vi.fn(async () => null) }));
vi.mock('../../src/update-state.js', () => ({ configureUpdateState: vi.fn() }));

const { runSetupCommand } = await import('../../src/wizard/setup-command.js');

const platform: PlatformInfo = {
  os: 'linux',
  arch: 'x64',
  hasDocker: false,
  hasPython: false,
  pythonCommand: null,
};

/**
 * What @inquirer/core 12 rejects a prompt with on Ctrl+C (lib/create-prompt.js):
 * an ExitPromptError, message "User force closed the prompt with SIGINT".
 */
class ExitPromptError extends Error {
  name = 'ExitPromptError';
}

/** Answers like a user pressing Enter, until `cancelOn` is asked, then Ctrl+C. */
function cancellingPrompts(cancelOn: RegExp): PromptProvider {
  const { prompts } = scriptedPrompts([]);
  const cancel = (message: string) => {
    if (cancelOn.test(message)) {
      throw new ExitPromptError('User force closed the prompt with SIGINT');
    }
  };
  return {
    async input(message, opts) {
      cancel(message);
      return prompts.input(message, opts);
    },
    async password(message, opts) {
      cancel(message);
      return prompts.password(message, opts);
    },
    async select(message, choices) {
      cancel(message);
      return prompts.select(message, choices);
    },
    async confirm(message, opts) {
      cancel(message);
      return prompts.confirm(message, opts);
    },
    async checkbox(message, choices) {
      cancel(message);
      return prompts.checkbox(message, choices);
    },
  };
}

describe('runSetupCommand', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-command-'));
    configPath = path.join(dir, 'config.yaml');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // G-23: Ctrl+C ended the wizard with exit code 0, so a script running
  // `ble-scale-sync setup && ...` carried on as if the setup had been saved.
  it('exits 130, the shell code for SIGINT, when a prompt is cancelled with Ctrl+C', async () => {
    const code = await runSetupCommand(['--config', configPath], {
      prompts: cancellingPrompts(/./),
      platform,
    });

    expect(code).toBe(130);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('says the setup was cancelled rather than failed', async () => {
    await runSetupCommand(['--config', configPath], {
      prompts: cancellingPrompts(/./),
      platform,
    });

    const out = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(out).toMatch(/Setup cancelled/);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('exits 1 for any other error', async () => {
    const failing = cancellingPrompts(/$^/);
    failing.select = async () => {
      throw new Error('terminal went away');
    };
    failing.confirm = failing.select as PromptProvider['confirm'];
    failing.input = failing.select as PromptProvider['input'];

    const code = await runSetupCommand(['--config', configPath], { prompts: failing, platform });

    expect(code).toBe(1);
  });

  it('exits 0 for --help', async () => {
    expect(await runSetupCommand(['--help'])).toBe(0);
  });
});
