import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadYamlConfig } from '../../src/config/load.js';
import { resolveRuntimeConfig } from '../../src/config/resolve.js';
import { createAppContext, type AppContext } from '../../src/runtime/context.js';
import { reloadAppConfig, userDisplaySnapshot } from '../../src/runtime/reload.js';
import { getExportersForUser } from '../../src/runtime/exporters.js';

/**
 * A config.yaml whose exporter entry cannot be built still passes
 * loadYamlConfig: exporter entries are passthrough and only an unknown `type`
 * is filtered there. The reload contract is "keep the current config" on a bad
 * edit, but the exporters were only built after the new config was installed,
 * so a typo in an exporter wedged every following cycle (E-07).
 */

function yaml(opts: { cooldown: number; webhookUrl?: string }): string {
  return `
version: 1
ble:
  scale_mac: "FF:03:00:13:A1:04"
scale:
  weight_unit: kg
  height_unit: cm
unknown_user: nearest
users:
  - name: Test
    slug: test
    height: 183
    birth_date: "1990-06-15"
    gender: male
    is_athlete: true
    weight_range: { min: 70, max: 100 }
    last_known_weight: null
global_exporters:
  - type: webhook
${opts.webhookUrl ? `    url: "${opts.webhookUrl}"\n` : ''}runtime:
  continuous_mode: true
  scan_cooldown: ${opts.cooldown}
  dry_run: false
  debug: false
`;
}

describe('reloadAppConfig with an exporter that cannot be built (E-07)', () => {
  let dir: string;
  let file: string;
  let ctx: AppContext;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-'));
    file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, yaml({ cooldown: 30, webhookUrl: 'https://example.invalid/hook' }));
    const config = loadYamlConfig(file);
    ctx = createAppContext({
      config,
      resolved: resolveRuntimeConfig(config),
      configSource: 'yaml',
      configPath: file,
      signal: new AbortController().signal,
      abortApp: () => {},
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps the current config when an exporter entry is invalid', async () => {
    const before = ctx.config;
    // Same edit also changes a hot-swappable field, so a half-applied reload
    // is visible, not just a thrown error.
    fs.writeFileSync(file, yaml({ cooldown: 99 }));

    await reloadAppConfig(ctx, { value: userDisplaySnapshot(ctx.config) });

    expect(ctx.config).toBe(before);
    expect(ctx.config.runtime?.scan_cooldown).toBe(30);
    expect(() => getExportersForUser(ctx, 'test')).not.toThrow();
    expect(getExportersForUser(ctx, 'test').map((e) => e.name)).toEqual(['webhook']);
  });

  it('still applies a valid edit', async () => {
    fs.writeFileSync(file, yaml({ cooldown: 99, webhookUrl: 'https://example.invalid/other' }));

    await reloadAppConfig(ctx, { value: userDisplaySnapshot(ctx.config) });

    expect(ctx.config.runtime?.scan_cooldown).toBe(99);
    expect(getExportersForUser(ctx, 'test').map((e) => e.name)).toEqual(['webhook']);
  });
});
