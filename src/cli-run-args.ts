import { parseArgs } from 'node:util';
import { SUBCOMMANDS } from './cli-dispatch.js';

/**
 * Argument parsing for the run path (`ble-scale-sync [--config <path>]`).
 *
 * Pure for the same reason as cli-dispatch.ts: run.ts starts the app at module
 * evaluation, so the rule has to live where a test can import it.
 *
 * Strict on purpose (G-16). A leading flag sends everything to the run path,
 * and a lenient parse ignored whatever it did not recognise there:
 * `--config x.yaml validate` started a BLE scan and exported instead of
 * validating, `--conifg x.yaml` silently fell back to the default config, and a
 * trailing `--config` with no value became `config: true`. Each of those runs
 * the wrong thing without a word, which on a health-data pipeline is worse
 * than refusing to start.
 */
export type RunArgs =
  { kind: 'ok'; config: string | undefined; help: boolean } | { kind: 'error'; message: string };

export function parseRunArgs(args: readonly string[]): RunArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        config: { type: 'string', short: 'c' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  // Positionals are allowed through parseArgs only so this can name the likely
  // mistake: a subcommand typed after a flag instead of before it.
  const [first] = parsed.positionals;
  if (first !== undefined) {
    const isCommand = (SUBCOMMANDS as readonly string[]).includes(first);
    return {
      kind: 'error',
      message: isCommand
        ? `Unexpected argument '${first}'. Subcommands go first: ble-scale-sync ${first} [options]`
        : `Unexpected argument '${first}'`,
    };
  }

  return { kind: 'ok', config: parsed.values.config, help: parsed.values.help === true };
}

/**
 * The MAC address given to `diagnose`, if any: the first argument that is
 * neither a flag nor the value of `--config`/`-c`.
 *
 * Only `argv[2]` used to be read, so `diagnose --native AA:BB:CC:DD:EE:FF`
 * ignored the MAC and fell back to the configured one (G-23).
 */
export function diagnoseMacArg(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' || arg === '-c') {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

export type ToolConfigArg =
  { kind: 'ok'; config: string | undefined } | { kind: 'error'; message: string };

/**
 * The `--config`/`-c` path given to `scan` or `diagnose`, if any (G-05).
 *
 * Both tools used to ignore it and always read the default config.yaml. Other
 * arguments are left alone: diagnose takes a MAC and `--native`, and scan has
 * never refused anything, so this only picks the config path out. A
 * `--config` without a path is an error rather than a silent fall back to the
 * default file.
 */
export function toolConfigArg(args: readonly string[]): ToolConfigArg {
  let config: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value: string | undefined;
    if (arg === '--config' || arg === '-c') {
      value = args[i + 1];
      if (value === undefined || value.startsWith('-')) value = '';
      else i++;
    } else if (arg.startsWith('--config=')) {
      value = arg.slice('--config='.length);
    } else {
      continue;
    }
    if (value === '') {
      return { kind: 'error', message: `Option '${arg}' needs a path to config.yaml` };
    }
    config = value;
  }
  return { kind: 'ok', config };
}
