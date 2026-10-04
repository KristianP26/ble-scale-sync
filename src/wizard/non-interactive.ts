import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { createAppConfigSchema, formatConfigError } from '../config/schema.js';
import { safeParseWithEnvRefs } from '../config/env-coerce.js';
import { generateSlug } from '../config/slugify.js';
import { parseConfigYaml } from '../config/yaml-parse.js';
import { atomicWrite } from '../config/write.js';
import { createLogger } from '../logger.js';

const log = createLogger('Wizard');

/**
 * Non-interactive mode: load existing YAML, validate, auto-generate missing
 * slugs, and write back atomically.
 *
 * `${ENV_VAR}` references are resolved for VALIDATION ONLY. Nothing resolved
 * may reach the file: see the write-back below.
 */
export async function runNonInteractive(configPath: string): Promise<void> {
  log.info(`Validating ${configPath} (non-interactive mode)...`);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    log.error(`Cannot read config file: ${configPath}`);
    process.exit(1);
  }

  const parsed = parseConfigYaml(raw, configPath) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    log.error('Config file is not a valid YAML object');
    process.exit(1);
  }

  // Auto-generate missing slugs
  let modified = false;
  const users = parsed.users as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(users)) {
    for (const user of users) {
      if (!user.slug && user.name) {
        const taken = users.map((u) => u.slug).filter((s): s is string => typeof s === 'string');
        user.slug = generateSlug(String(user.name), taken);
        log.info(`Auto-generated slug '${user.slug}' for user '${user.name}'`);
        modified = true;
      }
    }
  }

  // Resolve env references and validate, converting a whole ${VAR} in a
  // numeric or boolean field the way loading does (G-21).
  const result = safeParseWithEnvRefs(createAppConfigSchema(dirname(resolve(configPath))), parsed);
  if (!result.success) {
    const msg = formatConfigError(result.error);
    log.error(msg);
    process.exit(1);
  }

  log.info('Config is valid.');
  log.info(`  Users: ${result.data.users.length}`);
  log.info(
    `  Exporters: ${(result.data.global_exporters ?? []).length} global, ${result.data.users.reduce((sum, u) => sum + (u.exporters ?? []).length, 0)} per-user`,
  );

  // Write back ONLY the tree that was read from disk, and only when this run
  // actually changed something in it.
  //
  // This used to also write when Zod had merely filled in defaults, and it
  // wrote `result.data` for that case - a tree derived from `resolved`, i.e.
  // with every `${ENV_VAR}` replaced by the real secret. The Garmin password,
  // the MQTT password, every exporter token the user had deliberately kept in
  // .env was inlined into config.yaml in plaintext, permanently, and the
  // indirection that keeps secrets out of the file people back up and paste
  // into issues was gone. It fired on essentially every hand-written config,
  // because the schema fills defaults (device_id, topic_prefix, out_of_range,
  // runtime.*) that a hand-written file does not carry.
  //
  // Materialising defaults into the file was only ever cosmetic: the schema
  // applies them on every load regardless. So it is dropped rather than fixed.
  if (modified) {
    atomicWrite(configPath, stringifyYaml(parsed, { lineWidth: 0 }));
    log.info(`Updated ${configPath} with auto-generated slugs.`);
  }
}
