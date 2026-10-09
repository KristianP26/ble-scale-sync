import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadYamlConfig } from '../src/config/yaml-load.js';
import { collectUnknownKeys } from '../src/config/unknown-keys.js';
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
  },
);

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
