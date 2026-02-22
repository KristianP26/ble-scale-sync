import { describe, it, expect } from 'vitest';
import {
  bleStep,
  validateMac,
  validateBrokerUrl,
  promptMqttProxy,
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
  it('collects broker details without auth', async () => {
    const ctx = makeCtx([
      'mqtt://10.1.1.15:1883', // broker_url
      'my-esp32', // device_id
      'my-prefix', // topic_prefix
      false, // hasAuth = no
    ]);

    const result = await promptMqttProxy(ctx);
    expect(result).toEqual({
      broker_url: 'mqtt://10.1.1.15:1883',
      device_id: 'my-esp32',
      topic_prefix: 'my-prefix',
    });
  });

  it('collects broker details with auth', async () => {
    const ctx = makeCtx([
      'mqtts://broker.example.com:8883', // broker_url
      'esp32-device', // device_id
      'ble-proxy', // topic_prefix
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
});

// ─── bleStep handler selection ──────────────────────────────────────────

describe('bleStep handler selection', () => {
  it('sets handler to auto and clears mqtt_proxy when auto selected', async () => {
    const ctx = makeCtx([
      'auto', // handler selection
      'skip', // scale discovery → skip
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.handler).toBe('auto');
    expect(ctx.config.ble?.mqtt_proxy).toBeUndefined();
  });

  it('sets handler to mqtt-proxy with broker config', async () => {
    const ctx = makeCtx([
      'mqtt-proxy', // handler selection
      'mqtt://10.1.1.15:1883', // broker_url
      'esp32-ble-proxy', // device_id
      'ble-proxy', // topic_prefix
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

  it('sets handler to mqtt-proxy with auth credentials', async () => {
    const ctx = makeCtx([
      'mqtt-proxy', // handler selection
      'mqtt://broker:1883', // broker_url
      'my-esp', // device_id
      'prefix', // topic_prefix
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

  it('initializes ble config if not present', async () => {
    const ctx = makeCtx(['auto', 'skip']);
    ctx.config.ble = undefined;

    await bleStep.run(ctx);

    expect(ctx.config.ble).toBeDefined();
    expect(ctx.config.ble?.handler).toBe('auto');
  });
});

// ─── bleStep scale discovery (auto handler) ─────────────────────────────

describe('bleStep scale discovery', () => {
  it('sets scale_mac to undefined when skip is selected', async () => {
    const ctx = makeCtx([
      'auto', // handler
      'skip', // discovery
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.scale_mac).toBeUndefined();
  });

  it('sets scale_mac when manual entry is used', async () => {
    const ctx = makeCtx([
      'auto', // handler
      'manual', // discovery
      'AA:BB:CC:DD:EE:FF', // MAC
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.scale_mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('goes back to discovery menu when manual entry is empty', async () => {
    const ctx = makeCtx([
      'auto', // handler
      'manual', // discovery (first attempt)
      '', // empty → go back
      'skip', // discovery (second attempt) → skip
    ]);

    await bleStep.run(ctx);

    expect(ctx.config.ble?.scale_mac).toBeUndefined();
  });
});
