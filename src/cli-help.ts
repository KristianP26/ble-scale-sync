/**
 * Help text for the `ble-scale-sync` bin (#365).
 *
 * Kept out of index.ts and run.ts so both print the same options and
 * environment list, and so the dispatcher can answer --help without importing
 * the run path (which builds the 33-adapter registry and the exporter registry
 * at module evaluation).
 */

const USAGE = 'Usage: ble-scale-sync [command] [options]';

const COMMANDS: readonly string[] = [
  '  (none)                 Run the sync flow (same as start)',
  '  start                  Run the sync flow',
  '  setup                  Interactive setup wizard',
  '  setup-garmin [args]    Garmin Connect authentication (needs Python 3)',
  '  setup-strava           Strava OAuth token setup',
  '  scan                   Discover nearby BLE devices',
  '  diagnose [MAC]         BLE diagnostic dump (services, characteristics, flags)',
  '  validate               Validate config.yaml and exit',
  '  help                   Show this help message',
];

const OPTIONS: readonly string[] = [
  '  -c, --config <path>  Path to config.yaml (default: ./config.yaml)',
  '  -h, --help           Show this help message',
];

const ENV_OVERRIDES: readonly string[] = [
  '  CONTINUOUS_MODE  true/false  override runtime.continuous_mode',
  '  DRY_RUN          true/false  override runtime.dry_run',
  '  DEBUG            true/false  override runtime.debug',
  '  SCAN_COOLDOWN    5-3600      override runtime.scan_cooldown',
  '  BLE_WATCHDOG_MAX_FAILURES 0-1000  override runtime.watchdog_max_consecutive_failures (0 = disabled)',
  '  BLE_HARD_EXIT_GRACE_MS 1000-60000  force-exit floor for hung shutdown (default 5000)',
  '  SCALE_MAC        MAC/UUID    override ble.scale_mac',
  '  NOBLE_DRIVER     abandonware/stoprocent  override ble.noble_driver',
  '  BLE_ADAPTER      hci0/hci1/...  override ble.adapter (Linux only)',
];

const FROM_CHECKOUT =
  'From a git checkout the same commands are npm scripts: npm start, npm run setup, ' +
  'npm run scan, npm run diagnose, npm run validate.';

function printOptionsAndEnv(): void {
  console.log('Options:');
  for (const line of OPTIONS) console.log(line);
  console.log('');
  console.log('Environment overrides (always applied, even with config.yaml):');
  for (const line of ENV_OVERRIDES) console.log(line);
}

/** Full help: commands, options, environment. Printed by the bin entry point. */
export function printRootHelp(): void {
  console.log('BLE Scale Sync');
  console.log('');
  console.log(USAGE);
  console.log('');
  console.log('Commands:');
  for (const line of COMMANDS) console.log(line);
  console.log('');
  printOptionsAndEnv();
  console.log('');
  console.log(FROM_CHECKOUT);
}

/** Options and environment only, for a direct `node dist/run.js --help`. */
export function printRunHelp(): void {
  console.log('Usage: ble-scale-sync [--config <path>]');
  console.log('');
  printOptionsAndEnv();
}
