#!/usr/bin/env node

/**
 * The one bin this package ships (#365).
 *
 * Dispatches on the first positional argument and delegates to the module that
 * already implements that command. Every delegate is a self-executing top-level
 * script, exactly as `npm run <script>` invokes it through tsx, so both shapes
 * stay alive with one implementation each.
 *
 * Nothing but two side-effect-free local modules is imported at the top on
 * purpose. The run path (./run.js) builds the 33-adapter registry, the exporter
 * registry and the mqtt-proxy graph at module evaluation, and
 * `ble-scale-sync validate` must not pay for any of it.
 */

import { classifyArgs, type Subcommand } from './cli-dispatch.js';
import { printRootHelp } from './cli-help.js';

/**
 * Literal specifiers, not a lookup table: tsc resolves and typechecks each one,
 * and there is no computed import to go stale.
 */
async function runSubcommand(command: Subcommand): Promise<void> {
  switch (command) {
    case 'start':
      await import('./run.js');
      return;
    case 'setup':
      await import('./wizard/index.js');
      return;
    case 'setup-garmin':
      await import('./setup-garmin.js');
      return;
    case 'setup-strava':
      await import('./exporters/strava-setup.js');
      return;
    case 'scan':
      await import('./scan.js');
      return;
    case 'diagnose':
      await import('./diagnose.js');
      return;
    case 'validate':
      await import('./config/validate-cli.js');
      return;
  }
}

async function main(): Promise<void> {
  const dispatch = classifyArgs(process.argv.slice(2));

  switch (dispatch.kind) {
    case 'run':
      await import('./run.js');
      return;

    case 'help':
      printRootHelp();
      return;

    case 'unknown':
      console.error(`Unknown command: ${dispatch.word}`);
      console.error('');
      printRootHelp();
      process.exitCode = 2;
      return;

    case 'command':
      // Drop the command word so every delegate sees the argv shape it sees
      // today under `npm run <script>`: diagnose.ts reads the target MAC from
      // process.argv[2], and the wizard hand-scans process.argv.slice(2).
      process.argv.splice(2, 1);
      // Importing a delegate runs it, and the import settles when module
      // evaluation finishes, not when the command does: the async entries fire
      // main() detached with their own .catch. Nothing may follow this await,
      // and nothing here may call process.exit().
      await runSubcommand(dispatch.command);
      return;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
