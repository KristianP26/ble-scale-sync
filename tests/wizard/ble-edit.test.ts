import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  bleStep,
  promptMqttProxy,
  promptEsphomeProxy,
  promptHaBluetooth,
} from '../../src/wizard/steps/ble.js';
import type { WizardContext } from '../../src/wizard/types.js';
import type { AppConfig } from '../../src/config/schema.js';
import { scriptedPrompts, type ScriptedAnswer } from '../helpers/scripted-prompts.js';
import { snapshotEnv } from '../helpers/env-snapshot.js';

function ctxWith(
  config: Partial<AppConfig>,
  answers: Array<[RegExp, ScriptedAnswer]>,
  inContainer = false,
) {
  const scripted = scriptedPrompts(answers);
  const ctx: WizardContext = {
    config,
    configPath: '/tmp/config.yaml',
    isEditMode: true,
    nonInteractive: false,
    platform: {
      os: 'win32',
      arch: 'x64',
      hasDocker: false,
      hasPython: false,
      pythonCommand: null,
      inContainer,
    },
    prompts: scripted.prompts,
  };
  return { ctx, ...scripted };
}

// Every BLE prompt used to start from nothing, so changing one value meant
// retyping the proxy settings and their secrets.
describe('BLE section starts from the current config', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = snapshotEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    restoreEnv();
  });

  it('keeps an external MQTT proxy, its ${VAR} password and unasked keys on Enter', async () => {
    const current = {
      broker_url: 'mqtts://broker.lan:8883',
      device_id: 'esp-1',
      topic_prefix: 'bp',
      username: 'u',
      password: '${MQTT_PW}',
      future_key: 7,
    };
    const { ctx, asked } = ctxWith({}, []);

    const result = await promptMqttProxy(ctx, structuredClone(current) as never);

    expect(result).toEqual(current);
    expect(asked.some((m) => /Store it in \.env/.test(m))).toBe(false);
  });

  it('keeps an open loopback embedded broker open on Enter', async () => {
    const current = {
      device_id: 'esp-1',
      topic_prefix: 'bp',
      embedded_broker_port: 1884,
      embedded_broker_bind: '127.0.0.1',
    };
    const { ctx } = ctxWith({}, []);

    expect(await promptMqttProxy(ctx, structuredClone(current) as never)).toEqual(current);
  });

  // The bind is not asked and was always rebuilt as 0.0.0.0, so re-running
  // the section put a broker bound to one address on every interface.
  it.each(['192.168.1.10', '127.0.0.1'])(
    'keeps an embedded broker with auth bound to %s on Enter',
    async (bind) => {
      const current = {
        device_id: 'esp-1',
        topic_prefix: 'bp',
        username: 'u',
        password: '${MQTT_PW}',
        embedded_broker_port: 1883,
        embedded_broker_bind: bind,
      };
      const { ctx } = ctxWith({}, []);

      expect(await promptMqttProxy(ctx, structuredClone(current) as never)).toEqual(current);
    },
  );

  it('switches a LAN bind to 127.0.0.1 when auth is declined, keeps a loopback one', async () => {
    const lan = { device_id: 'e', topic_prefix: 'bp', embedded_broker_bind: '192.168.1.10' };
    const { ctx } = ctxWith({}, [[/Require username\/password/, false]]);
    expect((await promptMqttProxy(ctx, lan as never)).embedded_broker_bind).toBe('127.0.0.1');

    const v6 = { device_id: 'e', topic_prefix: 'bp', embedded_broker_bind: '::1' };
    const second = ctxWith({}, [[/Require username\/password/, false]]);
    expect((await promptMqttProxy(second.ctx, v6 as never)).embedded_broker_bind).toBe('::1');
  });

  it('binds a new embedded broker to 0.0.0.0, or 127.0.0.1 without auth', async () => {
    const withAuth = ctxWith({}, [
      [/MQTT username/, 'u'],
      [/MQTT password/, 'pw'],
      [/Store it in \.env/, false],
    ]);
    expect((await promptMqttProxy(withAuth.ctx)).embedded_broker_bind).toBe('0.0.0.0');

    const open = ctxWith({}, [[/Require username\/password/, false]]);
    expect((await promptMqttProxy(open.ctx)).embedded_broker_bind).toBe('127.0.0.1');
  });

  describe('embedded broker TLS keys', () => {
    const tls = {
      device_id: 'esp-1',
      topic_prefix: 'bp',
      username: 'u',
      password: '${MQTT_PW}',
      embedded_broker_port: 8883,
      embedded_broker_bind: '0.0.0.0',
      embedded_broker_tls_cert: '/certs/broker.pem',
      embedded_broker_tls_key: '/certs/broker.key',
    };

    it('keeps the certificate and key on Enter, since the confirm defaults to yes', async () => {
      const { ctx } = ctxWith({}, []);

      expect(await promptMqttProxy(ctx, structuredClone(tls) as never)).toEqual(tls);
    });

    it('drops them when TLS is declined', async () => {
      const { ctx } = ctxWith({}, [[/^Encrypt the ESP32 connection with TLS/, false]]);

      const result = await promptMqttProxy(ctx, structuredClone(tls) as never);

      expect(result).not.toHaveProperty('embedded_broker_tls_cert');
      expect(result).not.toHaveProperty('embedded_broker_tls_key');
    });

    it('drops them when the broker becomes an external one', async () => {
      const { ctx } = ctxWith({}, [
        [/^MQTT broker:/, 'external'],
        [/^MQTT broker URL:/, 'mqtts://broker.lan:8883'],
      ]);

      const result = await promptMqttProxy(ctx, structuredClone(tls) as never);

      expect(result.broker_url).toBe('mqtts://broker.lan:8883');
      expect(result).not.toHaveProperty('embedded_broker_tls_cert');
      expect(result).not.toHaveProperty('embedded_broker_tls_key');
    });

    it('drops them when auth is declined and the bind falls back to loopback', async () => {
      const { ctx } = ctxWith({}, [[/^Require username\/password/, false]]);

      const result = await promptMqttProxy(ctx, structuredClone(tls) as never);

      expect(result.embedded_broker_bind).toBe('127.0.0.1');
      expect(result).not.toHaveProperty('embedded_broker_tls_cert');
    });

    it('refuses a relative path', async () => {
      const { ctx, rejected } = ctxWith({}, [
        [/^TLS certificate file/, 'certs/broker.pem'],
        [/^TLS private key file/, '~/broker.key'],
      ]);

      await promptMqttProxy(ctx, structuredClone(tls) as never);

      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toContain('certs/broker.pem');
      expect(rejected[0]).toContain('Must be an absolute path or start with ~/');
    });
  });

  it('keeps an ESPHome proxy with its key, additional proxies and advertisement_timeout', async () => {
    const current = {
      host: 'p1.local',
      port: 6054,
      client_info: 'ble-scale-sync',
      encryption_key: '${ESPHOME_KEY}',
      advertisement_timeout: 300,
      additional_proxies: [
        { host: 'p2.local', port: 6053, client_info: 'ble-scale-sync', password: 'pw2' },
      ],
    };
    const { ctx } = ctxWith({}, []);

    expect(await promptEsphomeProxy(ctx, structuredClone(current) as never)).toEqual(current);
  });

  it('removes an additional ESPHome proxy when asked', async () => {
    const current = {
      host: 'p1.local',
      port: 6053,
      client_info: 'ble-scale-sync',
      additional_proxies: [{ host: 'p2.local', port: 6053, client_info: 'ble-scale-sync' }],
    };
    const { ctx } = ctxWith({}, [[/p2\.local/, 'remove']]);

    const result = await promptEsphomeProxy(ctx, current as never);

    expect(result.additional_proxies).toBeUndefined();
  });

  it('keeps the Home Assistant token on Enter', async () => {
    const current = { url: 'http://ha.local:8123', token: '${HA_TOKEN}', source: 'aa:bb' };
    const { ctx } = ctxWith({}, []);

    expect(await promptHaBluetooth(ctx, { ...current })).toEqual(current);
  });

  it('keeps the transport and the scale on Enter, without a scan', async () => {
    const ble = {
      handler: 'esphome-proxy' as const,
      scale_mac: 'AA:BB:CC:DD:EE:FF',
      esphome_proxy: { host: 'p1.local', port: 6053, client_info: 'ble-scale-sync' },
    };
    const { ctx, asked } = ctxWith({ ble: structuredClone(ble) as never }, []);

    await bleStep.run(ctx);

    expect(ctx.config.ble).toMatchObject(ble);
    expect(asked).toContain('How do you want to identify your scale?');
    expect(asked.some((m) => /Select your scale/.test(m))).toBe(false);
  });
});

// The wizard wrote every secret into config.yaml in plaintext, the file
// people back up and paste into issues.
describe('a new secret can go to .env', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = snapshotEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    restoreEnv();
  });

  it('stores a typed secret as a ${VAR} reference by default', async () => {
    vi.stubEnv('HA_TOKEN', undefined as unknown as string);
    const { ctx } = ctxWith({}, [
      [/Home Assistant URL/, 'http://ha.local:8123'],
      [/access token/, 'plain-token'],
    ]);

    const ha = await promptHaBluetooth(ctx);

    expect(ha.token).toBe('${HA_TOKEN}');
    expect(ctx.pendingEnv?.get('HA_TOKEN')).toBe('plain-token');
    // The scan and the connectivity test resolve the reference before saving.
    expect(process.env.HA_TOKEN).toBe('plain-token');
  });

  // HA rejects a token with a space, and the .env got the untrimmed one.
  it('trims a pasted token before it goes to .env', async () => {
    vi.stubEnv('HA_TOKEN', undefined as unknown as string);
    const { ctx } = ctxWith({}, [
      [/Home Assistant URL/, 'http://ha.local:8123'],
      [/access token/, '  plain-token \t'],
    ]);

    const ha = await promptHaBluetooth(ctx);

    expect(ha.token).toBe('${HA_TOKEN}');
    expect(ctx.pendingEnv?.get('HA_TOKEN')).toBe('plain-token');
  });

  it('refuses a token of spaces', async () => {
    const { ctx, rejected } = ctxWith({}, [
      [/Home Assistant URL/, 'http://ha.local:8123'],
      [/access token/, '   '],
    ]);

    await promptHaBluetooth(ctx);

    expect(rejected).toEqual([expect.stringMatching(/Token is required/)]);
    expect(ctx.pendingEnv).toBeUndefined();
  });

  it('picks another name when the variable already holds something else', async () => {
    vi.stubEnv('HA_TOKEN', 'someone-elses');
    vi.stubEnv('HA_TOKEN_2', undefined as unknown as string);
    const { ctx } = ctxWith({}, [
      [/Home Assistant URL/, 'http://ha.local:8123'],
      [/access token/, 'plain-token'],
    ]);

    const ha = await promptHaBluetooth(ctx);

    expect(ha.token).toBe('${HA_TOKEN_2}');
    expect(process.env.HA_TOKEN).toBe('someone-elses');
  });

  // A variable set only by systemd or compose is invisible to the wizard, but
  // the config reading it means the name is taken.
  it('skips a name the config already references, whole or embedded', async () => {
    vi.stubEnv('HA_TOKEN', undefined as unknown as string);
    vi.stubEnv('HA_TOKEN_2', undefined as unknown as string);
    vi.stubEnv('HA_TOKEN_3', undefined as unknown as string);
    const config = {
      global_exporters: [
        { type: 'webhook', url: 'http://x', headers: { Authorization: 'Bearer ${HA_TOKEN}' } },
      ],
      users: [{ name: 'A', exporters: [{ type: 'ntfy', token: '${HA_TOKEN_2}' }] }],
    };
    const { ctx } = ctxWith(config as never, [
      [/Home Assistant URL/, 'http://ha.local:8123'],
      [/access token/, 'plain-token'],
    ]);

    const ha = await promptHaBluetooth(ctx);

    expect(ha.token).toBe('${HA_TOKEN_3}');
  });

  it('keeps it in config.yaml when declined', async () => {
    const { ctx } = ctxWith({}, [
      [/Home Assistant URL/, 'http://ha.local:8123'],
      [/access token/, 'plain-token'],
      [/Store it in \.env/, false],
    ]);

    const ha = await promptHaBluetooth(ctx);

    expect(ha.token).toBe('plain-token');
    expect(ctx.pendingEnv).toBeUndefined();
  });

  // A .env written inside a container is lost unless it is mounted.
  it('defaults to config.yaml inside a container', async () => {
    const { ctx } = ctxWith(
      {},
      [
        [/Home Assistant URL/, 'http://ha.local:8123'],
        [/access token/, 'plain-token'],
      ],
      true,
    );

    const ha = await promptHaBluetooth(ctx);

    expect(ha.token).toBe('plain-token');
  });

  it('does not offer .env for a reference the person typed', async () => {
    const { ctx, asked } = ctxWith({}, [
      [/Home Assistant URL/, 'http://ha.local:8123'],
      [/access token/, '${MY_TOKEN}'],
    ]);

    const ha = await promptHaBluetooth(ctx);

    expect(ha.token).toBe('${MY_TOKEN}');
    expect(asked.some((m) => /Store it in \.env/.test(m))).toBe(false);
  });
});
