import { parseArgs } from 'node:util';
import { loadAppConfig } from './load.js';
import { resolveExportersForUser } from './resolve.js';
import { createExporterFromEntry } from '../exporters/registry.js';
import { errMsg } from '../utils/error.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
});

if (values.help) {
  console.log('Usage: ble-scale-sync validate [--config <path>]');
  console.log('       npm run validate [-- --config <path>]   (from a git checkout)');
  console.log('');
  console.log('Options:');
  console.log('  -c, --config <path>  Path to config.yaml (default: ./config.yaml)');
  console.log('  -h, --help           Show this help message');
  process.exit(0);
}

try {
  const { source, config } = loadAppConfig(values.config as string | undefined);
  const userCount = config.users.length;
  const continuous = config.runtime?.continuous_mode ? 'on' : 'off';

  // BUILD each exporter, do not just count them.
  //
  // The schema only checks that `type` is a non-empty string; every other
  // exporter field is validated by its factory. Counting therefore reported
  // "Config valid" for a config whose first export would die on a missing
  // `url` or a qos of 99 - which is the one thing this command exists to rule
  // out. Building costs nothing: the factories are pure construction, no
  // network and no credentials used.
  let exporterCount = 0;
  const problems: string[] = [];
  for (const user of config.users) {
    for (const entry of resolveExportersForUser(config, user)) {
      exporterCount += 1;
      try {
        createExporterFromEntry(entry);
      } catch (err) {
        problems.push(`  ${user.slug} / ${entry.type}: ${errMsg(err)}`);
      }
    }
  }

  if (problems.length > 0) {
    console.error(`Config invalid: ${problems.length} exporter(s) could not be configured.`);
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }

  console.log(
    `Config valid \u2713 (source: ${source}, ${userCount} user(s), ${exporterCount} exporter(s), continuous: ${continuous})`,
  );
} catch (err) {
  // Zod errors are logged by loadAppConfig; env-reference / parse errors need explicit logging
  if (err instanceof Error && !err.message.startsWith('Config validation failed')) {
    console.error(err.message);
  }
  process.exit(1);
}
