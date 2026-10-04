/**
 * Entry point of `ble-scale-sync setup` and `npm run setup`: runs the wizard
 * on import, as src/index.ts expects of every subcommand module. The wizard
 * itself is in setup-command.ts, where a test can reach it.
 */
import { runSetupCommand } from './setup-command.js';

void runSetupCommand(process.argv.slice(2)).then((code) => process.exit(code));
