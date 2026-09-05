/**
 * Pure helpers for `ble-scale-sync setup-garmin` (#365), kept out of
 * setup-garmin.ts because that module spawns Python the moment it is imported.
 */

/**
 * Translate the CLI's argument shape into the one setup_garmin.py accepts.
 *
 * docker-entrypoint.sh already does exactly this translation, and the two CLIs
 * are documented as speaking the same vocabulary, so the subcommand has to do
 * it too. Forwarding argv verbatim is not harmless: `--all-users` is not an
 * argparse option at all (the script dies with "unrecognized arguments"), and
 * `--user Bob` without `--from-config` is accepted but ignored, so the script
 * silently falls back to the legacy GARMIN_EMAIL / GARMIN_PASSWORD flow and
 * authenticates the wrong account into the token directory.
 */
export function translateGarminArgs(args: readonly string[]): string[] {
  if (args.length === 0) return [];
  if (args[0] === '--all-users') return ['--from-config', ...args.slice(1)];
  if (args[0] === '--user' && args[1] !== undefined) {
    return ['--from-config', '--user', args[1], ...args.slice(2)];
  }
  return [...args];
}

/** Parsed `python --version` output, or null when it is not Python 3.x. */
export function parsePythonVersion(output: string): { major: number; minor: number } | null {
  // Python 2 prints the version to stderr, Python 3 to stdout, so callers hand
  // both streams in here rather than trusting one of them.
  const match = /Python (\d+)\.(\d+)/.exec(output);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** The interpreter has to be new enough for the f-strings in our scripts. */
export function isSupportedPython(version: { major: number; minor: number } | null): boolean {
  if (version === null) return false;
  return version.major > 3 || (version.major === 3 && version.minor >= 9);
}
