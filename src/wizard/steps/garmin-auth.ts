import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WizardStep, WizardContext } from '../types.js';
import type { UserConfig, ExporterEntry } from '../../config/schema.js';
import { success, error, warn, dim } from '../ui.js';

const __dirname: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(__dirname, '..', '..', '..');

interface GarminUser {
  userName: string;
  entry: ExporterEntry;
}

function getUsersWithGarmin(ctx: WizardContext): GarminUser[] {
  const results: GarminUser[] = [];

  // Global garmin entries apply to all users
  for (const e of ctx.config.global_exporters ?? []) {
    if (e.type === 'garmin') {
      for (const u of ctx.config.users ?? []) {
        results.push({ userName: (u as UserConfig).name, entry: e });
      }
    }
  }

  // Per-user garmin entries
  for (const u of ctx.config.users ?? []) {
    const user = u as UserConfig;
    for (const e of user.exporters ?? []) {
      if ((e as ExporterEntry).type === 'garmin') {
        results.push({ userName: user.name, entry: e as ExporterEntry });
      }
    }
  }

  return results;
}

interface SetupGarminOptions {
  email?: string;
  password?: string;
  tokenDir?: string;
}

function runSetupGarmin(pythonCmd: string, options: SetupGarminOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const scriptPath = join(ROOT, 'garmin-scripts', 'setup_garmin.py');
    const args: string[] = [scriptPath];

    if (options.tokenDir) {
      const home = process.env.HOME || process.env.USERPROFILE;
      const expanded = home ? options.tokenDir.replace(/^~/, home) : options.tokenDir;
      args.push('--token-dir', expanded);
    }

    // Pass credentials via env vars (not CLI args) to avoid ps visibility
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.email) env.GARMIN_EMAIL = options.email;
    if (options.password) env.GARMIN_PASSWORD = options.password;

    const proc = spawn(pythonCmd, args, {
      stdio: 'inherit',
      timeout: 120_000,
      env,
    });

    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

export const garminAuthStep: WizardStep = {
  id: 'garmin-auth',
  title: 'Garmin Authentication',
  order: 50,

  shouldRun(ctx: WizardContext): boolean {
    return getUsersWithGarmin(ctx).length > 0;
  },

  async run(ctx: WizardContext): Promise<void> {
    if (!ctx.platform.hasPython || !ctx.platform.pythonCommand) {
      console.log(`\n  ${dim('Python is not available — skipping Garmin authentication.')}`);
      console.log(dim('  You can run it later with: npm run setup-garmin\n'));
      return;
    }

    const garminUsers = getUsersWithGarmin(ctx);

    // Check token_dir uniqueness
    const tokenDirs = garminUsers
      .map((g) => (g.entry as Record<string, unknown>).token_dir as string | undefined)
      .filter(Boolean) as string[];
    const duplicates = tokenDirs.filter((d, i) => tokenDirs.indexOf(d) !== i);
    if (duplicates.length > 0) {
      console.log(
        `\n  ${warn(`Duplicate token_dir detected: ${[...new Set(duplicates)].join(', ')}`)}`,
      );
      console.log(warn('  Each user should have a unique token_dir to avoid auth conflicts.\n'));
    }

    // Per-user auth loop
    for (const { userName, entry } of garminUsers) {
      const runAuth = await ctx.prompts.confirm(
        `Run Garmin auth for ${userName}? (requires email + password)`,
        { default: true },
      );

      if (!runAuth) {
        console.log(dim(`  Skipped ${userName}. Run later with: npm run setup-garmin`));
        continue;
      }

      const entryRecord = entry as Record<string, unknown>;
      const options: SetupGarminOptions = {
        email: entryRecord.email as string | undefined,
        password: entryRecord.password as string | undefined,
        tokenDir: entryRecord.token_dir as string | undefined,
      };

      console.log(`\n  Running Garmin setup for ${userName}...\n`);

      let authOk = await runSetupGarmin(ctx.platform.pythonCommand, options);

      if (!authOk) {
        const retry = await ctx.prompts.confirm(`Garmin auth failed for ${userName}. Retry?`, {
          default: true,
        });
        if (retry) {
          authOk = await runSetupGarmin(ctx.platform.pythonCommand, options);
        }
      }

      if (authOk) {
        console.log(`\n  ${success(`Garmin authentication successful for ${userName}!`)}`);
      } else {
        console.log(
          `\n  ${error(`Garmin auth failed for ${userName}. You can retry later with: npm run setup-garmin`)}`,
        );
      }
    }
  },
};

// Exported for testing
export { getUsersWithGarmin };
