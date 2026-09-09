import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNonInteractive } from '../../src/wizard/non-interactive.js';

// `setup --non-interactive` used to write back `result.data` whenever the schema
// had merely filled in defaults - and `result.data` is derived from the tree
// with every `${ENV_VAR}` already replaced by its real value. The Garmin
// password, the MQTT password, every exporter token the user had deliberately
// kept in .env was inlined into config.yaml in plaintext, permanently.
//
// It fired on essentially every hand-written config, because the schema fills
// defaults (device_id, topic_prefix, out_of_range, runtime.*) that a
// hand-written file does not carry.

const SECRET = 'correct-horse-battery-staple';

const dirs: string[] = [];
function tempConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bss-ni-'));
  dirs.push(dir);
  const p = join(dir, 'config.yaml');
  writeFileSync(p, body);
  return p;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.TEST_MQTT_PASSWORD;
  vi.restoreAllMocks();
});

const CONFIG = `version: 1
users:
  - name: Dad
    slug: dad
    height: 180
    birth_date: '1990-01-01'
    gender: male
    is_athlete: false
    weight_range:
      min: 60
      max: 110
    exporters:
      - type: mqtt
        host: localhost
        username: dad
        password: \${TEST_MQTT_PASSWORD}
`;

describe('runNonInteractive secret handling', () => {
  it('never writes a resolved ${ENV_VAR} back into config.yaml', async () => {
    process.env.TEST_MQTT_PASSWORD = SECRET;
    const path = tempConfig(CONFIG);

    await runNonInteractive(path);

    const after = readFileSync(path, 'utf8');
    expect(after).not.toContain(SECRET);
    expect(after).toContain('${TEST_MQTT_PASSWORD}');
  });

  it('still auto-generates a missing slug, and still without the secret', async () => {
    process.env.TEST_MQTT_PASSWORD = SECRET;
    const path = tempConfig(CONFIG.replace('    slug: dad\n', ''));

    await runNonInteractive(path);

    const after = readFileSync(path, 'utf8');
    expect(after).toContain('slug: dad');
    expect(after).not.toContain(SECRET);
    expect(after).toContain('${TEST_MQTT_PASSWORD}');
  });

  it('leaves a config that needs no change byte-for-byte alone', async () => {
    // The old code rewrote the file whenever the schema had filled a default,
    // which is almost always - so comments and formatting were lost too.
    process.env.TEST_MQTT_PASSWORD = SECRET;
    const path = tempConfig(`# my notes\n${CONFIG}`);
    const before = readFileSync(path, 'utf8');

    await runNonInteractive(path);

    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
