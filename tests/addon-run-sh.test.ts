import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Guards for the Home Assistant add-on wiring. Nothing executes run.sh in CI
 * (it needs /data, the Supervisor and a Debian base), so the add-on manifest
 * and the script are read as text, and the one piece of embedded Python is run
 * on its own.
 *
 * Line endings are normalized: Windows checkouts have core.autocrlf on.
 */
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

const RUN_SH = lf(readFileSync('ble-scale-sync-addon/run.sh', 'utf8'));
const MANIFEST = parse(lf(readFileSync('ble-scale-sync-addon/config.yaml', 'utf8'))) as {
  services?: string[];
  options: Record<string, unknown>;
};

/** The Supervisor's own validator for this key (supervisor/apps/validate.py, RE_SERVICE). */
const RE_SERVICE = /^(?<service>mqtt|mysql):(?<rights>provide|want|need)$/;

/** The custom_config branch of run.sh, up to the `else` that starts option generation. */
function customConfigBranch(): string {
  const start = RUN_SH.indexOf('if [ "$CUSTOM_CONFIG" = "true" ]; then');
  const end = RUN_SH.indexOf('\nelse\n', start);
  expect(start, 'custom_config branch not found in run.sh').toBeGreaterThan(-1);
  expect(end, 'end of the custom_config branch not found in run.sh').toBeGreaterThan(start);
  return RUN_SH.slice(start, end);
}

describe('add-on manifest: Supervisor services', () => {
  it('declares every service run.sh reads from the Supervisor API', () => {
    // The Supervisor answers 403 to GET /services/<name> unless the add-on
    // declares <name> under `services:`. The declaration was missing, so MQTT
    // auto-detection failed on every install.
    const used = [...RUN_SH.matchAll(/http:\/\/supervisor\/services\/(\w+)/g)].map((m) => m[1]);
    expect(used).toContain('mqtt');
    const declared = new Map(
      (MANIFEST.services ?? []).map((entry) => {
        const m = RE_SERVICE.exec(entry);
        expect(
          m,
          `services entry '${entry}' does not match the Supervisor's format`,
        ).not.toBeNull();
        return [m!.groups!.service, m!.groups!.rights] as const;
      }),
    );
    for (const service of used) {
      expect(declared.has(service), `config.yaml must declare services: ${service}:want`).toBe(
        true,
      );
    }
  });

  it('asks for MQTT as optional, since a Garmin-only install has no broker', () => {
    expect(MANIFEST.services).toContain('mqtt:want');
  });

  it('tells a Supervisor refusal apart from a missing broker', () => {
    // Without the status code a 403 and "Mosquitto not installed" produced the
    // same log line, which is how the missing declaration went unnoticed.
    expect(RUN_SH).toMatch(
      /curl -s -w '\\n%\{http_code\}'[^\n]*\n\s*http:\/\/supervisor\/services\/mqtt/,
    );
    expect(RUN_SH).toMatch(/^\s*403\)/m);
  });
});

describe('add-on option proxy_liveness_timeout_min', () => {
  it('is an add-on option', () => {
    expect(MANIFEST.options).toHaveProperty('proxy_liveness_timeout_min', 30);
  });

  it('is read in custom_config mode, the only mode that can run a proxy transport', () => {
    // The liveness check only runs on the proxy transports, and the generated
    // config never selects one. Read only in the generated branch, the option
    // could not have any effect at all.
    expect(customConfigBranch()).toMatch(/opt_int proxy_liveness_timeout_min 30/);
  });

  describe('the embedded merge into the custom config', () => {
    const script = /python3 - "\$FRESH" "\$PROXY_LIVENESS_MIN" <<'PY'[^\n]*\n([\s\S]*?)\nPY\n/.exec(
      customConfigBranch(),
    )?.[1];

    // python3 on Linux and macOS, python on Windows; the add-on image has PyYAML.
    const interpreter = ['python3', 'python'].find(
      (bin) => spawnSync(bin, ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0,
    );

    function run(fileContent: string, value: string): { status: number | null; out: unknown } {
      const dir = mkdtempSync(join(tmpdir(), 'addon-liveness-'));
      try {
        const file = join(dir, 'config.yaml');
        writeFileSync(file, fileContent);
        const res = spawnSync(interpreter!, ['-', file, value], {
          input: script,
          encoding: 'utf8',
        });
        return { status: res.status, out: parse(readFileSync(file, 'utf8')) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('exists in run.sh', () => {
      expect(script, 'embedded python for proxy_liveness_timeout_min not found').toBeDefined();
    });

    it.skipIf(!interpreter)('adds the option when the file does not set it', () => {
      const r = run('version: 1\nble:\n  handler: esphome-proxy\n', '0');
      expect(r.status).toBe(0);
      expect(r.out).toMatchObject({
        ble: { handler: 'esphome-proxy', proxy_liveness_timeout_min: 0 },
      });
    });

    it.skipIf(!interpreter)('creates the ble section when there is none', () => {
      const r = run('version: 1\nble: null\n', '90');
      expect(r.status).toBe(0);
      expect(r.out).toMatchObject({ ble: { proxy_liveness_timeout_min: 90 } });
    });

    it.skipIf(!interpreter)('leaves a value set in the file alone', () => {
      const r = run('version: 1\nble:\n  proxy_liveness_timeout_min: 45\n', '0');
      expect(r.status).toBe(3);
      expect(r.out).toMatchObject({ ble: { proxy_liveness_timeout_min: 45 } });
    });

    it.skipIf(!interpreter)('rejects a value outside the schema range', () => {
      const r = run('version: 1\n', '5000');
      expect(r.status).toBe(4);
      expect(r.out).toEqual({ version: 1 });
    });
  });
});
