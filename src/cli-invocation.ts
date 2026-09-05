/**
 * How this process was started, so a hint names a command the reader can
 * actually type (#365).
 *
 * The same code now runs three ways: `npm start` from a clone,
 * `ble-scale-sync` from an npm install, and `npx ble-scale-sync`. Telling a
 * clone user to run `ble-scale-sync` names a bin they do not have, and telling
 * an installed user to run `npm run setup` names a package.json they do not
 * have either, so the hint is built from the invocation rather than hardcoded.
 *
 * Measured on npm 11.6.2:
 *   npm start        -> npm_command=start, npm_lifecycle_event=start
 *   npm run <script> -> npm_command=run,   npm_lifecycle_event=<script>
 *   npx <bin>        -> npm_command=exec,  npm_lifecycle_event=npx
 *   ./node_modules/.bin/<bin>, plain node -> neither is set
 */

type Env = Record<string, string | undefined>;

/** True only for `npm start` / `npm run <script>`, never for npx or a bin. */
export function invokedViaNpmScript(env: Env = process.env): boolean {
  const command = env.npm_command;
  if (command !== undefined && command !== '') {
    return command === 'run' || command === 'start' || command === 'test';
  }
  // npm_command predates none of the supported npm versions, but a wrapper
  // that only forwards npm_lifecycle_event should still not be read as npx.
  const lifecycle = env.npm_lifecycle_event;
  return lifecycle !== undefined && lifecycle !== '' && lifecycle !== 'npx';
}

/**
 * The command line to print for a subcommand, in the shape that works where
 * the process is running. `cliCommand()` with no argument is the run path.
 *
 * `args` are appended after the npm `--` separator when needed, so
 * `cliCommand('setup', ['--config', 'x.yaml'])` is a runnable line in both
 * shapes.
 */
export function cliCommand(
  subcommand?: string,
  args: readonly string[] = [],
  env: Env = process.env,
): string {
  const tail = args.length > 0 ? ` ${args.join(' ')}` : '';

  if (!invokedViaNpmScript(env)) {
    return `ble-scale-sync${subcommand ? ` ${subcommand}` : ''}${tail}`;
  }

  const base = subcommand === undefined ? 'npm start' : `npm run ${subcommand}`;
  return args.length > 0 ? `${base} --${tail}` : base;
}
