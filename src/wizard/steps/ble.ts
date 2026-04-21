import type { WizardStep, WizardContext } from '../types.js';
import type { MqttProxyConfig, EsphomeProxyConfig } from '../../config/schema.js';
import { success, warn, info } from '../ui.js';

const MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const UUID_REGEX = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function validateMac(v: string): string | true {
  if (!MAC_REGEX.test(v) && !UUID_REGEX.test(v)) {
    return 'Must be a MAC address (XX:XX:XX:XX:XX:XX) or CoreBluetooth UUID';
  }
  return true;
}

function validateBrokerUrl(v: string): string | true {
  if (!v.startsWith('mqtt://') && !v.startsWith('mqtts://')) {
    return 'Must start with mqtt:// or mqtts://';
  }
  return true;
}

function validatePort(v: string): string | true {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Must be an integer between 1 and 65535';
  return true;
}

async function promptMqttProxy(ctx: WizardContext): Promise<MqttProxyConfig> {
  const brokerMode = await ctx.prompts.select('MQTT broker:', [
    {
      name: 'Use built-in embedded broker (Recommended, zero-config)',
      value: 'embedded' as const,
      description: 'BLE Scale Sync runs its own broker — the ESP32 connects to this machine',
    },
    {
      name: 'Use an external broker (e.g. Mosquitto, Home Assistant)',
      value: 'external' as const,
      description: 'Point at an existing MQTT broker on your network',
    },
  ]);

  const device_id = await ctx.prompts.input('ESP32 device ID:', {
    default: 'esp32-ble-proxy',
  });

  const topic_prefix = await ctx.prompts.input('MQTT topic prefix:', {
    default: 'ble-proxy',
  });

  let broker_url: string | undefined;
  let username: string | undefined;
  let password: string | undefined;
  let embedded_broker_port: number | undefined;
  let embedded_broker_bind: string | undefined;

  if (brokerMode === 'external') {
    broker_url = await ctx.prompts.input('MQTT broker URL:', {
      default: 'mqtt://localhost:1883',
      validate: validateBrokerUrl,
    });

    const hasAuth = await ctx.prompts.confirm('Does the MQTT broker require authentication?', {
      default: false,
    });

    if (hasAuth) {
      username = await ctx.prompts.input('MQTT username:');
      password = await ctx.prompts.password('MQTT password:');
    }
  } else {
    const portStr = await ctx.prompts.input('Embedded broker port:', {
      default: '1883',
      validate: validatePort,
    });
    embedded_broker_port = Number(portStr);

    embedded_broker_bind = '0.0.0.0';

    // Default to true because the broker binds 0.0.0.0 (LAN-exposed) and the
    // schema now rejects a non-loopback bind without auth. Declining here
    // switches the bind to loopback so the user gets a working zero-config
    // setup on single-host deployments.
    const wantAuth = await ctx.prompts.confirm(
      'Require username/password for the embedded broker? (recommended, broker is LAN-exposed)',
      { default: true },
    );
    if (wantAuth) {
      username = await ctx.prompts.input('MQTT username:');
      password = await ctx.prompts.password('MQTT password:');
    } else {
      embedded_broker_bind = '127.0.0.1';
      console.log(
        `\n  ${info('No auth selected, binding embedded broker to 127.0.0.1 (loopback only).')}`,
      );
    }
  }

  return {
    ...(broker_url ? { broker_url } : {}),
    device_id,
    topic_prefix,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(embedded_broker_port != null ? { embedded_broker_port } : {}),
    ...(embedded_broker_bind ? { embedded_broker_bind } : {}),
  } as MqttProxyConfig;
}

function validateEsphomeHost(v: string): string | true {
  if (!v.trim()) return 'Host is required (e.g. ble-proxy.local or 192.168.1.42)';
  return true;
}

async function promptEsphomeProxy(ctx: WizardContext): Promise<EsphomeProxyConfig> {
  const host = await ctx.prompts.input(
    'ESPHome proxy host (IP or mDNS name, e.g. ble-proxy.local):',
    { validate: validateEsphomeHost },
  );

  const portStr = await ctx.prompts.input('ESPHome API port:', {
    default: '6053',
    validate: validatePort,
  });
  const port = Number(portStr);

  const authMode = await ctx.prompts.select('Authentication:', [
    { name: 'None', value: 'none' as const },
    {
      name: 'Noise encryption key (Recommended)',
      value: 'noise' as const,
      description: '32-byte base64 pre-shared key from your ESPHome api config',
    },
    {
      name: 'Legacy password',
      value: 'password' as const,
      description: 'Deprecated plaintext auth — prefer Noise if your ESPHome supports it',
    },
  ]);

  let encryption_key: string | undefined;
  let password: string | undefined;
  if (authMode === 'noise') {
    encryption_key = await ctx.prompts.password('ESPHome API encryption key (base64):');
  } else if (authMode === 'password') {
    password = await ctx.prompts.password('ESPHome API password:');
  }

  return {
    host: host.trim(),
    port,
    client_info: 'ble-scale-sync',
    ...(encryption_key ? { encryption_key } : {}),
    ...(password ? { password } : {}),
  } as EsphomeProxyConfig;
}

export const bleStep: WizardStep = {
  id: 'ble',
  title: 'BLE Scale Discovery',
  order: 20,

  async run(ctx: WizardContext): Promise<void> {
    if (!ctx.config.ble) ctx.config.ble = { handler: 'auto' };

    // --- Handler selection ---
    const handler = await ctx.prompts.select('How does this device connect to your BLE scale?', [
      {
        name: 'Directly via Bluetooth (Recommended)',
        value: 'auto' as const,
        description: 'This machine has a Bluetooth adapter',
      },
      {
        name: 'Via ESP32 MQTT proxy (Experimental)',
        value: 'mqtt-proxy' as const,
        description: 'Remote BLE scanning via a dedicated ESP32 running our firmware',
      },
      {
        name: 'Via ESPHome Bluetooth proxy (Experimental, broadcast-only)',
        value: 'esphome-proxy' as const,
        description: 'Reuse an existing ESPHome BT proxy from Home Assistant',
      },
    ]);

    ctx.config.ble.handler = handler;

    if (handler === 'mqtt-proxy') {
      ctx.config.ble.mqtt_proxy = await promptMqttProxy(ctx);
      ctx.config.ble.esphome_proxy = undefined;
      console.log(`\n  ${info('MQTT proxy configured — scale discovery will use the ESP32.')}`);
    } else if (handler === 'esphome-proxy') {
      ctx.config.ble.esphome_proxy = await promptEsphomeProxy(ctx);
      ctx.config.ble.mqtt_proxy = undefined;
      console.log(
        `\n  ${info('ESPHome proxy configured — only broadcast scales are supported in phase 1.')}`,
      );
    } else {
      ctx.config.ble.mqtt_proxy = undefined;
      ctx.config.ble.esphome_proxy = undefined;
    }

    // --- Adapter selection (Linux + auto handler + node-ble only) ---
    const nobleForced = !!ctx.config.ble!.noble_driver || !!process.env.NOBLE_DRIVER;
    if (handler === 'auto' && ctx.platform.os === 'linux' && !nobleForced) {
      const existingAdapter = ctx.config.ble!.adapter;
      const wantAdapter = await ctx.prompts.confirm(
        'Do you want to select a specific Bluetooth adapter? (only needed with multiple adapters)',
        { default: !!existingAdapter },
      );

      if (wantAdapter) {
        let availableAdapters: string[] = [];
        try {
          const NodeBle = await import('node-ble');
          const { bluetooth, destroy } = NodeBle.default.createBluetooth();
          try {
            availableAdapters = await bluetooth.adapters();
          } finally {
            destroy();
          }
        } catch {
          // D-Bus not available — fall through to manual entry
        }

        if (availableAdapters.length > 1) {
          const choices = availableAdapters.map((a) => ({ name: a, value: a }));
          choices.push({ name: 'Default (system default)', value: '' });

          const selected = await ctx.prompts.select('Select Bluetooth adapter:', choices);
          if (selected) {
            ctx.config.ble!.adapter = selected;
            console.log(`\n  ${success(`BLE adapter set to: ${selected}`)}`);
          } else {
            ctx.config.ble!.adapter = undefined;
          }
        } else if (availableAdapters.length === 1) {
          const onlyAdapter = availableAdapters[0];
          if (existingAdapter && existingAdapter !== onlyAdapter) {
            console.log(
              `\n  ${warn(`Configured adapter "${existingAdapter}" was not found. Only "${onlyAdapter}" is available.`)}`,
            );
            const keep = await ctx.prompts.confirm(`Switch to ${onlyAdapter}?`, { default: true });
            ctx.config.ble!.adapter = keep ? onlyAdapter : existingAdapter;
            if (keep) {
              console.log(`\n  ${success(`BLE adapter set to: ${onlyAdapter}`)}`);
            }
          } else if (existingAdapter) {
            console.log(
              `\n  ${info(`Only one adapter found (${onlyAdapter}). Keeping existing: ${existingAdapter}`)}`,
            );
          } else {
            console.log(
              `\n  ${info(`Only one adapter found (${onlyAdapter}). Using system default.`)}`,
            );
          }
        } else {
          const defaultValue = existingAdapter ?? '';
          const adapterInput = await ctx.prompts.input(
            'Enter adapter name (e.g., hci0, hci1) or leave empty for default:',
            ...(defaultValue ? [{ default: defaultValue }] : []),
          );
          const normalized = adapterInput.trim().toLowerCase();
          if (normalized && /^hci\d+$/.test(normalized)) {
            ctx.config.ble!.adapter = normalized;
            console.log(`\n  ${success(`BLE adapter set to: ${normalized}`)}`);
          } else if (normalized) {
            console.log(
              `\n  ${warn(`Invalid adapter name "${adapterInput}". Using system default.`)}`,
            );
            ctx.config.ble!.adapter = undefined;
          } else {
            ctx.config.ble!.adapter = undefined;
          }
        }
      }
      // When user declines, preserve existing adapter (can be cleared via "Default" option above)
    }

    // --- Scale discovery ---
    for (;;) {
      const choice = await ctx.prompts.select('How do you want to identify your scale?', [
        {
          name: 'Scan for nearby scales (Recommended)',
          value: 'scan',
          description: 'Bluetooth scan for 15 seconds',
        },
        { name: 'Enter MAC address manually', value: 'manual' },
        {
          name: 'Skip — auto-discovery (Not recommended)',
          value: 'skip',
          description: "May connect to a neighbor's scale if multiple are in range",
        },
      ]);

      if (choice === 'skip') {
        ctx.config.ble.scale_mac = undefined;
        console.log('\n  Scale MAC skipped — auto-discovery will be used.');
        return;
      }

      if (choice === 'manual') {
        const mac = await ctx.prompts.input(
          'Enter scale MAC address (XX:XX:XX:XX:XX:XX, or empty to go back):',
          {
            validate: (v) => {
              if (!v.trim()) return true;
              return validateMac(v);
            },
          },
        );
        if (!mac.trim()) continue;
        ctx.config.ble.scale_mac = mac;
        console.log(`\n  ${success(`Scale MAC set to: ${mac}`)}`);
        return;
      }

      // Scan mode
      console.log('\nScanning for BLE devices... (15 seconds)');
      console.log('Make sure your scale is powered on (step on it to wake it up).\n');

      try {
        const { scanDevices } = await import('../../ble/index.js');
        const { adapters } = await import('../../scales/index.js');
        const { bootstrapMqttProxy } = await import('../../ble/mqtt-proxy-bootstrap.js');

        let mqttProxy = ctx.config.ble!.mqtt_proxy;
        let embeddedBroker: Awaited<ReturnType<typeof bootstrapMqttProxy>>['embeddedBroker'] = null;
        if (ctx.config.ble!.handler === 'mqtt-proxy' && mqttProxy) {
          const bootstrapped = await bootstrapMqttProxy(mqttProxy);
          mqttProxy = bootstrapped.mqttProxy;
          embeddedBroker = bootstrapped.embeddedBroker;
        }

        let results;
        try {
          results = await scanDevices(
            adapters,
            15_000,
            ctx.config.ble!.handler,
            mqttProxy,
            ctx.config.ble!.adapter ?? undefined,
            ctx.config.ble!.esphome_proxy,
          );
        } finally {
          if (embeddedBroker) await embeddedBroker.close();
        }
        const recognized = results.filter((r) => r.matchedAdapter);

        if (recognized.length === 0) {
          console.log(warn('No recognized scales found.'));
          const fallback = await ctx.prompts.select('What would you like to do?', [
            { name: 'Enter MAC address manually', value: 'manual' },
            { name: 'Skip (auto-discovery)', value: 'skip' },
          ]);

          if (fallback === 'manual') {
            const mac = await ctx.prompts.input('Enter scale MAC address (XX:XX:XX:XX:XX:XX):', {
              validate: validateMac,
            });
            ctx.config.ble.scale_mac = mac;
          }
          return;
        }

        console.log(success(`Found ${recognized.length} recognized scale(s):\n`));
        for (const s of recognized) {
          console.log(`  ${s.address}  ${s.name}  [${s.matchedAdapter}]`);
        }
        console.log('');

        if (recognized.length === 1) {
          const use = await ctx.prompts.confirm(
            `Use ${recognized[0].name} (${recognized[0].address})?`,
            { default: true },
          );
          if (use) {
            ctx.config.ble.scale_mac = recognized[0].address;
            console.log(`\n  ${success(`Scale MAC set to: ${recognized[0].address}`)}`);
          }
        } else {
          const choices = recognized.map((s) => ({
            name: `${s.name} (${s.address}) [${s.matchedAdapter}]`,
            value: s.address,
          }));
          choices.push({ name: 'Skip (auto-discovery)', value: '' });

          const selected = await ctx.prompts.select('Select your scale:', choices);
          if (selected) {
            ctx.config.ble.scale_mac = selected;
            console.log(`\n  ${success(`Scale MAC set to: ${selected}`)}`);
          }
        }
      } catch (err) {
        console.log(`\nBLE scan failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log('This may happen if no Bluetooth adapter is available.\n');

        const fallback = await ctx.prompts.select('What would you like to do?', [
          { name: 'Enter MAC address manually', value: 'manual' },
          { name: 'Skip (auto-discovery)', value: 'skip' },
        ]);

        if (fallback === 'manual') {
          const mac = await ctx.prompts.input('Enter scale MAC address (XX:XX:XX:XX:XX:XX):', {
            validate: validateMac,
          });
          ctx.config.ble.scale_mac = mac;
        }
      }

      return;
    }
  },
};

// Exported for testing
export {
  validateMac,
  validateBrokerUrl,
  validatePort,
  validateEsphomeHost,
  promptMqttProxy,
  promptEsphomeProxy,
};
