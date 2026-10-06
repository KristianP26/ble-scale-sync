import { describe, it, expect, afterEach } from 'vitest';
import {
  bleStep,
  validateMac,
  validateBrokerUrl,
  validateEsphomeHost,
  promptMqttProxy,
  promptEsphomeProxy,
  promptHaBluetooth,
} from '../../src/wizard/steps/ble.js';
import type { WizardContext } from '../../src/wizard/types.js';
import { scriptedPrompts, type ScriptedAnswer } from '../helpers/scripted-prompts.js';

const HANDLER = /^How does this device connect/;
const ADAPTER = /select a specific Bluetooth adapter/;
const DISCOVERY = /^How do you want to identify your scale/;
const MANUAL_MAC = /^Enter scale MAC address/;
const STORE_ENV = /Store it in \.env/;

const scripts: ReturnType<typeof scriptedPrompts>[] = [];

// Every scripted answer must have been asked for and accepted. A regex that
// matches no prompt would otherwise leave that prompt on its default, and the
// test would pass on a path it never meant to take.
afterEach(() => {
  for (const s of scripts.splice(0)) {
    expect(s.pending.map(([re]) => String(re))).toEqual([]);
    expect(s.rejected).toEqual([]);
  }
});

function makeCtx(answers: Array<[RegExp, ScriptedAnswer]> = []) {
  const scripted = scriptedPrompts(answers);
  scripts.push(scripted);
  const ctx: WizardContext = {
    config: {},
    configPath: 'config.yaml',
    isEditMode: false,
    nonInteractive: false,
    platform: {
      os: 'linux',
      arch: 'x64',
      hasDocker: false,
      hasPython: true,
      pythonCommand: 'python3',
    },
    prompts: scripted.prompts,
  };
  return { ctx, asked: scripted.asked };
}

// ─── validateMac() ──────────────────────────────────────────────────────

describe('validateMac()', () => {
  it('accepts valid MAC address', () => {
    expect(validateMac('AA:BB:CC:DD:EE:FF')).toBe(true);
  });

  it('accepts CoreBluetooth UUID', () => {
    expect(validateMac('12345678-1234-1234-1234-123456789ABC')).toBe(true);
  });

  it('accepts a bare 32-hex CoreBluetooth UUID (macOS, #212)', () => {
    expect(validateMac('360c96baf290475b14ce7c28aa3b8e81')).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(validateMac('not-a-mac')).toContain('Must be');
  });
});

// ─── validateBrokerUrl() ────────────────────────────────────────────────

describe('validateBrokerUrl()', () => {
  it('accepts mqtt:// URLs', () => {
    expect(validateBrokerUrl('mqtt://localhost:1883')).toBe(true);
  });

  it('accepts mqtts:// URLs', () => {
    expect(validateBrokerUrl('mqtts://broker.example.com:8883')).toBe(true);
  });

  it('rejects http:// URLs', () => {
    expect(validateBrokerUrl('http://localhost:1883')).toContain('Must start with');
  });

  it('rejects bare hostnames', () => {
    expect(validateBrokerUrl('localhost:1883')).toContain('Must start with');
  });
});

// ─── promptMqttProxy() ─────────────────────────────────────────────────

describe('promptMqttProxy()', () => {
  it('collects external broker details without auth', async () => {
    const { ctx } = makeCtx([
      [/^MQTT broker:/, 'external'],
      [/^ESP32 device ID:/, 'my-esp32'],
      [/^MQTT topic prefix:/, 'my-prefix'],
      [/^MQTT broker URL:/, 'mqtt://10.1.1.15:1883'],
      [/require authentication/, false],
    ]);

    const result = await promptMqttProxy(ctx);
    expect(result).toEqual({
      broker_url: 'mqtt://10.1.1.15:1883',
      device_id: 'my-esp32',
      topic_prefix: 'my-prefix',
    });
  });

  it('collects external broker details with auth', async () => {
    const { ctx } = makeCtx([
      [/^MQTT broker:/, 'external'],
      [/^ESP32 device ID:/, 'esp32-device'],
      [/^MQTT topic prefix:/, 'ble-proxy'],
      [/^MQTT broker URL:/, 'mqtts://broker.example.com:8883'],
      [/require authentication/, true],
      [/^MQTT username:/, 'myuser'],
      [/^MQTT password/, 'mypass'],
      [STORE_ENV, false], // keep it in config.yaml
    ]);

    const result = await promptMqttProxy(ctx);
    expect(result).toEqual({
      broker_url: 'mqtts://broker.example.com:8883',
      device_id: 'esp32-device',
      topic_prefix: 'ble-proxy',
      username: 'myuser',
      password: 'mypass',
    });
  });

  it('configures the embedded broker on loopback when the user declines auth', async () => {
    const { ctx } = makeCtx([
      [/^MQTT broker:/, 'embedded'],
      [/^ESP32 device ID:/, 'esp32-ble-proxy'],
      [/^MQTT topic prefix:/, 'ble-proxy'],
      [/^Embedded broker port:/, '1883'],
      [/^Require username\/password for the embedded broker/, false], // bind -> 127.0.0.1
    ]);

    const result = await promptMqttProxy(ctx);
    expect(result).toEqual({
      device_id: 'esp32-ble-proxy',
      topic_prefix: 'ble-proxy',
      embedded_broker_port: 1883,
      embedded_broker_bind: '127.0.0.1',
    });
    expect(result.broker_url).toBeUndefined();
  });

  it('configures the embedded broker with a custom port and auth', async () => {
    const { ctx } = makeCtx([
      [/^MQTT broker:/, 'embedded'],
      [/^ESP32 device ID:/, 'my-esp'],
      [/^MQTT topic prefix:/, 'ble-proxy'],
      [/^Embedded broker port:/, '1884'],
      [/^Require username\/password for the embedded broker/, true],
      [/^MQTT username:/, 'admin'],
      [/^MQTT password/, 'secret'],
      [STORE_ENV, false], // keep it in config.yaml
    ]);

    const result = await promptMqttProxy(ctx);
    expect(result).toEqual({
      device_id: 'my-esp',
      topic_prefix: 'ble-proxy',
      embedded_broker_port: 1884,
      embedded_broker_bind: '0.0.0.0',
      username: 'admin',
      password: 'secret',
    });
  });
});

describe('embedded broker password prompt', () => {
  // An empty answer used to be accepted and then dropped from the config,
  // leaving a LAN-exposed broker that takes the username with no password.
  it('refuses an empty password for the LAN-exposed embedded broker', async () => {
    const { ctx } = makeCtx([
      [/^MQTT broker:/, 'embedded'],
      [/^ESP32 device ID:/, 'my-esp'],
      [/^MQTT topic prefix:/, 'ble-proxy'],
      [/^Embedded broker port:/, '1883'],
      [/^Require username\/password for the embedded broker/, true],
      [/^MQTT username:/, 'admin'],
      [/^MQTT password/, 'secret'],
      [STORE_ENV, false],
    ]);
    let validate: ((v: string) => string | true) | undefined;
    const base = ctx.prompts;
    ctx.prompts = {
      ...base,
      password: async (message, opts) => {
        validate = opts?.validate;
        return base.password(message, opts);
      },
    };

    await promptMqttProxy(ctx);

    expect(validate).toBeDefined();
    expect(validate!('')).not.toBe(true);
    expect(validate!('secret')).toBe(true);
  });
});

describe('validateEsphomeHost()', () => {
  it('accepts a non-empty hostname', () => {
    expect(validateEsphomeHost('ble-proxy.local')).toBe(true);
  });

  it('accepts an IP address', () => {
    expect(validateEsphomeHost('192.168.1.42')).toBe(true);
  });

  it('rejects empty/whitespace-only input', () => {
    expect(validateEsphomeHost('')).toContain('required');
    expect(validateEsphomeHost('   ')).toContain('required');
  });
});

describe('promptEsphomeProxy()', () => {
  it('collects host + port with no auth', async () => {
    const { ctx } = makeCtx([
      [/^ESPHome proxy host/, 'ble-proxy.local'],
      [/^ESPHome proxy API port:/, '6053'],
      [/^ESPHome proxy authentication:/, 'none'],
      [/^Add another ESPHome proxy/, false],
    ]);

    const result = await promptEsphomeProxy(ctx);
    expect(result).toEqual({
      host: 'ble-proxy.local',
      port: 6053,
      client_info: 'ble-scale-sync',
    });
  });

  it('collects host + port + encryption_key when noise selected', async () => {
    const { ctx } = makeCtx([
      [/^ESPHome proxy host/, '192.168.1.42'],
      [/^ESPHome proxy API port:/, '6053'],
      [/^ESPHome proxy authentication:/, 'noise'],
      [/^ESPHome API encryption key/, 'SUPER_SECRET_BASE64_KEY=='],
      [STORE_ENV, false], // keep it in config.yaml
      [/^Add another ESPHome proxy/, false],
    ]);

    const result = await promptEsphomeProxy(ctx);
    expect(result).toEqual({
      host: '192.168.1.42',
      port: 6053,
      client_info: 'ble-scale-sync',
      encryption_key: 'SUPER_SECRET_BASE64_KEY==',
    });
  });

  it('collects host + port + legacy password when password selected', async () => {
    const { ctx } = makeCtx([
      [/^ESPHome proxy host/, 'ble-proxy.local'],
      [/^ESPHome proxy API port:/, '6053'],
      [/^ESPHome proxy authentication:/, 'password'],
      [/^ESPHome API password/, 'legacy-pass'],
      [STORE_ENV, false], // keep it in config.yaml
      [/^Add another ESPHome proxy/, false],
    ]);

    const result = await promptEsphomeProxy(ctx);
    expect(result).toEqual({
      host: 'ble-proxy.local',
      port: 6053,
      client_info: 'ble-scale-sync',
      password: 'legacy-pass',
    });
  });

  it('trims whitespace from host input', async () => {
    const { ctx } = makeCtx([
      [/^ESPHome proxy host/, '  192.168.1.42  '],
      [/^ESPHome proxy API port:/, '6053'],
      [/^ESPHome proxy authentication:/, 'none'],
      [/^Add another ESPHome proxy/, false],
    ]);
    const result = await promptEsphomeProxy(ctx);
    expect(result.host).toBe('192.168.1.42');
  });

  it('collects additional proxies for a mesh setup (#116)', async () => {
    const { ctx, asked } = makeCtx([
      [/^ESPHome proxy host/, 'ble-proxy.local'],
      [/^ESPHome proxy API port:/, '6053'],
      [/^ESPHome proxy authentication:/, 'none'],
      [/^Add another ESPHome proxy/, true],
      [/^Additional ESPHome proxy host/, 'proxy2.local'],
      [/^Additional ESPHome proxy API port:/, '6053'],
      [/^Additional ESPHome proxy authentication:/, 'noise'],
      [/^ESPHome API encryption key/, 'KEY2=='],
      [STORE_ENV, false], // keep it in config.yaml
      [/^Add another ESPHome proxy/, false],
    ]);

    const result = await promptEsphomeProxy(ctx);
    expect(result).toEqual({
      host: 'ble-proxy.local',
      port: 6053,
      client_info: 'ble-scale-sync',
      additional_proxies: [
        {
          host: 'proxy2.local',
          port: 6053,
          client_info: 'ble-scale-sync',
          encryption_key: 'KEY2==',
        },
      ],
    });
    // The extra proxy is asked for after "add another", and the question
    // comes back once it is done.
    expect(asked.filter((m) => /host|Add another/.test(m))).toEqual([
      expect.stringMatching(/^ESPHome proxy host/),
      expect.stringMatching(/^Add another ESPHome proxy/),
      expect.stringMatching(/^Additional ESPHome proxy host/),
      expect.stringMatching(/^Add another ESPHome proxy/),
    ]);
  });
});

describe('bleStep + esphome-proxy handler', () => {
  it('sets handler to esphome-proxy and clears mqtt_proxy', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'esphome-proxy'],
      [/^ESPHome proxy host/, 'ble-proxy.local'],
      [/^ESPHome proxy API port:/, '6053'],
      [/^ESPHome proxy authentication:/, 'none'],
      [/^Add another ESPHome proxy/, false],
      [DISCOVERY, 'skip'],
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.handler).toBe('esphome-proxy');
    expect(ctx.config.ble?.mqtt_proxy).toBeUndefined();
    expect(ctx.config.ble?.esphome_proxy).toEqual({
      host: 'ble-proxy.local',
      port: 6053,
      client_info: 'ble-scale-sync',
    });
  });
});

describe('bleStep + ha-bluetooth handler', () => {
  it('sets handler to ha-bluetooth and clears the other proxy blocks', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'ha-bluetooth'],
      [/^Home Assistant URL/, 'http://homeassistant.local:8123'],
      [/access token/, '${HA_TOKEN}'], // a reference is not offered for .env
      [/^Only accept advertisements from this HA scanner/, ''], // no source filter
      [DISCOVERY, 'skip'],
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.handler).toBe('ha-bluetooth');
    expect(ctx.config.ble?.mqtt_proxy).toBeUndefined();
    expect(ctx.config.ble?.esphome_proxy).toBeUndefined();
    expect(ctx.config.ble?.ha_bluetooth).toEqual({
      url: 'http://homeassistant.local:8123',
      token: '${HA_TOKEN}',
    });
  });
});

// ─── bleStep handler selection ──────────────────────────────────────────

describe('bleStep handler selection', () => {
  it('sets handler to auto and clears mqtt_proxy when auto selected', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'auto'],
      [ADAPTER, false],
      [DISCOVERY, 'skip'],
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.handler).toBe('auto');
    expect(ctx.config.ble?.mqtt_proxy).toBeUndefined();
  });

  it('sets handler to mqtt-proxy with external broker config', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'mqtt-proxy'],
      [/^MQTT broker:/, 'external'],
      [/^ESP32 device ID:/, 'esp32-ble-proxy'],
      [/^MQTT topic prefix:/, 'ble-proxy'],
      [/^MQTT broker URL:/, 'mqtt://10.1.1.15:1883'],
      [/require authentication/, false],
      [DISCOVERY, 'skip'],
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.handler).toBe('mqtt-proxy');
    expect(ctx.config.ble?.mqtt_proxy).toEqual({
      broker_url: 'mqtt://10.1.1.15:1883',
      device_id: 'esp32-ble-proxy',
      topic_prefix: 'ble-proxy',
    });
  });

  it('sets handler to mqtt-proxy with external broker and auth', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'mqtt-proxy'],
      [/^MQTT broker:/, 'external'],
      [/^ESP32 device ID:/, 'my-esp'],
      [/^MQTT topic prefix:/, 'prefix'],
      [/^MQTT broker URL:/, 'mqtt://broker:1883'],
      [/require authentication/, true],
      [/^MQTT username:/, 'admin'],
      [/^MQTT password/, 'secret'],
      [STORE_ENV, false], // keep it in config.yaml
      [DISCOVERY, 'manual'],
      [MANUAL_MAC, 'AA:BB:CC:DD:EE:FF'],
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.handler).toBe('mqtt-proxy');
    expect(ctx.config.ble?.mqtt_proxy?.username).toBe('admin');
    expect(ctx.config.ble?.mqtt_proxy?.password).toBe('secret');
    expect(ctx.config.ble?.scale_mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('sets handler to mqtt-proxy with embedded broker bound to loopback when auth declined', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'mqtt-proxy'],
      [/^MQTT broker:/, 'embedded'],
      [/^ESP32 device ID:/, 'esp32-ble-proxy'],
      [/^MQTT topic prefix:/, 'ble-proxy'],
      [/^Embedded broker port:/, '1883'],
      [/^Require username\/password for the embedded broker/, false], // bind -> 127.0.0.1
      [DISCOVERY, 'skip'],
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.handler).toBe('mqtt-proxy');
    expect(ctx.config.ble?.mqtt_proxy).toEqual({
      device_id: 'esp32-ble-proxy',
      topic_prefix: 'ble-proxy',
      embedded_broker_port: 1883,
      embedded_broker_bind: '127.0.0.1',
    });
    expect(ctx.config.ble?.mqtt_proxy?.broker_url).toBeUndefined();
  });

  it('initializes ble config if not present', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'auto'],
      [ADAPTER, false],
      [DISCOVERY, 'skip'],
    ]);
    ctx.config.ble = undefined;

    await bleStep.run(ctx);

    expect(ctx.config.ble).toBeDefined();
    expect(ctx.config.ble?.handler).toBe('auto');
  });
});

// ─── bleStep adapter selection ─────────────────────────────────────────

describe('bleStep adapter selection', () => {
  it('skips adapter prompt on non-Linux platforms', async () => {
    const { ctx, asked } = makeCtx([
      [HANDLER, 'auto'],
      [DISCOVERY, 'skip'],
    ]);
    ctx.platform.os = 'darwin';

    await bleStep.run(ctx);

    expect(asked.some((m) => ADAPTER.test(m))).toBe(false);
    expect(ctx.config.ble?.adapter).toBeUndefined();
  });

  it('skips adapter prompt when handler is mqtt-proxy', async () => {
    const { ctx, asked } = makeCtx([
      [HANDLER, 'mqtt-proxy'],
      [/^MQTT broker:/, 'external'],
      [/^ESP32 device ID:/, 'esp32-ble-proxy'],
      [/^MQTT topic prefix:/, 'ble-proxy'],
      [/^MQTT broker URL:/, 'mqtt://localhost:1883'],
      [/require authentication/, false],
      [DISCOVERY, 'skip'],
    ]);
    ctx.platform.os = 'linux';

    await bleStep.run(ctx);

    expect(asked.some((m) => ADAPTER.test(m))).toBe(false);
    expect(ctx.config.ble?.adapter).toBeUndefined();
  });

  it('leaves adapter undefined when user declines on Linux (no existing adapter)', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'auto'],
      [ADAPTER, false],
      [DISCOVERY, 'skip'],
    ]);
    ctx.platform.os = 'linux';

    await bleStep.run(ctx);

    expect(ctx.config.ble?.adapter).toBeUndefined();
  });

  it('preserves existing adapter when user declines on Linux', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'auto'],
      [ADAPTER, false], // the default is yes because an adapter exists
      [DISCOVERY, 'skip'],
    ]);
    ctx.platform.os = 'linux';
    ctx.config.ble = { handler: 'auto', adapter: 'hci1' };

    await bleStep.run(ctx);

    expect(ctx.config.ble?.adapter).toBe('hci1');
  });
});

// ─── bleStep scale discovery (auto handler) ─────────────────────────────

describe('bleStep scale discovery', () => {
  it('sets scale_mac to undefined when skip is selected', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'auto'],
      [ADAPTER, false],
      [DISCOVERY, 'skip'],
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.scale_mac).toBeUndefined();
  });

  it('sets scale_mac when manual entry is used', async () => {
    const { ctx } = makeCtx([
      [HANDLER, 'auto'],
      [ADAPTER, false],
      [DISCOVERY, 'manual'],
      [MANUAL_MAC, 'AA:BB:CC:DD:EE:FF'],
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.scale_mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('goes back to discovery menu when manual entry is empty', async () => {
    const { ctx, asked } = makeCtx([
      [HANDLER, 'auto'],
      [ADAPTER, false],
      [DISCOVERY, 'manual'], // first attempt
      [MANUAL_MAC, ''], // empty -> go back
      [DISCOVERY, 'skip'], // second attempt
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.scale_mac).toBeUndefined();
    expect(asked.filter((m) => DISCOVERY.test(m) || MANUAL_MAC.test(m))).toEqual([
      expect.stringMatching(DISCOVERY),
      expect.stringMatching(MANUAL_MAC),
      expect.stringMatching(DISCOVERY),
    ]);
  });
});

describe('promptHaBluetooth token prompt', () => {
  // The token is an admin credential; an input prompt echoed it to the screen.
  it('asks for the access token with a masked password prompt', async () => {
    const { ctx } = makeCtx([
      [/Home Assistant URL/, 'http://ha.local:8123'],
      [/access token/, 'secret-token'],
      [STORE_ENV, false],
    ]);
    const echoed: string[] = [];
    const input = ctx.prompts.input;
    ctx.prompts.input = async (message, opts) => {
      echoed.push(message);
      return input(message, opts);
    };

    const ha = await promptHaBluetooth(ctx);

    expect(ha.token).toBe('secret-token');
    expect(echoed.some((m) => /access token/.test(m))).toBe(false);
  });
});
