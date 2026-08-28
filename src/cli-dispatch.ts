/**
 * Argument classification for the single `ble-scale-sync` bin (#365).
 *
 * Pure on purpose: src/index.ts is a self-executing entry point, so the rule
 * that decides "is this a subcommand or a flag" has to live somewhere a test
 * can import without launching the app.
 */

/**
 * Every word the bin accepts as a first positional. The list is intentionally
 * the same vocabulary docker-entrypoint.sh already exposes, so a user moving
 * between `docker run ... <cmd>` and `ble-scale-sync <cmd>` types the same word.
 */
export const SUBCOMMANDS = [
  'start',
  'setup',
  'setup-garmin',
  'setup-strava',
  'scan',
  'diagnose',
  'validate',
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export type Dispatch =
  | { kind: 'run' }
  | { kind: 'help' }
  | { kind: 'command'; command: Subcommand }
  | { kind: 'unknown'; word: string };

function isSubcommand(word: string): word is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(word);
}

/**
 * Classify the arguments after `node <script>`.
 *
 * A leading "-" is always a flag for the run path and is never treated as a
 * command. The Home Assistant add-on starts the app as
 * `node dist/index.js --config /data/config.yaml`, so getting this branch wrong
 * breaks every add-on install on the next release.
 *
 * An unknown non-flag first word is an error rather than a silent fall-through
 * to the run path: the run path reads no positionals at all, so
 * `ble-scale-sync scna` starting a scan would be a real regression.
 */
export function classifyArgs(args: readonly string[]): Dispatch {
  const first = args[0];
  if (first === undefined) return { kind: 'run' };
  if (first === '-h' || first === '--help') return { kind: 'help' };
  if (first.startsWith('-')) return { kind: 'run' };
  if (first === 'help') return { kind: 'help' };
  if (isSubcommand(first)) return { kind: 'command', command: first };
  return { kind: 'unknown', word: first };
}
