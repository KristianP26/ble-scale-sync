import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema } from '../../src/config/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

describe('config.yaml.example', () => {
  const raw = readFileSync(join(ROOT, 'config.yaml.example'), 'utf-8');
  const parsed = parseYaml(raw);

  it('parses as valid YAML', () => {
    expect(parsed).toBeDefined();
    expect(parsed).toBeTypeOf('object');
  });

  it('passes AppConfigSchema validation', () => {
    const result = AppConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `config.yaml.example failed schema validation:\n${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it('has version 1', () => {
    expect(parsed.version).toBe(1);
  });

  it('defines at least 2 users', () => {
    expect(parsed.users.length).toBeGreaterThanOrEqual(2);
  });

  it('has global_exporters with at least one entry', () => {
    expect(parsed.global_exporters).toBeDefined();
    expect(parsed.global_exporters.length).toBeGreaterThanOrEqual(1);
  });

  it('has runtime section', () => {
    expect(parsed.runtime).toBeDefined();
    expect(parsed.runtime.continuous_mode).toBe(false);
  });

  it('uses ${ENV_VAR} pattern for secrets', () => {
    expect(raw).toContain('${GARMIN_EMAIL}');
    expect(raw).toContain('${GARMIN_PASSWORD}');
  });
});
