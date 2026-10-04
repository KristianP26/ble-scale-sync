import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { config as dotenvConfig } from 'dotenv';
import { detectPlatform } from './platform.js';
import { createRealPromptProvider } from './prompt-provider.js';
import { runWizard, runEditMode } from './runner.js';
import { runNonInteractive } from './non-interactive.js';
import { WIZARD_STEPS } from './steps/index.js';
import type { PlatformInfo, PromptProvider, WizardContext } from './types.js';
import type { AppConfig } from '../config/schema.js';
import { defaultConfigPath, envPathFor } from '../config/paths.js';

function printUsage(): void {
  console.log(`
BLE Scale Sync - Setup Wizard

Usage:
  ble-scale-sync setup                      Interactive setup
  ble-scale-sync setup --config <path>      Use a custom config file path
  ble-scale-sync setup --non-interactive    Validate and enrich existing config.yaml
  ble-scale-sync setup --help               Show this help

From a git checkout: npm run setup [-- --config <path>]

If config.yaml already exists, you can choose to edit it or start fresh.
`);
}

function parseArgs(args: string[]): { configPath: string; nonInteractive: boolean; help: boolean } {
  let configPath = defaultConfigPath();
  let nonInteractive = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--non-interactive') {
      nonInteractive = true;
    } else if ((arg === '--config' || arg === '-c') && i + 1 < args.length) {
      configPath = resolve(args[++i]);
    }
  }

  return { configPath, nonInteractive, help };
}

/** Stand-ins for the terminal and the host probe, for tests. */
export interface SetupCommandDeps {
  prompts?: PromptProvider;
  platform?: PlatformInfo;
}

async function runSetup(argv: string[], deps: SetupCommandDeps): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    return;
  }

  // Load .env for ${ENV_VAR} references: the one next to the config file,
  // which is also the one the app reads at run time.
  const envPath = envPathFor(args.configPath);
  if (existsSync(envPath)) {
    dotenvConfig({ path: envPath, quiet: true });
  }

  if (args.nonInteractive) {
    await runNonInteractive(args.configPath);
    return;
  }

  // Detect platform
  const platform = deps.platform ?? detectPlatform();

  // Create prompt provider
  const prompts = deps.prompts ?? (await createRealPromptProvider());

  // Load existing config if editing
  let existingConfig: Partial<AppConfig> = {};
  if (existsSync(args.configPath)) {
    try {
      const raw = readFileSync(args.configPath, 'utf8');
      existingConfig = parseYaml(raw) as Partial<AppConfig>;
    } catch {
      // The welcome step tells the user and does not offer edit mode for it.
    }
  }

  // Build context
  const ctx: WizardContext = {
    config: {},
    configPath: args.configPath,
    isEditMode: false,
    nonInteractive: false,
    platform,
    stepHistory: [],
    prompts,
  };

  // Run welcome step first to determine mode and edit vs fresh
  const welcomeStep = WIZARD_STEPS.find((s) => s.id === 'welcome')!;
  await welcomeStep.run(ctx);

  if (ctx.isEditMode) {
    // Load existing config into context
    ctx.config = { ...existingConfig };
    await runEditMode(WIZARD_STEPS, ctx);
  } else {
    // Set defaults for fresh config
    ctx.config.version = 1;
    ctx.config.scale = { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' };
    ctx.config.unknown_user = 'nearest';

    // Run remaining steps (skip welcome since we already ran it)
    const remainingSteps = WIZARD_STEPS.filter((s) => s.id !== 'welcome');
    await runWizard(remainingSteps, ctx);
  }
}

/** 128 + SIGINT (2): what a shell reports for a command ended by Ctrl+C. */
export const EXIT_CANCELLED = 130;

/**
 * Ctrl+C at a prompt. @inquirer/core rejects the prompt with an
 * ExitPromptError ("User force closed the prompt with SIGINT"); the message is
 * checked as well, which is all the previous code looked at.
 */
function isPromptCancel(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'ExitPromptError' || err.message.includes('User force closed');
}

/**
 * `ble-scale-sync setup` (and `npm run setup`): run the wizard and return the
 * exit code for the process. Kept apart from index.ts, which runs it on
 * import, so a test can drive it.
 *
 * Ctrl+C returns 130, not 0. It used to end with 0, the code of a completed
 * setup, so `ble-scale-sync setup && ...` carried on after a cancelled one
 * (G-23).
 */
export async function runSetupCommand(
  argv: string[],
  deps: SetupCommandDeps = {},
): Promise<number> {
  try {
    await runSetup(argv, deps);
    return 0;
  } catch (err) {
    if (isPromptCancel(err)) {
      console.log('\n\nSetup cancelled.');
      return EXIT_CANCELLED;
    }
    console.error(`\nSetup failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
