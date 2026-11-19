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
import { writeLastKnownWeight } from '../src/config/write.js';
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

/** The step that turns the fresh config into /data/config.yaml. */
function mergeBlock(): string {
  const start = RUN_SH.indexOf('# ── Merge last_known_weight');
  const end = RUN_SH.indexOf('# ── Garmin token bootstrap');
  expect(start, 'merge block not found').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RUN_SH.slice(start, end);
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
  /** Files to create (empty) in the add-on config folder of this run, by name. */
  certFiles?: string[];
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
    mkdirSync(`${dir}/config`);
    for (const name of c.certFiles ?? []) writeFileSync(`${dir}/config/${name}`, '');

    const script = [
      'set -e',
      `OPTIONS='${dir}/options.json'`,
      `FRESH='${dir}/fresh.yaml'`,
      `CERT_DIR='${dir}/config'`,
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
          no_reading_rescan_delay: 0
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
          no_reading_rescan_delay: 0
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
          no_reading_rescan_delay: 0
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
            qn_user_key: ' 01000 ',
            qn_user_slot: ' 02 ',
            qn_algorithm: '7',
            qn_a4_prelude: 'true',
            qn_time_sync_long: 'off',
            qn_config_long: '1',
            qn_result_ack: 'on',
            rmsc04_profile_byte: ' 0x9E ',
            auto_clear_stale_bond: true,
            preemptive_adapter_reset: false,
            adapter_privacy: true,
            pairing_retry_max_min: 15,
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
          qn_user_key: 1000
          qn_user_slot: 2
          qn_algorithm: 7
          qn_a4_prelude: true
          qn_time_sync_long: false
          qn_config_long: true
          qn_result_ack: true
          rmsc04_profile_byte: "9e"
          auto_clear_stale_bond: true
          preemptive_adapter_reset: false
          adapter_privacy: true
          pairing_retry_max_min: 15

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
            skip_metabolic_age: false
            upload_timeout_sec: 180

        runtime:
          continuous_mode: true
          scan_cooldown: 30
          idle_rescan_delay: 5
          no_reading_rescan_delay: 0
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

      // #497: written on the user only when off, so the default config above
      // stays byte for byte what it was.
      it('user_estimate_body_composition off, on the user', () => {
        const r = generate({ options: { ...DEFAULTS, user_estimate_body_composition: false } });
        const config = expectLoads(r);
        expect(config.users[0].estimate_body_composition).toBe(false);
        expect(r.text).toContain(
          '    last_known_weight: null\n    estimate_body_composition: false\n\n',
        );
      });

      it('user_estimate_body_composition on or missing writes nothing', () => {
        const { user_estimate_body_composition: _on, ...missing } = DEFAULTS;
        for (const options of [DEFAULTS, missing]) {
          const r = generate({ options });
          const config = expectLoads(r);
          expect(config.users[0]).not.toHaveProperty('estimate_body_composition');
          expect(r.text).not.toContain('estimate_body_composition');
        }
      });

      it('no_reading_rescan_delay as entered (#475)', () => {
        const r = generate({ options: { ...DEFAULTS, no_reading_rescan_delay: 900 } });
        const config = expectLoads(r);
        expect(config.runtime?.no_reading_rescan_delay).toBe(900);
      });
    });

    // A text option like the QN bytes, so that unset stays unset (#463). Only a
    // plain 1 to 9999 integer reaches config.yaml, as a decimal; anything else
    // is dropped with a warning rather than failing the schema at startup.
    describe('qn_user_key', () => {
      it.each([
        ['1000', 1000],
        ['01000', 1000],
        [' 42 ', 42],
        ['9999', 9999],
      ])('writes %j as %d, and opens the ble block on its own', (value, written) => {
        const r = generate({ options: { ...DEFAULTS, qn_user_key: value } });
        const config = expectLoads(r);
        expect(config.ble?.qn_user_key).toBe(written);
        expect(r.text).toContain(`ble:
  qn_user_key: ${written}
`);
        expect(r.stdout).not.toContain('qn_user_key');
      });

      it.each(['0', '0000', '10000', '99999999999', 'abc', '-5', '1.5'])(
        'drops %j with a warning',
        (value) => {
          const r = generate({ options: { ...DEFAULTS, qn_user_key: value } });
          const config = expectLoads(r);
          expect(config.ble?.qn_user_key).toBeUndefined();
          expect(r.text).not.toContain('qn_user_key');
          expect(r.stdout).toContain(
            `WARNING: Invalid qn_user_key '${value}' (expected 1 to 9999). Ignoring.`,
          );
        },
      );

      it('writes nothing when it is empty', () => {
        const r = generate({ options: { ...DEFAULTS, qn_user_key: '' } });
        expectLoads(r);
        expect(r.text).not.toContain('qn_user_key');
        expect(r.stdout).not.toContain('qn_user_key');
      });
    });

    // Like qn_user_key, for 1 to 8 (#501).
    describe('qn_user_slot', () => {
      it.each([
        ['2', 2],
        ['02', 2],
        [' 8 ', 8],
        ['1', 1],
      ])('writes %j as %d, and opens the ble block on its own', (value, written) => {
        const r = generate({ options: { ...DEFAULTS, qn_user_slot: value } });
        const config = expectLoads(r);
        expect(config.ble?.qn_user_slot).toBe(written);
        expect(r.text).toContain(`ble:
  qn_user_slot: ${written}
`);
        expect(r.stdout).not.toContain('qn_user_slot');
      });

      it.each(['0', '00', '9', '10', '99999999999', 'abc', '-1', '1.5'])(
        'drops %j with a warning',
        (value) => {
          const r = generate({ options: { ...DEFAULTS, qn_user_slot: value } });
          const config = expectLoads(r);
          expect(config.ble?.qn_user_slot).toBeUndefined();
          expect(r.text).not.toContain('qn_user_slot');
          expect(r.stdout).toContain(
            `WARNING: Invalid qn_user_slot '${value}' (expected 1 to 8). Ignoring.`,
          );
        },
      );

      it('writes nothing when it is empty', () => {
        const r = generate({ options: { ...DEFAULTS, qn_user_slot: '' } });
        expectLoads(r);
        expect(r.text).not.toContain('qn_user_slot');
        expect(r.stdout).not.toContain('qn_user_slot');
      });
    });

    // One byte, normalised like qn_protocol_byte (#331).
    describe('qn_algorithm', () => {
      it('writes it in decimal on its own, opening the ble block', () => {
        const r = generate({ options: { ...DEFAULTS, qn_algorithm: ' 007 ' } });
        const config = expectLoads(r);
        expect(config.ble?.qn_algorithm).toBe(7);
        expect(r.text).toContain(`ble:
  qn_algorithm: 7
`);
      });

      it.each(['256', '-1', '7a', '0x07', '1000'])('drops %s with a warning', (value) => {
        const r = generate({ options: { ...DEFAULTS, qn_algorithm: value } });
        const config = expectLoads(r);
        expect(config.ble?.qn_algorithm).toBeUndefined();
        expect(r.text).not.toContain('qn_algorithm');
        expect(r.stdout).toContain(
          `WARNING: Invalid qn_algorithm '${value}' (expected 0 to 255). Ignoring.`,
        );
      });

      it('writes 0, which is a value', () => {
        const r = generate({ options: { ...DEFAULTS, qn_algorithm: '0' } });
        expect(expectLoads(r).ble?.qn_algorithm).toBe(0);
      });
    });

    // Normalised like the other QN switches (#331).
    describe('qn_result_ack', () => {
      it('writes true on its own, opening the ble block', () => {
        const r = generate({ options: { ...DEFAULTS, qn_result_ack: 'true' } });
        const config = expectLoads(r);
        expect(config.ble?.qn_result_ack).toBe(true);
        expect(r.text).toContain(`ble:
  qn_result_ack: true
`);
      });

      it('drops a value that is not true or false with a warning', () => {
        const r = generate({ options: { ...DEFAULTS, qn_result_ack: 'maybe' } });
        const config = expectLoads(r);
        expect(config.ble?.qn_result_ack).toBeUndefined();
        expect(r.text).not.toContain('qn_result_ack');
        expect(r.stdout).toContain(
          "WARNING: ignoring qn_result_ack='maybe' (expected true or false).",
        );
      });
    });

    // One byte of the user's own Renpho app profile (#434, D079), written quoted
    // so that 99 stays a string. A bad value is dropped with a warning that
    // does not repeat it: the byte is personal.
    describe('rmsc04_profile_byte', () => {
      const WARNING =
        'WARNING: Invalid rmsc04_profile_byte (expected one byte as two hex digits, 0-9 ' +
        'and a-f; in the YAML editor put it in quotes). Ignoring.';

      it.each([
        ['99', '99'],
        [' 0x9E ', '9e'],
        ['A9', 'a9'],
        ['00', '00'],
      ])('writes %j as the string %j, and opens the ble block on its own', (value, written) => {
        const r = generate({ options: { ...DEFAULTS, rmsc04_profile_byte: value } });
        const config = expectLoads(r);
        expect(config.ble?.rmsc04_profile_byte).toBe(written);
        expect(r.text).toContain(`ble:
  rmsc04_profile_byte: "${written}"
`);
        expect(r.stdout).not.toContain('rmsc04_profile_byte');
      });

      it.each(['q7', '9', '0x9e1', '9e 5'])('drops %j with a warning that omits it', (value) => {
        const r = generate({ options: { ...DEFAULTS, rmsc04_profile_byte: value } });
        const config = expectLoads(r);
        expect(config.ble?.rmsc04_profile_byte).toBeUndefined();
        expect(r.text).not.toContain('rmsc04_profile_byte');
        // The one line about the option is the fixed warning, nothing more.
        const lines = r.stdout.split('\n').filter((l) => l.includes('rmsc04_profile_byte'));
        expect(lines).toEqual([`[ble-scale-sync] ${WARNING}`]);
        if (value.length > 1) expect(r.stdout).not.toContain(value);
      });

      it('writes nothing and warns about nothing when it is empty', () => {
        const r = generate({ options: { ...DEFAULTS, rmsc04_profile_byte: '' } });
        expectLoads(r);
        expect(r.text).not.toContain('rmsc04_profile_byte');
        expect(r.stdout).not.toContain('rmsc04_profile_byte');
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
            pairing_retry_max_min: 15,
          },
        });
        const config = expectLoads(r);
        expect(config.ble?.scale_mac).toBe('F8:83:06:4E:B6:7E');
        expect(r.text).not.toMatch(
          /adapter:|adapter_privacy|auto_clear_stale_bond|preemptive|pairing_retry/,
        );
        expect(r.stdout).toContain(
          'NOTE: ble_transport esphome-proxy does not use the built-in Bluetooth adapter, so these ' +
            'options are ignored: ble_adapter, auto_clear_stale_bond, preemptive_adapter_reset, ' +
            'adapter_privacy, pairing_retry_max_min.',
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

      it('shared: stops on a broker URL the exporter takes and the proxy does not', () => {
        // The app refused such a config on every start of the restart loop, and
        // named ble.mqtt_proxy.broker_url, a key nobody set in the form.
        const r = generate({
          options: {
            ...SHARED,
            mqtt_auto: false,
            mqtt_broker_url: 'ws://esp:ws-url-secret@192.168.1.10:9001',
          },
        });
        expectStopped(r, 'mqtt_proxy_broker shared needs an mqtt_broker_url that starts with');
        expect(r.stdout).not.toContain('ws-url-secret');
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

      it('embedded: warns about every port the Mosquitto add-on maps, and only those', () => {
        for (const port of [1883, 1884, 8883, 8884]) {
          const r = generate({
            options: { ...EMBEDDED, mqtt_proxy_embedded_broker_port: port },
            supervisorToken: 'supervisor-token-sentinel',
            supervisor: [MOSQUITTO_REPLY],
          });
          expectLoads(r);
          expect(r.stdout, String(port)).toContain(
            `WARNING: mqtt_proxy_broker embedded wants port ${port}, which the Mosquitto broker add-on`,
          );
        }
        const free = generate({
          options: { ...EMBEDDED, mqtt_proxy_embedded_broker_port: 18883 },
          supervisorToken: 'supervisor-token-sentinel',
          supervisor: [MOSQUITTO_REPLY],
        });
        expectLoads(free);
        expect(free.stdout).not.toContain('WARNING: mqtt_proxy_broker');
      });

      describe('embedded broker TLS', () => {
        const TLS = {
          ...EMBEDDED,
          mqtt_proxy_embedded_broker_port: 18883,
          mqtt_proxy_embedded_tls: true,
        };

        it('writes the certificate and key from the config folder, and the app loads them', () => {
          const r = generate({ options: TLS, certFiles: ['broker.pem', 'broker.key'] });
          const config = expectLoads(r);
          expect(config.ble?.mqtt_proxy).toMatchObject({
            embedded_broker_port: 18883,
            embedded_broker_tls_cert: expect.stringMatching(/\/config\/broker\.pem$/),
            embedded_broker_tls_key: expect.stringMatching(/\/config\/broker\.key$/),
          });
          expect(r.text).toContain('embedded_broker_tls_cert: "<tmp>/config/broker.pem"');
          expect(r.stdout).toContain(
            '(embedded broker on port 18883, TLS, device esp32-ble-proxy)',
          );
          expect(r.stdout).not.toContain('embedded-broker-secret');
        });

        it('uses the file names of the options, and the defaults for an emptied one', () => {
          const named = generate({
            options: {
              ...TLS,
              mqtt_proxy_embedded_tls_certfile: ' my.pem ',
              mqtt_proxy_embedded_tls_keyfile: 'my.key',
            },
            certFiles: ['my.pem', 'my.key'],
          });
          expectLoads(named);
          expect(named.text).toContain('embedded_broker_tls_cert: "<tmp>/config/my.pem"');
          expect(named.text).toContain('embedded_broker_tls_key: "<tmp>/config/my.key"');

          const emptied = generate({
            options: {
              ...TLS,
              mqtt_proxy_embedded_tls_certfile: '',
              mqtt_proxy_embedded_tls_keyfile: '',
            },
            certFiles: ['broker.pem', 'broker.key'],
          });
          expectLoads(emptied);
          expect(emptied.text).toContain('<tmp>/config/broker.pem');
          expect(emptied.text).toContain('<tmp>/config/broker.key');
        });

        it('stops when a file is not in the config folder, naming the option only', () => {
          expectStopped(
            generate({ options: TLS, certFiles: ['broker.key'] }),
            'mqtt_proxy_embedded_tls is on, but mqtt_proxy_embedded_tls_certfile does not name a ' +
              'readable file in the add-on config folder.',
          );
          expectStopped(
            generate({ options: TLS, certFiles: ['broker.pem'] }),
            'mqtt_proxy_embedded_tls is on, but mqtt_proxy_embedded_tls_keyfile does not name a ' +
              'readable file in the add-on config folder.',
          );
        });

        it('stops on a path or a name that climbs out of the config folder', () => {
          for (const name of ['/etc/passwd', '../data/options.json', 'sub/broker.key', '.hidden']) {
            expectStopped(
              generate({
                options: { ...TLS, mqtt_proxy_embedded_tls_keyfile: name },
                certFiles: ['broker.pem'],
              }),
              'mqtt_proxy_embedded_tls_keyfile takes a file name in the add-on config folder, not a path.',
            );
          }
        });

        it('reads a switch set to false, or a missing one, as off', () => {
          // opt() reads false as unset: the switch needs opt_bool, or "false"
          // would be reported as set but ignored (or worse, turn TLS on).
          const missing: Record<string, unknown> = { ...EMBEDDED };
          delete missing.mqtt_proxy_embedded_tls;
          for (const options of [{ ...EMBEDDED, mqtt_proxy_embedded_tls: false }, missing]) {
            const r = generate({ options });
            expectLoads(r);
            expect(r.text).not.toContain('embedded_broker_tls');
            expect(r.stdout).toContain('(embedded broker on port 1883, device');
            expect(r.stdout).not.toContain('mqtt_proxy_embedded_tls');
          }
        });

        it('shared: names the TLS options it ignores', () => {
          const r = generate({
            options: {
              ...SHARED,
              mqtt_auto: false,
              mqtt_broker_url: 'mqtt://h:1883',
              mqtt_proxy_embedded_tls: true,
              mqtt_proxy_embedded_tls_certfile: 'my.pem',
            },
          });
          expectLoads(r);
          expect(r.text).not.toContain('embedded_broker_tls');
          expect(r.stdout).toContain(
            'only apply to mqtt_proxy_broker embedded, so they are ignored: ' +
              'mqtt_proxy_embedded_tls, mqtt_proxy_embedded_tls_certfile.',
          );
        });

        it('a certificate or key set but TLS off writes neither key', () => {
          const r = generate({
            options: { ...EMBEDDED, mqtt_proxy_embedded_tls_certfile: 'my.pem' },
          });
          expectLoads(r);
          expect(r.text).not.toContain('embedded_broker_tls');
        });
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

    describe('ble_transport ha-bluetooth', () => {
      /** Looks like a Supervisor token (112 hex characters), invented. */
      const TOKEN = 'ab'.repeat(56);
      const HA = { ...DEFAULTS, ble_transport: 'ha-bluetooth', scale_mac: 'A0:85:61:91:E9:4F' };

      it('reads Home Assistant through the Supervisor and writes no token at all', () => {
        const r = generate({ options: HA, supervisorToken: TOKEN });
        expect(r.text).toContain('    url: "ws://supervisor/core/websocket"\n');
        expect(r.text).not.toContain('SUPERVISOR_TOKEN');
        expect(r.text).not.toContain(TOKEN);
        expect(r.stdout).not.toContain(TOKEN);
        expect(r.stdout).toContain('Bluetooth transport: ha-bluetooth');

        // The app reads SUPERVISOR_TOKEN itself for this URL, so the file loads
        // without it in the environment and carries no token.
        const config = expectLoads(r);
        expect(config.ble?.handler).toBe('ha-bluetooth');
        expect(config.ble?.ha_bluetooth).toMatchObject({ url: 'ws://supervisor/core/websocket' });
        expect(config.ble?.ha_bluetooth?.token).toBeUndefined();
        expect(config.ble?.scale_mac).toBe('A0:85:61:91:E9:4F');
      });

      it('stops when the Supervisor gave the add-on no token', () => {
        expectStopped(
          generate({ options: HA }),
          'ble_transport is ha-bluetooth, but the Supervisor gave this add-on no SUPERVISOR_TOKEN.',
        );
      });

      it('keeps the token out of /data, also after the app saves a weight', () => {
        const r = generate({ options: HA, supervisorToken: TOKEN });
        const dir = mkdtempSync(join(tmpdir(), 'addon-ha-token-'));
        try {
          const fresh = join(dir, 'fresh.yaml');
          const config = join(dir, 'config.yaml');
          writeFileSync(fresh, r.text!.replaceAll('<tmp>', dir.replace(/\\/g, '/')));
          const script = [
            'set -e',
            `FRESH='${fresh.replace(/\\/g, '/')}'`,
            `CONFIG='${config.replace(/\\/g, '/')}'`,
            `ADDON_CONFIG='${resolve('ble-scale-sync-addon/addon-config.mjs').replace(/\\/g, '/')}'`,
            logFunction(),
            mergeBlock(),
          ].join('\n');
          const res = spawnSync(SHELL!, ['-c', script], { encoding: 'utf8' });
          expect(res.status, res.stdout + res.stderr).toBe(0);
          writeLastKnownWeight(config, 'default', 72.5);
          const saved = readFileSync(config, 'utf8');
          expect(saved).toContain('url: "ws://supervisor/core/websocket"');
          expect(saved).not.toContain('SUPERVISOR_TOKEN');
          expect(saved).toMatch(/last_known_weight: 72.5/);
          expect(saved).not.toContain(TOKEN);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  },
);

/**
 * The custom_config branch of run.sh, with the file in /share replaced by one
 * in a temp directory. Linux only, like the harness: the transport options
 * are compared with their defaults, and jq's CRLF would make every one differ.
 */
describe.skipIf(!HARNESS)('run.sh custom_config and the transport options', () => {
  function customBranch(): string {
    const start = RUN_SH.indexOf('if [ "$CUSTOM_CONFIG" = "true" ]; then');
    const end = RUN_SH.indexOf('\nelse\n', start);
    expect(start, 'custom_config branch not found').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return `${RUN_SH.slice(start, end)}\nfi\n`;
  }

  function run(
    options: Record<string, unknown>,
    file = 'version: 1\n',
  ): { status: number | null; stdout: string; freshLeft: boolean; fresh: string } {
    const raw = mkdtempSync(join(tmpdir(), 'addon-custom-'));
    const dir = raw.replace(/\\/g, '/');
    try {
      writeFileSync(`${dir}/options.json`, JSON.stringify(options));
      writeFileSync(`${dir}/custom.yaml`, file);
      const script = [
        'set -e',
        `OPTIONS='${dir}/options.json'`,
        `FRESH='${dir}/fresh.yaml'`,
        `ADDON_CONFIG='${resolve('ble-scale-sync-addon/addon-config.mjs').replace(/\\/g, '/')}'`,
        logFunction(),
        ...['option readers', 'yaml escape', 'option checks', 'ble transport', 'mode'].map(block),
        customBranch().replaceAll('/share/ble-scale-sync/config.yaml', `${dir}/custom.yaml`),
      ].join('\n');
      const res = spawnSync(SHELL!, ['-c', script], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      });
      expect(res.stderr).toBe('');
      return {
        status: res.status,
        stdout: res.stdout.replaceAll(dir, '<tmp>'),
        freshLeft: existsSync(`${dir}/fresh.yaml`),
        fresh: existsSync(`${dir}/fresh.yaml`) ? readFileSync(`${dir}/fresh.yaml`, 'utf8') : '',
      };
    } finally {
      rmSync(raw, { recursive: true, force: true });
    }
  }

  const CUSTOM = { ...DEFAULTS, custom_config: true };

  describe('Supervisor token references in the file', () => {
    // Not the Supervisor URL, so these stay refusals whatever else is done to
    // the documented ha-bluetooth snippet.
    const OTHER_HA = 'ws://ha.example:8123/api/websocket';
    const REFUSED: [string, string][] = [
      [
        'a plain reference',
        `ble:\n  handler: ha-bluetooth\n  ha_bluetooth:\n    url: ${OTHER_HA}\n    token: '\${SUPERVISOR_TOKEN}'\n`,
      ],
      [
        'a HASSIO_TOKEN reference in an exporter header',
        'global_exporters:\n  - type: webhook\n    url: http://example.test/hook\n    headers:\n      X-Api-Key: "k-${hassio_token}"\n',
      ],
      [
        'a double-quoted escape of the dollar sign',
        'global_exporters:\n  - type: webhook\n    url: "\\x24{SUPERVISOR_TOKEN}"\n',
      ],
      [
        'an alias of a reference',
        "x-ref: &t '${SUPERVISOR_TOKEN}'\nglobal_exporters:\n  - type: webhook\n    url: http://example.test/hook\n    headers:\n      X-Api-Key: *t\n",
      ],
    ];

    it.each(REFUSED)('stops the add-on on %s', (_name, file) => {
      const r = run(CUSTOM, file);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(
        'ERROR: <tmp>/custom.yaml reads the Supervisor token through a ${...} reference, at: ',
      );
      expect(r.freshLeft).toBe(false);
    });

    it('names the config path of the reference', () => {
      const r = run(CUSTOM, REFUSED[1][1]);
      expect(r.stdout).toContain('at: global_exporters[0].headers.X-Api-Key');
    });

    it('goes on with a clean file, a literal $${...} and another variable', () => {
      for (const file of [
        'version: 1\n',
        "global_exporters:\n  - type: webhook\n    url: http://example.test/hook\n    headers:\n      X-Api-Key: '$${SUPERVISOR_TOKEN}'\n",
        "ble:\n  handler: ha-bluetooth\n  ha_bluetooth:\n    url: ws://ha.example:8123/api/websocket\n    token: '${HA_TOKEN}'\n",
      ]) {
        const r = run(CUSTOM, file);
        expect(r.status, file).toBe(0);
        expect(r.stdout, file).not.toContain('Supervisor token');
        // A wrong ADDON_CONFIG path would switch the check off without a failure.
        expect(r.stdout, file).not.toContain('could not check');
      }
    });

    it('leaves a file that is not YAML to the app', () => {
      const r = run(CUSTOM, 'users: [unclosed\n');
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('could not check');
    });
  });

  describe('the old ha-bluetooth snippet of the add-on guide', () => {
    const LEGACY = [
      'ble:',
      '  handler: ha-bluetooth',
      '  ha_bluetooth:',
      '    url: ws://supervisor/core/websocket',
      "    token: '${SUPERVISOR_TOKEN}'",
      '    source: AA:BB:CC:DD:EE:FF',
      '',
    ].join('\n');

    it('starts, says the line is ignored and leaves it out of the working copy', () => {
      const r = run(CUSTOM, LEGACY);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(
        'NOTE: ble.ha_bluetooth.token in <tmp>/custom.yaml is the Supervisor token reference.',
      );
      expect(r.stdout).not.toContain('could not check');
      expect(r.fresh).not.toContain('SUPERVISOR_TOKEN');
      expect(parse(r.fresh)).toEqual({
        ble: {
          handler: 'ha-bluetooth',
          ha_bluetooth: { url: 'ws://supervisor/core/websocket', source: 'AA:BB:CC:DD:EE:FF' },
        },
      });
    });

    it('is refused when the URL is not the Supervisor one', () => {
      const r = run(CUSTOM, LEGACY.replace('ws://supervisor/core/websocket', 'ws://ha.example/ws'));
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('at: ble.ha_bluetooth.token');
      expect(r.stdout).not.toContain('NOTE: ble.ha_bluetooth.token');
    });

    it('says nothing for a file without the line', () => {
      const r = run(CUSTOM, 'version: 1\n');
      expect(r.stdout).not.toContain('NOTE: ble.ha_bluetooth.token');
    });
  });

  it('names the transport options it ignores, never their values', () => {
    const r = run({
      ...CUSTOM,
      ble_transport: 'esphome-proxy',
      esphome_proxy_host: '192.168.1.50',
      esphome_proxy_encryption_key: 'custom-secret-key',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'WARNING: custom_config is enabled, so the transport options (ble_transport, ' +
        'esphome_proxy_host, esphome_proxy_encryption_key) are ignored.',
    );
    expect(r.stdout).toContain("Set 'ble.handler' and its section");
    expect(r.stdout).not.toContain('custom-secret-key');
    expect(r.stdout).not.toContain('192.168.1.50');
  });

  it('names qn_user_key as ignored when it is set', () => {
    const r = run({ ...CUSTOM, qn_user_key: '1000' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "WARNING: custom_config is enabled, so the 'qn_user_key' option is ignored.",
    );
    expect(r.stdout).toContain("Set 'ble.qn_user_key' in");
  });

  it('names qn_user_slot as ignored when it is set', () => {
    const r = run({ ...CUSTOM, qn_user_slot: '2' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "WARNING: custom_config is enabled, so the 'qn_user_slot' option is ignored.",
    );
    expect(r.stdout).toContain("Set 'ble.qn_user_slot' in");
  });

  it('names qn_algorithm as ignored when it is set', () => {
    const r = run({ ...CUSTOM, qn_algorithm: '7' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "WARNING: custom_config is enabled, so the 'qn_algorithm' option is ignored.",
    );
    expect(r.stdout).toContain("Set 'ble.qn_algorithm' in");
  });

  it('names qn_result_ack as ignored when it is set', () => {
    const r = run({ ...CUSTOM, qn_result_ack: 'true' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "WARNING: custom_config is enabled, so the 'qn_result_ack' option is ignored.",
    );
    expect(r.stdout).toContain("Set 'ble.qn_result_ack' in");
  });

  it('names rmsc04_profile_byte as ignored when it is set', () => {
    const r = run({ ...CUSTOM, rmsc04_profile_byte: '9e' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "WARNING: custom_config is enabled, so the 'rmsc04_profile_byte' option is ignored.",
    );
    expect(r.stdout).toContain("Set 'ble.rmsc04_profile_byte' in");
  });

  it('says nothing while every transport option has its default', () => {
    const r = run(CUSTOM);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('transport options');
  });

  // #497: on by default, so only an explicit false is worth a word.
  it('names user_estimate_body_composition as ignored only when it is off', () => {
    const quiet = run(CUSTOM);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).not.toContain('user_estimate_body_composition');
    const r = run({ ...CUSTOM, user_estimate_body_composition: false });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "WARNING: custom_config is enabled, so the 'user_estimate_body_composition' option is ignored.",
    );
    expect(r.stdout).toContain("Set 'estimate_body_composition: false' on the user in");
  });

  // #471: the option has a default, so only a changed value is worth a word.
  it('names pairing_retry_max_min as ignored only when it is not 60', () => {
    const quiet = run(CUSTOM);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).not.toContain('pairing_retry_max_min');
    const r = run({ ...CUSTOM, pairing_retry_max_min: 15 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "WARNING: custom_config is enabled, so the 'pairing_retry_max_min' option is ignored.",
    );
    expect(r.stdout).toContain("Set 'ble.pairing_retry_max_min' in");
  });
});

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
