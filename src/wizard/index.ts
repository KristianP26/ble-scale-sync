import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { config as dotenvConfig } from 'dotenv';
import { detectPlatform } from './platform.js';
import { createRealPromptProvider } from './prompt-provider.js';
import { runWizard, runEditMode } from './runner.js';
import { runNonInteractive } from './non-interactive.js';
import { WIZARD_STEPS } from './steps/index.js';
import type { WizardContext } from './types.js';
import type { AppConfig } from '../config/schema.js';

const __dirname: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = join(ROOT, 'config.yaml');

function printUsage(): void {
  console.log(`
BLE Scale Sync — Setup Wizard

Usage:
  npm run setup                         Interactive setup
  npm run setup -- --config <path>      Use a custom config file path
  npm run setup -- --non-interactive    Validate and enrich existing config.yaml
  npm run setup -- --help               Show this help

If config.yaml already exists, you can choose to edit it or start fresh.
`);
}

function parseArgs(args: string[]): { configPath: string; nonInteractive: boolean; help: boolean } {
  let configPath = DEFAULT_CONFIG_PATH;
  let nonInteractive = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--non-interactive') {
      nonInteractive = true;
    } else if (arg === '--config' && i + 1 < args.length) {
      configPath = resolve(args[++i]);
    }
  }

  return { configPath, nonInteractive, help };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  // Load .env for ${ENV_VAR} references
  const envPath = join(ROOT, '.env');
  if (existsSync(envPath)) {
    dotenvConfig({ path: envPath });
  }

  if (args.nonInteractive) {
    await runNonInteractive(args.configPath);
    return;
  }

  // Detect platform
  const platform = detectPlatform();

  // Create prompt provider
  const prompts = await createRealPromptProvider();

  // Load existing config if editing
  let existingConfig: Partial<AppConfig> = {};
  if (existsSync(args.configPath)) {
    try {
      const raw = readFileSync(args.configPath, 'utf8');
      existingConfig = parseYaml(raw) as Partial<AppConfig>;
    } catch {
      // If the existing config can't be parsed, start fresh
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
    ctx.config.scale = { weight_unit: 'kg', height_unit: 'cm' };
    ctx.config.unknown_user = 'nearest';

    // Run remaining steps (skip welcome since we already ran it)
    const remainingSteps = WIZARD_STEPS.filter((s) => s.id !== 'welcome');
    await runWizard(remainingSteps, ctx);
  }

  process.exit(0);
}

main().catch((err: Error) => {
  if (err.message?.includes('User force closed')) {
    // Ctrl+C during prompt — exit gracefully
    console.log('\n\nSetup cancelled.');
    process.exit(0);
  }
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
