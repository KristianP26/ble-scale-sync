import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PlatformInfo, PromptProvider } from '../../src/wizard/types.js';
import { scriptedPrompts } from '../helpers/scripted-prompts.js';
import { snapshotEnv } from '../helpers/env-snapshot.js';

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

  let restoreEnv: () => void;

  beforeEach(() => {
    // A secret stored in .env is also put in process.env, and the .env the
    // setup loads lands there too.
    restoreEnv = snapshotEnv();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-command-'));
    configPath = path.join(dir, 'config.yaml');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    restoreEnv();
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

  /** A fresh setup of one user, Alice, with the given per-user exporter answers. */
  function freshSetupAnswers(exporterAnswers: Array<[RegExp, string | boolean | string[]]>) {
    return scriptedPrompts([
      [/^How do you want to identify your scale/, 'skip'],
      [/^User name/, 'Alice'],
      [/^Height \(cm\)/, '180'],
      [/^Birth date/, '1990-01-01'],
      [/^Weight range minimum/, '60'],
      [/^Weight range maximum/, '90'],
      ...exporterAnswers,
    ]);
  }

  function logged(): string {
    return vi
      .mocked(console.log)
      .mock.calls.map((c) => c.map(String).join(' '))
      .join('\n');
  }

  // The steps were filtered by shouldRun before the first one ran, when a
  // fresh config has no users and no exporters, so Strava authorization was
  // dropped from every fresh setup.
  it('reaches Strava authorization in a fresh setup that adds a Strava exporter', async () => {
    const scripted = freshSetupAnswers([
      [/^Exporters/, ['strava']],
      [/^Client ID/, '42'],
      [/^Client Secret/, 'secret'],
      [/^Authorize Strava for Alice now/, false],
      [/^Test exporter connectivity/, false],
    ]);

    const code = await runSetupCommand(['--config', configPath], {
      prompts: scripted.prompts,
      platform,
    });

    expect(code).toBe(0);
    expect(scripted.rejected).toEqual([]);
    expect(scripted.pending).toEqual([]);
    const authorize = scripted.asked.indexOf(
      'Authorize Strava for Alice now? (needs a browser to approve the app)',
    );
    expect(authorize).toBeGreaterThan(scripted.asked.indexOf('Client Secret:'));
    // Before the connectivity test, which would otherwise report a missing token.
    expect(authorize).toBeLessThan(scripted.asked.indexOf('Test exporter connectivity?'));
    expect(logged()).toMatch(/Strava Authorization/);
  });

  // Same filter, older: Garmin authentication never ran in a fresh setup.
  it('reaches Garmin authentication in a fresh setup that adds a Garmin exporter', async () => {
    const scripted = freshSetupAnswers([
      [/^Exporters/, ['garmin']],
      [/^Garmin Email/, 'alice@example.com'],
      [/^Garmin Password/, 'pw'],
    ]);

    const code = await runSetupCommand(['--config', configPath], {
      prompts: scripted.prompts,
      platform,
    });

    expect(code).toBe(0);
    expect(scripted.rejected).toEqual([]);
    expect(scripted.pending).toEqual([]);
    // No Python on this platform: the step runs and says it is skipping.
    expect(logged()).toMatch(/Python is not available/);
  });

  const INVALID_UNIT_CONFIG = `version: 1
scale:
  weight_unit: stone
  height_unit: cm
unknown_user: nearest
users:
  - name: Alice
    slug: alice
    height: 180
    birth_date: '1990-01-01'
    gender: male
    is_athlete: false
    weight_range: { min: 60, max: 90 }
global_exporters:
  - type: file
    file_path: ./measurements.csv
`;

  // The menu ended after the summary whatever it did, so a "No" at "Save
  // anyway?" dropped every answer and still exited 0.
  it('goes back to the menu after a failed validation, so a fixed config saves', async () => {
    fs.writeFileSync(configPath, INVALID_UNIT_CONFIG);
    const scripted = scriptedPrompts([
      [/^An existing config\.yaml was found/, 'edit'],
      [/^Which section/, '__save__'],
      [/^Save anyway/, false],
      [/^Which section/, 'units'],
      [/^Weight unit/, 'kg'],
      // Then Enter: Review & Save, and yes to "Save to ...?".
    ]);

    const code = await runSetupCommand(['--config', configPath], {
      prompts: scripted.prompts,
      platform,
    });

    expect(code).toBe(0);
    expect(scripted.pending).toEqual([]);
    expect(scripted.asked.filter((m) => /^Save to /.test(m))).toHaveLength(1);
    expect(fs.readFileSync(configPath, 'utf8')).toMatch(/weight_unit: kg/);
    expect(logged()).not.toMatch(/Setup ended without saving/);
  });

  // `setup && ...` must not carry on after a setup that saved nothing.
  it('exits 1 and writes nothing when the person quits without saving', async () => {
    const scripted = freshSetupAnswers([
      [/^Exporters/, ['file']],
      [/^All sections done/, '__quit__'],
    ]);

    const code = await runSetupCommand(['--config', configPath], {
      prompts: scripted.prompts,
      platform,
    });

    expect(code).toBe(1);
    expect(scripted.pending).toEqual([]);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    expect(logged()).toMatch(/Setup ended without saving/);
  });
});
