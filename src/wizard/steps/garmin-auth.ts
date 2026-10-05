import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { WizardStep, WizardContext } from '../types.js';
import type { UserConfig, ExporterEntry } from '../../config/schema.js';
import { success, error, warn, dim } from '../ui.js';
import { cliCommand } from '../../cli-invocation.js';
import { findTokenDirCollisions, resolveTokenDir } from '../../config/token-dirs.js';
import { resolveEnvReferences } from '../../config/env-refs.js';
import { errMsg } from '../../utils/error.js';

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
  /** The config being written; a relative TOKEN_DIR and .env resolve next to it. */
  configPath?: string;
}

function runSetupGarmin(pythonCmd: string, options: SetupGarminOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const scriptPath = join(ROOT, 'garmin-scripts', 'setup_garmin.py');
    const args: string[] = [scriptPath];

    if (options.tokenDir) {
      args.push('--token-dir', options.tokenDir);
    }
    if (options.configPath) {
      args.push('--config-path', options.configPath);
    }

    // Pass credentials via env vars (not CLI args) to avoid ps visibility
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.email) env.GARMIN_EMAIL = options.email;
    if (options.password) env.GARMIN_PASSWORD = options.password;

    // No timeout: the script is interactive (stdio inherited) and waits for
    // the MFA code as long as the person needs to fetch it. A 120 s cap killed
    // it mid-prompt and reported a failed login (G-23).
    const proc = spawn(pythonCmd, args, {
      stdio: 'inherit',
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
      const why =
        ctx.platform.hasPython && ctx.platform.pythonVersion
          ? `Garmin needs Python 3.12 or newer, found ${ctx.platform.pythonVersion}`
          : 'Python is not available';
      console.log(`\n  ${dim(`${why} — skipping Garmin authentication.`)}`);
      console.log(dim(`  You can run it later with: ${cliCommand('setup-garmin')}\n`));
      return;
    }

    const garminUsers = getUsersWithGarmin(ctx);

    // Two accounts in one token directory: the second auth would overwrite the
    // first, and both users' readings would go to the second account. The old
    // check here dropped entries without token_dir before comparing, so the
    // commonest case (both on the default) passed it. Refuse to auth instead.
    // A relative token_dir is next to the config file being written (F-11),
    // wherever the wizard was started from.
    const configDir = dirname(resolve(ctx.configPath));
    const collisions = findTokenDirCollisions(
      {
        users: (ctx.config.users ?? []) as Parameters<typeof findTokenDirCollisions>[0]['users'],
        global_exporters: ctx.config.global_exporters,
      },
      configDir,
    ).filter((c) => c.type === 'garmin');
    if (collisions.length > 0) {
      for (const c of collisions) console.log(`\n  ${warn(c.message)}`);
      console.log(
        dim(
          `\n  Garmin authentication skipped. Fix token_dir, then run: ${cliCommand('setup-garmin')}\n`,
        ),
      );
      return;
    }

    // Per-user auth loop
    for (const { userName, entry } of garminUsers) {
      const runAuth = await ctx.prompts.confirm(
        `Run Garmin auth for ${userName}? (requires email + password)`,
        { default: true },
      );

      if (!runAuth) {
        console.log(dim(`  Skipped ${userName}. Run later with: ${cliCommand('setup-garmin')}`));
        continue;
      }

      // The config here is the raw YAML (edit mode loads it unresolved so that
      // saving keeps the references), so a ${VAR} would otherwise reach
      // setup_garmin.py as the literal password and overwrite the real
      // GARMIN_PASSWORD in the child's environment. Resolve a copy for use.
      let entryRecord: Record<string, unknown>;
      try {
        entryRecord = resolveEnvReferences(entry as Record<string, unknown>);
      } catch (err) {
        console.log(`\n  ${warn(`${errMsg(err)}. Skipping Garmin auth for ${userName}.`)}`);
        console.log(dim(`  Define it in .env, then run: ${cliCommand('setup-garmin')}`));
        continue;
      }
      const options: SetupGarminOptions = {
        email: entryRecord.email as string | undefined,
        password: entryRecord.password as string | undefined,
        tokenDir:
          typeof entryRecord.token_dir === 'string' && entryRecord.token_dir.trim()
            ? resolveTokenDir(entryRecord.token_dir.trim(), configDir)
            : undefined,
        configPath: resolve(ctx.configPath),
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
          `\n  ${error(
            `Garmin auth failed for ${userName}. You can retry later with: ${cliCommand('setup-garmin')}`,
          )}`,
        );
      }
    }
  },
};

// Exported for testing
export { getUsersWithGarmin };
