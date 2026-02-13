#!/usr/bin/env tsx

import { parseArgs } from 'node:util';
import { loadAppConfig } from './load.js';
import { resolveExportersForUser } from './resolve.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: false,
});

if (values.help) {
  console.log('Usage: npm run validate [-- --config <path>]');
  console.log('');
  console.log('Options:');
  console.log('  -c, --config <path>  Path to config.yaml (default: ./config.yaml)');
  console.log('  -h, --help           Show this help message');
  process.exit(0);
}

try {
  const { source, config } = loadAppConfig(values.config as string | undefined);
  const userCount = config.users.length;
  const exporterCount = config.users.reduce(
    (sum, u) => sum + resolveExportersForUser(config, u).length,
    0,
  );
  const continuous = config.runtime?.continuous_mode ? 'on' : 'off';

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
