import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { loadYamlConfig } from '../src/config/yaml-load.js';
import { collectUnknownKeys } from '../src/config/unknown-keys.js';
import { resolveEnvReferences } from '../src/config/env-refs.js';
import type { AppConfig } from '../src/config/schema.js';
import { snapshotEnv } from './helpers/env-snapshot.js';

/**
 * The generated-config path of the add-on's run.sh, run for real: the marked
 * blocks of the script are put together under dash, the add-on's /bin/sh, with
 * an options.json written here, a stub in place of curl for the Supervisor's
 * services API, and every path pointed at a temp directory. What they write is
 * then loaded with the app's own loadYamlConfig(), ${VAR} references, schema
 * and unknown-key check included.
 *
 * Linux only. jq on Windows writes CRLF, which every option reader passes on
 * into the config, and Git Bash is not dash. In CI on Linux the harness must
 * run: the last test fails, instead of skipping, when something it needs is
 * missing.
 */
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

const RUN_SH = lf(readFileSync('ble-scale-sync-addon/run.sh', 'utf8'));
const MANIFEST = parse(lf(readFileSync('ble-scale-sync-addon/config.yaml', 'utf8'))) as {
  options: Record<string, unknown>;
};

const SHELL = ['dash', 'sh'].find(
  (bin) => spawnSync(bin, ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0,
);
const JQ = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
const JQ_CRLF = JQ && spawnSync('jq', ['-n', '"x"'], { encoding: 'utf8' }).stdout.includes('\r');
const GNU_DATE =
  SHELL !== undefined &&
  spawnSync(SHELL, ['-c', 'date -u -d 2024-02-29 +%F'], { encoding: 'utf8' }).stdout.trim() ===
    '2024-02-29';
const HARNESS = SHELL === 'dash' && JQ && !JQ_CRLF && GNU_DATE;

function block(name: string): string {
  const m = new RegExp(`# >>> ${name}\\n([\\s\\S]*?)# <<< ${name}\\n`).exec(RUN_SH);
  expect(m, `${name} block not found in run.sh`).not.toBeNull();
  return m![1];
}

/** run.sh's own log(), defined above the first marked block. */
function logFunction(): string {
  const m = /^log\(\) \{.*\}$/m.exec(RUN_SH);
  expect(m, 'log() not found in run.sh').not.toBeNull();
  return m![0];
}

/** The blocks that make up the generated-config path, in script order. */
const GENERATE_BLOCKS = [
  'option readers',
  'yaml escape',
  'option checks',
  'ble transport',
  'mode',
  'generate config',
];

interface SupervisorReply {
  code: string;
  body?: unknown;
}

interface GenerateCase {
  options: Record<string, unknown>;
  /** SUPERVISOR_TOKEN in the script's environment; absent when undefined. */
  supervisorToken?: string;
  /** Replies of GET /services/mqtt, in call order; the last one repeats. */
  supervisor?: SupervisorReply[];
}

interface Generated {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The generated config with the temp directory replaced by <tmp>, or null. */
  text: string | null;
  curlCalls: number;
}

// Answers like curl -s -w '\n%{http_code}' does: the body, then the status on
// a line of its own. 000 is curl's "no answer", with a failing exit code.
const CURL_STUB = [
  '#!/bin/sh',
  'n=$(cat "$STUB/calls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB/calls"',
  'last=$(cat "$STUB/replies")',
  '[ "$n" -le "$last" ] || n=$last',
  '[ ! -f "$STUB/reply.$n.body" ] || cat "$STUB/reply.$n.body"',
  'code=$(cat "$STUB/reply.$n.code")',
  'printf \'\\n%s\' "$code"',
  '[ "$code" != "000" ] || exit 7',
  '',
].join('\n');

function generate(c: GenerateCase): Generated {
  const raw = mkdtempSync(join(tmpdir(), 'addon-generate-'));
  const dir = raw.replace(/\\/g, '/');
  try {
    const stub = `${dir}/stub`;
    mkdirSync(stub);
    writeFileSync(`${stub}/curl`, CURL_STUB);
    writeFileSync(`${stub}/sleep`, '#!/bin/sh\nexit 0\n');
    chmodSync(`${stub}/curl`, 0o755);
    chmodSync(`${stub}/sleep`, 0o755);
    const replies = c.supervisor ?? [{ code: '000' }];
    writeFileSync(`${stub}/replies`, String(replies.length));
    replies.forEach((r, i) => {
      writeFileSync(`${stub}/reply.${i + 1}.code`, r.code);
      if (r.body !== undefined)
        writeFileSync(`${stub}/reply.${i + 1}.body`, JSON.stringify(r.body));
    });
    writeFileSync(`${dir}/options.json`, JSON.stringify(c.options));

    const script = [
      'set -e',
      `OPTIONS='${dir}/options.json'`,
      `FRESH='${dir}/fresh.yaml'`,
      logFunction(),
      ...GENERATE_BLOCKS.map(block),
    ]
      .join('\n')
      .replaceAll('/data/garmin-tokens', `${dir}/garmin-tokens`);
    const env: NodeJS.ProcessEnv = { PATH: `${stub}:${process.env.PATH}`, STUB: stub };
    if (c.supervisorToken !== undefined) env.SUPERVISOR_TOKEN = c.supervisorToken;
    const res = spawnSync(SHELL!, ['-c', script], { encoding: 'utf8', env });
    const fresh = `${dir}/fresh.yaml`;
    return {
      status: res.status,
      stdout: res.stdout.replaceAll(dir, '<tmp>'),
      stderr: res.stderr,
      text: existsSync(fresh) ? readFileSync(fresh, 'utf8').replaceAll(dir, '<tmp>') : null,
      curlCalls: existsSync(`${stub}/calls`)
        ? Number(readFileSync(`${stub}/calls`, 'utf8').trim())
        : 0,
    };
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
}

/** Load a generated config the way the app does, from a file of its own. */
function load(text: string): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'addon-generate-load-'));
  try {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, text.replaceAll('<tmp>', dir.replace(/\\/g, '/')));
    return loadYamlConfig(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A generated config that the app loads, with no key it would warn about. */
function expectLoads(r: Generated): AppConfig {
  expect(r.stderr).toBe('');
  expect(r.status, r.stdout).toBe(0);
  expect(r.text).not.toBeNull();
  expect(collectUnknownKeys(parse(r.text!))).toEqual([]);
  return load(r.text!);
}

const DEFAULTS = MANIFEST.options;

/** A broker password the Supervisor hands out, invented. */
const MOSQUITTO_PASSWORD = 'Supervisor-handed-mqtt-password-0001';
const MOSQUITTO_REPLY: SupervisorReply = {
  code: '200',
  body: {
    result: 'ok',
    data: {
      host: 'core-mosquitto',
      port: 1883,
      ssl: false,
      protocol: '3.1.1',
      username: 'addons',
      password: MOSQUITTO_PASSWORD,
    },
  },
};

describe.skipIf(!HARNESS)(
  'add-on run.sh generates a config the app loads',
  { timeout: 30_000 },
  () => {
    let restoreEnv: () => void;
    beforeEach(() => {
      restoreEnv = snapshotEnv();
      delete process.env.SUPERVISOR_TOKEN;
    });
    afterEach(() => restoreEnv());

    // Golden configs, captured from run.sh before the ble_transport work began.
    // Each one holding byte for byte is what shows that ble_transport local, the
    // default, still writes exactly what it wrote before, for these four option
    // sets at least.
    describe('golden configs', () => {
      it('default options, no Supervisor', () => {
        const r = generate({ options: DEFAULTS });
        expectLoads(r);
        expect(r.text).toMatchInlineSnapshot(`
        "version: 1

        scale:
          weight_unit: kg
          height_unit: cm
          display_unit: weight_unit

        unknown_user: nearest
        out_of_range: warn

        users:
          - name: "Default"
            slug: "default"
            height: 170
            birth_date: "1990-01-01"
            gender: male
            is_athlete: false
            weight_range: { min: 40, max: 150 }
            last_known_weight: null

        runtime:
          continuous_mode: true
          scan_cooldown: 30
          idle_rescan_delay: 5
          retry_failed_exports: true
          dry_run: false
          debug: false

        update_check: true
        "
      `);
      });

      it('default options, Mosquitto auto-detected', () => {
        const r = generate({
          options: DEFAULTS,
          supervisorToken: 'supervisor-token-sentinel',
          supervisor: [MOSQUITTO_REPLY],
        });
        const config = expectLoads(r);
        expect(config.global_exporters?.[0]).toMatchObject({ password: MOSQUITTO_PASSWORD });
        expect(r.curlCalls).toBe(1);
        expect(r.text).toMatchInlineSnapshot(`
        "version: 1

        scale:
          weight_unit: kg
          height_unit: cm
          display_unit: weight_unit

        unknown_user: nearest
        out_of_range: warn

        users:
          - name: "Default"
            slug: "default"
            height: 170
            birth_date: "1990-01-01"
            gender: male
            is_athlete: false
            weight_range: { min: 40, max: 150 }
            last_known_weight: null

        global_exporters:
          - type: mqtt
            broker_url: "mqtt://core-mosquitto:1883"
            topic: "scale/body-composition"
            qos: 1
            retain: true
            ha_discovery: true
            ha_device_name: "BLE Scale"
            username: "addons"
            password: "Supervisor-handed-mqtt-password-0001"

        runtime:
          continuous_mode: true
          scan_cooldown: 30
          idle_rescan_delay: 5
          retry_failed_exports: true
          dry_run: false
          debug: false

        update_check: true
        "
      `);
      });

      it('manual broker, scale_mac, a QN byte and a liveness timeout', () => {
        const r = generate({
          options: {
            ...DEFAULTS,
            scale_mac: ' f8:83:06:4e:b6:7e ',
            qn_report_byte: '252',
            proxy_liveness_timeout_min: 45,
            mqtt_auto: false,
            mqtt_broker_url: 'mqtt://192.168.1.10:1883',
            mqtt_username: 'scale',
            mqtt_password: 'plain-password',
          },
        });
        expectLoads(r);
        expect(r.curlCalls).toBe(0);
        expect(r.text).toMatchInlineSnapshot(`
        "version: 1

        ble:
          scale_mac: "f8:83:06:4e:b6:7e"
          qn_report_byte: 252
          proxy_liveness_timeout_min: 45

        scale:
          weight_unit: kg
          height_unit: cm
          display_unit: weight_unit

        unknown_user: nearest
        out_of_range: warn

        users:
          - name: "Default"
            slug: "default"
            height: 170
            birth_date: "1990-01-01"
            gender: male
            is_athlete: false
            weight_range: { min: 40, max: 150 }
            last_known_weight: null

        global_exporters:
          - type: mqtt
            broker_url: "mqtt://192.168.1.10:1883"
            topic: "scale/body-composition"
            qos: 1
            retain: true
            ha_discovery: true
            ha_device_name: "BLE Scale"
            username: "scale"
            password: "plain-password"

        runtime:
          continuous_mode: true
          scan_cooldown: 30
          idle_rescan_delay: 5
          retry_failed_exports: true
          dry_run: false
          debug: false

        update_check: true
        "
      `);
      });

      it('every ble option set, Garmin on, MQTT off', () => {
        const r = generate({
          options: {
            ...DEFAULTS,
            scale_mac: 'F8:83:06:4E:B6:7E',
            ble_adapter: ' HCI1 ',
            force_scale_adapter: 'QN Scale',
            qn_protocol_byte: '255',
            qn_report_byte: '010',
            qn_weight_ack: 'yes',
            qn_a4_prelude: 'true',
            qn_time_sync_long: 'off',
            qn_config_long: '1',
            auto_clear_stale_bond: true,
            preemptive_adapter_reset: false,
            adapter_privacy: true,
            mqtt_enabled: false,
            garmin_enabled: true,
            garmin_email: 'someone@example.com',
            garmin_password: 'garmin-password',
          },
        });
        expectLoads(r);
        expect(r.text).toMatchInlineSnapshot(`
        "version: 1

        ble:
          scale_mac: "F8:83:06:4E:B6:7E"
          adapter: "hci1"
          force_scale_adapter: "QN Scale"
          qn_protocol_byte: 255
          qn_report_byte: 10
          qn_weight_ack: true
          qn_a4_prelude: true
          qn_time_sync_long: false
          qn_config_long: true
          auto_clear_stale_bond: true
          preemptive_adapter_reset: false
          adapter_privacy: true

        scale:
          weight_unit: kg
          height_unit: cm
          display_unit: weight_unit

        unknown_user: nearest
        out_of_range: warn

        users:
          - name: "Default"
            slug: "default"
            height: 170
            birth_date: "1990-01-01"
            gender: male
            is_athlete: false
            weight_range: { min: 40, max: 150 }
            last_known_weight: null

        global_exporters:
          - type: garmin
            email: "someone@example.com"
            password: "garmin-password"
            token_dir: <tmp>/garmin-tokens
            weight_only: false
            upload_timeout_sec: 180

        runtime:
          continuous_mode: true
          scan_cooldown: 30
          idle_rescan_delay: 5
          retry_failed_exports: true
          dry_run: false
          debug: false

        update_check: true
        "
      `);
      });
    });

    describe('option values reach the app as entered', () => {
      it('an MQTT password with a backslash and a ${...}', () => {
        // dash's echo turned the escaped \\ back into \, so the app refused
        // "pa\s" as a bad escape and did not start; the ${x} was read as an
        // environment variable.
        const r = generate({
          options: {
            ...DEFAULTS,
            mqtt_auto: false,
            mqtt_broker_url: 'mqtt://192.168.1.10:1883',
            mqtt_username: 'u\\${mqtt_user}',
            mqtt_password: 'pa\\s${x}',
          },
        });
        const config = expectLoads(r);
        expect(config.global_exporters?.[0]).toMatchObject({
          username: 'u\\${mqtt_user}',
          password: 'pa\\s${x}',
        });
      });

      it('a Garmin password with a ${...}, written through a heredoc', () => {
        const r = generate({
          options: {
            ...DEFAULTS,
            mqtt_enabled: false,
            garmin_enabled: true,
            garmin_email: 'someone@example.com',
            garmin_password: 'g\\w${y}',
          },
        });
        const config = expectLoads(r);
        expect(config.global_exporters?.[0]).toMatchObject({ password: 'g\\w${y}' });
      });
    });

    /** The add-on stopped on a transport it cannot run: no config, no fallback. */
    function expectStopped(r: Generated, error: string): void {
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(`[ble-scale-sync] ERROR: ${error}`);
      expect(r.stdout).toContain('Not falling back to the built-in Bluetooth adapter');
      expect(r.text ?? '').not.toContain('handler');
    }

    describe('ble_transport', () => {
      it('stops on a value the Supervisor would not have let through', () => {
        const r = generate({ options: { ...DEFAULTS, ble_transport: 'bogus' } });
        expectStopped(r, "ble_transport 'bogus' is not one of");
      });

      it('names transport options set for no use with local', () => {
        const r = generate({ options: { ...DEFAULTS, esphome_proxy_host: '192.168.1.50' } });
        const config = expectLoads(r);
        expect(config.ble?.handler ?? 'auto').toBe('auto');
        expect(r.stdout).toContain('so they are ignored: esphome_proxy_host.');
        expect(r.text).not.toContain('esphome_proxy');
      });

      it('local still says the liveness timeout does nothing there', () => {
        const r = generate({ options: { ...DEFAULTS, proxy_liveness_timeout_min: 45 } });
        expectLoads(r);
        expect(r.stdout).toContain('NOTE: proxy_liveness_timeout_min only affects a proxy');
      });
    });

    describe('ble_transport esphome-proxy', () => {
      /** A key of the right shape, invented here. */
      const KEY = Buffer.alloc(32, 7).toString('base64');
      const ESPHOME = {
        ...DEFAULTS,
        ble_transport: 'esphome-proxy',
        esphome_proxy_host: ' 192.168.1.50 ',
        esphome_proxy_encryption_key: ` ${KEY} `,
      };

      it('writes the proxy the app connects to, and never logs the key', () => {
        const r = generate({ options: ESPHOME });
        const config = expectLoads(r);
        expect(config.ble?.handler).toBe('esphome-proxy');
        expect(config.ble?.esphome_proxy).toMatchObject({
          host: '192.168.1.50',
          port: 6053,
          encryption_key: KEY,
        });
        expect(r.stdout).toContain(
          'Bluetooth transport: esphome-proxy (192.168.1.50:6053, encrypted)',
        );
        expect(r.stdout).not.toContain(KEY);
      });

      it('writes no key line for a device without API encryption', () => {
        const r = generate({
          options: { ...ESPHOME, esphome_proxy_encryption_key: '', esphome_proxy_port: 6054 },
        });
        const config = expectLoads(r);
        expect(config.ble?.esphome_proxy).toMatchObject({ host: '192.168.1.50', port: 6054 });
        expect(r.text).not.toContain('encryption_key');
        expect(r.stdout).toContain('(192.168.1.50:6054, unencrypted)');
      });

      it('leaves out the options only the built-in adapter uses, and says so', () => {
        const r = generate({
          options: {
            ...ESPHOME,
            scale_mac: 'F8:83:06:4E:B6:7E',
            ble_adapter: 'hci1',
            adapter_privacy: true,
            auto_clear_stale_bond: true,
            preemptive_adapter_reset: false,
          },
        });
        const config = expectLoads(r);
        expect(config.ble?.scale_mac).toBe('F8:83:06:4E:B6:7E');
        expect(r.text).not.toMatch(/adapter:|adapter_privacy|auto_clear_stale_bond|preemptive/);
        expect(r.stdout).toContain(
          'NOTE: ble_transport esphome-proxy does not use the built-in Bluetooth adapter, so these ' +
            'options are ignored: ble_adapter, auto_clear_stale_bond, preemptive_adapter_reset, ' +
            'adapter_privacy.',
        );
      });

      it('applies the liveness timeout, with no note that it does nothing', () => {
        const r = generate({ options: { ...ESPHOME, proxy_liveness_timeout_min: 45 } });
        const config = expectLoads(r);
        expect(config.ble?.proxy_liveness_timeout_min).toBe(45);
        expect(r.stdout).not.toContain('proxy_liveness_timeout_min only affects');
      });

      it('stops without a host instead of falling back to the built-in adapter', () => {
        expectStopped(
          generate({ options: { ...ESPHOME, esphome_proxy_host: '  ' } }),
          'ble_transport is esphome-proxy, but esphome_proxy_host is empty.',
        );
      });

      it('stops on a key the ESPHome library would refuse, without logging it', () => {
        const bad = KEY.slice(0, -1);
        const r = generate({ options: { ...ESPHOME, esphome_proxy_encryption_key: bad } });
        expectStopped(r, 'esphome_proxy_encryption_key is not a valid ESPHome API key.');
        expect(r.stdout).not.toContain(bad);
      });
    });

    describe('ble_transport mqtt-proxy', () => {
      const SHARED = { ...DEFAULTS, ble_transport: 'mqtt-proxy' };
      const EMBEDDED = {
        ...SHARED,
        mqtt_proxy_broker: 'embedded',
        mqtt_proxy_username: 'esp32',
        mqtt_proxy_password: 'embedded-broker-secret',
      };
      const NO_BROKER: SupervisorReply = {
        code: '400',
        body: { result: 'error', message: 'Service not enabled' },
      };

      it('shared: the ESP32 uses the broker Mosquitto auto-detection found', () => {
        for (const mqtt_enabled of [true, false]) {
          const r = generate({
            options: { ...SHARED, mqtt_enabled },
            supervisorToken: 'supervisor-token-sentinel',
            supervisor: [MOSQUITTO_REPLY],
          });
          const config = expectLoads(r);
          expect(config.ble?.handler).toBe('mqtt-proxy');
          expect(config.ble?.mqtt_proxy).toMatchObject({
            broker_url: 'mqtt://core-mosquitto:1883',
            username: 'addons',
            password: MOSQUITTO_PASSWORD,
            device_id: 'esp32-ble-proxy',
            topic_prefix: 'ble-proxy',
          });
          expect(r.curlCalls).toBe(1);
          expect(r.stdout).not.toContain(MOSQUITTO_PASSWORD);
          expect(r.stdout).toContain(
            'Bluetooth transport: mqtt-proxy (shared broker, device esp32-ble-proxy)',
          );
          // The exporter only when MQTT export is on.
          expect(config.global_exporters ?? []).toHaveLength(mqtt_enabled ? 1 : 0);
        }
      });

      it('shared: a broker set by hand, when auto-detect is off', () => {
        const r = generate({
          options: {
            ...SHARED,
            mqtt_auto: false,
            mqtt_broker_url: 'mqtt://192.168.1.10:1883',
            mqtt_username: 'esp',
            mqtt_password: 'manual-secret',
          },
        });
        const config = expectLoads(r);
        expect(config.ble?.mqtt_proxy).toMatchObject({
          broker_url: 'mqtt://192.168.1.10:1883',
          username: 'esp',
          password: 'manual-secret',
        });
        expect(r.curlCalls).toBe(0);
        expect(r.stdout).not.toContain('manual-secret');
      });

      it('shared: stops when there is no broker, asking the Supervisor once', () => {
        const r = generate({
          options: SHARED,
          supervisorToken: 'supervisor-token-sentinel',
          supervisor: [NO_BROKER],
        });
        expectStopped(r, 'ble_transport is mqtt-proxy with mqtt_proxy_broker shared, but no');
        expect(r.curlCalls).toBe(1);
      });

      it('shared: asks a Supervisor that did not answer twice more, then stops', () => {
        const recovered = generate({
          options: SHARED,
          supervisorToken: 'supervisor-token-sentinel',
          supervisor: [{ code: '000' }, { code: '502' }, MOSQUITTO_REPLY],
        });
        expect(expectLoads(recovered).ble?.mqtt_proxy?.broker_url).toBe(
          'mqtt://core-mosquitto:1883',
        );
        expect(recovered.curlCalls).toBe(3);
        expect(recovered.stdout).toMatch(/trying again in 5s/);

        const gone = generate({
          options: SHARED,
          supervisorToken: 'supervisor-token-sentinel',
          supervisor: [{ code: '000' }],
        });
        expectStopped(gone, 'ble_transport is mqtt-proxy with mqtt_proxy_broker shared, but no');
        expect(gone.curlCalls).toBe(3);
      });

      it('asks only once for the MQTT exporter alone, as before', () => {
        const r = generate({
          options: DEFAULTS,
          supervisorToken: 'supervisor-token-sentinel',
          supervisor: [{ code: '000' }],
        });
        expect(r.status).toBe(0);
        expect(r.curlCalls).toBe(1);
      });

      it('embedded: the app runs its own broker with the login set here', () => {
        const r = generate({ options: { ...EMBEDDED, mqtt_proxy_embedded_broker_port: 1884 } });
        const config = expectLoads(r);
        expect(config.ble?.mqtt_proxy).toMatchObject({
          embedded_broker_port: 1884,
          username: 'esp32',
          password: 'embedded-broker-secret',
        });
        expect(config.ble?.mqtt_proxy?.broker_url ?? null).toBeNull();
        expect(r.stdout).not.toContain('embedded-broker-secret');
        expect(r.stdout).toContain('(embedded broker on port 1884, device esp32-ble-proxy)');
        expect(r.stdout).not.toContain('WARNING: mqtt_proxy_broker');
      });

      it('embedded: stops without a password', () => {
        expectStopped(
          generate({ options: { ...EMBEDDED, mqtt_proxy_password: '' } }),
          'mqtt_proxy_broker embedded listens on this host',
        );
      });

      it('embedded: warns that Mosquitto probably holds port 1883', () => {
        const r = generate({
          options: EMBEDDED,
          supervisorToken: 'supervisor-token-sentinel',
          supervisor: [MOSQUITTO_REPLY],
        });
        expectLoads(r);
        expect(r.stdout).toContain('WARNING: mqtt_proxy_broker embedded wants port 1883');
      });

      it('shared: names the embedded-only options it ignores', () => {
        const r = generate({
          options: {
            ...SHARED,
            mqtt_auto: false,
            mqtt_broker_url: 'mqtt://h:1883',
            mqtt_proxy_username: 'esp32',
            mqtt_proxy_password: 'unused-secret',
          },
        });
        expectLoads(r);
        expect(r.stdout).toContain(
          'only apply to mqtt_proxy_broker embedded, so they are ignored: mqtt_proxy_username, ' +
            'mqtt_proxy_password.',
        );
        expect(r.stdout).not.toContain('unused-secret');
      });
    });
  },
);

/**
 * yaml_escape on its own, under dash where installed: each value is written
 * the way run.sh writes it, then read back the way the app reads it (YAML,
 * then ${VAR} references).
 */
describe.skipIf(!SHELL)('run.sh yaml_escape', { timeout: 30_000 }, () => {
  // From a file, not `-c`: Windows command-line quoting mangles the
  // backslashes in the sed expression on the way to Git Bash.
  function roundTrip(value: string): unknown {
    const dir = mkdtempSync(join(tmpdir(), 'addon-yaml-escape-'));
    try {
      const file = join(dir, 'escape.sh');
      writeFileSync(
        file,
        `${block('yaml escape')}\nprintf '%s\\n' "v: \\"$(yaml_escape "$V")\\""\n`,
      );
      const res = spawnSync(SHELL!, [file.replace(/\\/g, '/')], {
        encoding: 'utf8',
        env: { ...process.env, V: value },
      });
      expect(res.stderr).toBe('');
      const doc = parse(res.stdout) as { v: string };
      return resolveEnvReferences(doc).v;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('gives back every value as entered, ${...} included', () => {
    for (const value of [
      'p${a}q',
      '$${b}',
      'a$b',
      'pa\\ss"wo\\nrd',
      '${',
      '}',
      '${}',
      'a${b${c}d',
      '$',
      '$$',
      'x$$${y}',
      '${x}${y}',
      '\\c-end',
      'cr\rlf',
    ]) {
      expect(roundTrip(value), JSON.stringify(value)).toBe(value);
    }
  });

  it('folds a newline to a space, also inside ${...}', () => {
    expect(roundTrip('a${b\nc}d')).toBe('a${b c}d');
    expect(roundTrip('two\nlines')).toBe('two lines');
  });
});

/**
 * The step of run.sh that turns the fresh config into /data/config.yaml, run
 * on its own with the paths in a temp directory and the container's umask.
 * Windows has no file modes to check.
 */
describe.skipIf(!SHELL || process.platform === 'win32')('run.sh config.yaml mode', () => {
  function mergeBlock(): string {
    const start = RUN_SH.indexOf('# ── Merge last_known_weight');
    const end = RUN_SH.indexOf('# ── Garmin token bootstrap');
    expect(start, 'merge block not found').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return RUN_SH.slice(start, end);
  }

  function run(fresh: string, existing?: { text: string; mode: number }) {
    const dir = mkdtempSync(join(tmpdir(), 'addon-mode-'));
    try {
      writeFileSync(join(dir, 'fresh.yaml'), fresh);
      if (existing) {
        writeFileSync(join(dir, 'config.yaml'), existing.text);
        chmodSync(join(dir, 'config.yaml'), existing.mode);
      }
      const script = [
        'set -e',
        'umask 022',
        `FRESH='${dir}/fresh.yaml'`,
        `CONFIG='${dir}/config.yaml'`,
        `ADDON_CONFIG='${resolve('ble-scale-sync-addon/addon-config.mjs')}'`,
        logFunction(),
        mergeBlock(),
      ].join('\n');
      const res = spawnSync(SHELL!, ['-c', script], { encoding: 'utf8' });
      expect(res.status, res.stdout + res.stderr).toBe(0);
      return {
        stdout: res.stdout,
        mode: statSync(join(dir, 'config.yaml')).mode & 0o777,
        text: readFileSync(join(dir, 'config.yaml'), 'utf8'),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const FRESH = 'version: 1\nusers:\n  - slug: a\n    last_known_weight: null\n';

  it('is 0600 from the first start, not only after the first weight', () => {
    expect(run(FRESH).mode).toBe(0o600);
  });

  it('is 0600 when the merge fails and the fresh file is copied instead', () => {
    const r = run('users: [unclosed\n');
    expect(r.stdout).toMatch(/merging last_known_weight failed/);
    expect(r.mode).toBe(0o600);
  });

  it('is 0600 after a merge into a file an older add-on left 0644', () => {
    const r = run(FRESH, {
      text: 'users:\n  - slug: a\n    last_known_weight: 70.5\n',
      mode: 0o644,
    });
    expect(r.text).toMatch(/last_known_weight: 70.5/);
    expect(r.mode).toBe(0o600);
  });

  it('comes from a chmod of that one file, not from a umask the app would inherit', () => {
    expect(mergeBlock()).toMatch(/^chmod 600 "\$CONFIG"$/m);
    expect(RUN_SH).not.toMatch(/^\s*umask\b/m);
  });
});

describe('add-on run.sh harness', () => {
  // A skip here would leave CI green without the harness ever running, after
  // nothing more than a change of runner image.
  it.runIf(Boolean(process.env.CI) && process.platform === 'linux')(
    'runs in CI on Linux: dash, jq writing LF, GNU date',
    () => {
      expect({ SHELL, JQ, JQ_CRLF, GNU_DATE }).toEqual({
        SHELL: 'dash',
        JQ: true,
        JQ_CRLF: false,
        GNU_DATE: true,
      });
    },
  );
});
