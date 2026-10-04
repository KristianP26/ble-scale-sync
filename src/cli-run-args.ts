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
