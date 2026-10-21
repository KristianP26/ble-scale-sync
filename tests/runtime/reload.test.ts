import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadYamlConfig } from '../../src/config/load.js';
import { resolveRuntimeConfig } from '../../src/config/resolve.js';
import { createAppContext, type AppContext } from '../../src/runtime/context.js';
import { reloadAppConfig, userDisplaySnapshot } from '../../src/runtime/reload.js';
import { getExportersForUser, resolveQueuedExporter } from '../../src/runtime/exporters.js';

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

/**
 * Two exporters of one type in one list: only the D029 slot tells them apart.
 * The reload refilled the cache with instances built without a slot, so a
 * queued entry for the second one resolved to nothing and was dropped (R-01).
 */
describe('reloadAppConfig and the exporter slots (D029)', () => {
  function twoWebhooks(cooldown: number): string {
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
    exporters:
      - type: webhook
        url: "https://example.invalid/first"
      - type: webhook
        url: "https://example.invalid/second"
runtime:
  continuous_mode: true
  scan_cooldown: ${cooldown}
  dry_run: false
  debug: false
`;
  }

  it('resolves a queued entry to its own slot after a reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-slots-'));
    const file = path.join(dir, 'config.yaml');
    try {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(file, twoWebhooks(30));
      const config = loadYamlConfig(file);
      const ctx = createAppContext({
        config,
        resolved: resolveRuntimeConfig(config),
        configSource: 'yaml',
        configPath: file,
        signal: new AbortController().signal,
        abortApp: () => {},
      });

      fs.writeFileSync(file, twoWebhooks(99));
      await reloadAppConfig(ctx, { value: userDisplaySnapshot(ctx.config) });
      expect(ctx.config.runtime?.scan_cooldown).toBe(99);

      const [first, second] = getExportersForUser(ctx, 'test');
      const queued = { exporter: 'webhook', userSlug: 'test', exporterList: 'user' as const };
      expect(resolveQueuedExporter(ctx, { ...queued, exporterIndex: 1 })).toBe(second);
      expect(resolveQueuedExporter(ctx, { ...queued, exporterIndex: 0 })).toBe(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});

describe('reloadAppConfig and the restored replay anchors (D067)', () => {
  it('keeps the weigh-ins an earlier process saved across a reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-anchors-'));
    const file = path.join(dir, 'config.yaml');
    const anchors = path.join(dir, '.last-live-weigh-ins.json');
    try {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(file, yaml({ cooldown: 30, webhookUrl: 'https://example.invalid/hook' }));
      fs.writeFileSync(
        anchors,
        JSON.stringify({ test: { weight: 82.3, time: '2026-10-19T07:00:00.000Z' } }),
      );
      const config = loadYamlConfig(file);
      const ctx = createAppContext({
        config,
        resolved: resolveRuntimeConfig(config),
        configSource: 'yaml',
        configPath: file,
        replayAnchorsPath: anchors,
        signal: new AbortController().signal,
        abortApp: () => {},
      });
      expect(ctx.lastExportedWeights.get('test')).toBe(82.3);

      fs.writeFileSync(file, yaml({ cooldown: 99, webhookUrl: 'https://example.invalid/hook' }));
      await reloadAppConfig(ctx, { value: userDisplaySnapshot(ctx.config) });

      expect(ctx.config.runtime?.scan_cooldown).toBe(99);
      expect(ctx.lastExportedWeights.get('test')).toBe(82.3);
      expect(ctx.lastExportedAt.get('test')?.toISOString()).toBe('2026-10-19T07:00:00.000Z');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
