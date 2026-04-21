import { describe, it, expect } from 'vitest';
import {
  bleStep,
  validateMac,
  validateBrokerUrl,
  validateEsphomeHost,
  promptMqttProxy,
  promptEsphomeProxy,
} from '../../src/wizard/steps/ble.js';
import type { WizardContext } from '../../src/wizard/types.js';
import { createMockPromptProvider } from '../../src/wizard/prompt-provider.js';

function makeCtx(answers: (string | number | boolean | string[])[]): WizardContext {
  return {
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
    stepHistory: [],
    prompts: createMockPromptProvider(answers),
  };
}

// ─── validateMac() ──────────────────────────────────────────────────────

describe('validateMac()', () => {
  it('accepts valid MAC address', () => {
    expect(validateMac('AA:BB:CC:DD:EE:FF')).toBe(true);
  });

  it('accepts CoreBluetooth UUID', () => {
    expect(validateMac('12345678-1234-1234-1234-123456789ABC')).toBe(true);
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
    const ctx = makeCtx([
      'external', // broker mode
      'my-esp32', // device_id
      'my-prefix', // topic_prefix
      'mqtt://10.1.1.15:1883', // broker_url
      false, // hasAuth = no
    ]);

    const result = await promptMqttProxy(ctx);
    expect(result).toEqual({
      broker_url: 'mqtt://10.1.1.15:1883',
      device_id: 'my-esp32',
      topic_prefix: 'my-prefix',
    });
  });

  it('collects external broker details with auth', async () => {
    const ctx = makeCtx([
      'external', // broker mode
      'esp32-device', // device_id
      'ble-proxy', // topic_prefix
      'mqtts://broker.example.com:8883', // broker_url
      true, // hasAuth = yes
      'myuser', // username
      'mypass', // password
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

  it('configures the embedded broker with the default port and no auth', async () => {
    const ctx = makeCtx([
      'embedded', // broker mode
      'esp32-ble-proxy', // device_id
      'ble-proxy', // topic_prefix
      '1883', // embedded_broker_port
      false, // wantAuth = no
    ]);

    const result = await promptMqttProxy(ctx);
    expect(result).toEqual({
      device_id: 'esp32-ble-proxy',
      topic_prefix: 'ble-proxy',
      embedded_broker_port: 1883,
      embedded_broker_bind: '0.0.0.0',
    });
    expect(result.broker_url).toBeUndefined();
  });

  it('configures the embedded broker with a custom port and auth', async () => {
    const ctx = makeCtx([
      'embedded', // broker mode
      'my-esp', // device_id
      'ble-proxy', // topic_prefix
      '1884', // embedded_broker_port
      true, // wantAuth = yes
      'admin', // username
      'secret', // password
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
    const ctx = makeCtx([
      'ble-proxy.local', // host
      '6053', // port
      'none', // auth mode
    ]);

    const result = await promptEsphomeProxy(ctx);
    expect(result).toEqual({
      host: 'ble-proxy.local',
      port: 6053,
      client_info: 'ble-scale-sync',
    });
  });

  it('collects host + port + encryption_key when noise selected', async () => {
    const ctx = makeCtx([
      '192.168.1.42', // host
      '6053', // port
      'noise', // auth mode
      'SUPER_SECRET_BASE64_KEY==', // encryption key
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
    const ctx = makeCtx([
      'ble-proxy.local', // host
      '6053', // port
      'password', // auth mode
      'legacy-pass', // password
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
    const ctx = makeCtx(['  192.168.1.42  ', '6053', 'none']);
    const result = await promptEsphomeProxy(ctx);
    expect(result.host).toBe('192.168.1.42');
  });
});

describe('bleStep + esphome-proxy handler', () => {
  it('sets handler to esphome-proxy and clears mqtt_proxy', async () => {
    const ctx = makeCtx([
      'esphome-proxy', // handler
      'ble-proxy.local', // host
      '6053', // port
      'none', // auth
      'skip', // scale discovery
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

// ─── bleStep handler selection ──────────────────────────────────────────

describe('bleStep handler selection', () => {
  it('sets handler to auto and clears mqtt_proxy when auto selected', async () => {
    const ctx = makeCtx([
      'auto', // handler selection
      false, // adapter selection → no
      'skip', // scale discovery → skip
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.handler).toBe('auto');
    expect(ctx.config.ble?.mqtt_proxy).toBeUndefined();
  });

  it('sets handler to mqtt-proxy with external broker config', async () => {
    const ctx = makeCtx([
      'mqtt-proxy', // handler selection
      'external', // broker mode
      'esp32-ble-proxy', // device_id
      'ble-proxy', // topic_prefix
      'mqtt://10.1.1.15:1883', // broker_url
      false, // no auth
      'skip', // scale discovery → skip
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
    const ctx = makeCtx([
      'mqtt-proxy', // handler selection
      'external', // broker mode
      'my-esp', // device_id
      'prefix', // topic_prefix
      'mqtt://broker:1883', // broker_url
      true, // has auth
      'admin', // username
      'secret', // password
      'manual', // scale discovery → manual
      'AA:BB:CC:DD:EE:FF', // MAC address
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.handler).toBe('mqtt-proxy');
    expect(ctx.config.ble?.mqtt_proxy?.username).toBe('admin');
    expect(ctx.config.ble?.mqtt_proxy?.password).toBe('secret');
    expect(ctx.config.ble?.scale_mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('sets handler to mqtt-proxy with embedded broker (default port, no auth)', async () => {
    const ctx = makeCtx([
      'mqtt-proxy', // handler selection
      'embedded', // broker mode
      'esp32-ble-proxy', // device_id
      'ble-proxy', // topic_prefix
      '1883', // embedded_broker_port
      false, // wantAuth = no
      'skip', // scale discovery → skip
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.handler).toBe('mqtt-proxy');
    expect(ctx.config.ble?.mqtt_proxy).toEqual({
      device_id: 'esp32-ble-proxy',
      topic_prefix: 'ble-proxy',
      embedded_broker_port: 1883,
      embedded_broker_bind: '0.0.0.0',
    });
    expect(ctx.config.ble?.mqtt_proxy?.broker_url).toBeUndefined();
  });

  it('initializes ble config if not present', async () => {
    const ctx = makeCtx(['auto', false, 'skip']);
    ctx.config.ble = undefined;

    await bleStep.run(ctx);

    expect(ctx.config.ble).toBeDefined();
    expect(ctx.config.ble?.handler).toBe('auto');
  });
});

// ─── bleStep adapter selection ─────────────────────────────────────────

describe('bleStep adapter selection', () => {
  it('skips adapter prompt on non-Linux platforms', async () => {
    const ctx = makeCtx([
      'auto', // handler
      'skip', // scale discovery (no adapter prompt expected)
    ]);
    ctx.platform.os = 'darwin';

    await bleStep.run(ctx);

    expect(ctx.config.ble?.adapter).toBeUndefined();
  });

  it('skips adapter prompt when handler is mqtt-proxy', async () => {
    const ctx = makeCtx([
      'mqtt-proxy', // handler
      'external', // broker mode
      'esp32-ble-proxy', // device_id
      'ble-proxy', // topic_prefix
      'mqtt://localhost:1883', // broker_url
      false, // no auth
      'skip', // scale discovery
    ]);
    ctx.platform.os = 'linux';

    await bleStep.run(ctx);

    expect(ctx.config.ble?.adapter).toBeUndefined();
  });

  it('leaves adapter undefined when user declines on Linux (no existing adapter)', async () => {
    const ctx = makeCtx([
      'auto', // handler
      false, // wantAdapter = no
      'skip', // scale discovery
    ]);
    ctx.platform.os = 'linux';

    await bleStep.run(ctx);

    expect(ctx.config.ble?.adapter).toBeUndefined();
  });

  it('preserves existing adapter when user declines on Linux', async () => {
    const ctx = makeCtx([
      'auto', // handler
      false, // wantAdapter = no (default is true because adapter exists)
      'skip', // scale discovery
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
    const ctx = makeCtx([
      'auto', // handler
      false, // adapter selection → no
      'skip', // discovery
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.scale_mac).toBeUndefined();
  });

  it('sets scale_mac when manual entry is used', async () => {
    const ctx = makeCtx([
      'auto', // handler
      false, // adapter selection → no
      'manual', // discovery
      'AA:BB:CC:DD:EE:FF', // MAC
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.scale_mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('goes back to discovery menu when manual entry is empty', async () => {
    const ctx = makeCtx([
      'auto', // handler
      false, // adapter selection → no
      'manual', // discovery (first attempt)
      '', // empty → go back
      'skip', // discovery (second attempt) → skip
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.scale_mac).toBeUndefined();
  });
});
