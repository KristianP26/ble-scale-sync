import type { WizardStep, WizardContext } from '../types.js';
import type {
  MqttProxyConfig,
  EsphomeProxyConfig,
  HaBluetoothConfig,
} from '../../config/schema.js';
import { resolveEnvReferences } from '../../config/env-refs.js';
import { isValidScaleId, SCALE_ID_HINT } from '../../ble/scale-id.js';
import { missingPackagesFor } from '../../ble/transport-availability.js';
import { isLoopback } from '../../ble/loopback.js';
import { success, warn, info } from '../ui.js';
import { currentFirst } from '../choices.js';
import { promptSecret } from '../secrets.js';

function validateMac(v: string): string | true {
  if (!isValidScaleId(v)) {
    return `Must be ${SCALE_ID_HINT}`;
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

/** `current` without the keys a prompt function manages, so the rest survive an edit. */
function unmanaged<T extends object>(
  current: T | undefined,
  managed: readonly string[],
): Partial<T> {
  const rest: Record<string, unknown> = { ...(current ?? {}) };
  for (const k of managed) delete rest[k];
  return rest as Partial<T>;
}

const MQTT_PROXY_KEYS = [
  'broker_url',
  'device_id',
  'topic_prefix',
  'username',
  'password',
  'embedded_broker_port',
  'embedded_broker_bind',
] as const;

/**
 * Ask for the ESP32 MQTT proxy settings. Every prompt starts from `current`
 * (edit mode, or the section picked again), the password is kept on Enter, and
 * keys this does not ask about survive. It used to start from nothing, so
 * changing the scale MAC meant retyping the broker password.
 */
async function promptMqttProxy(
  ctx: WizardContext,
  current?: Partial<MqttProxyConfig>,
): Promise<MqttProxyConfig> {
  const brokerMode = await ctx.prompts.select(
    'MQTT broker:',
    currentFirst(
      [
        {
          name: 'Use built-in embedded broker (Recommended, zero-config)',
          value: 'embedded' as const,
          description: 'BLE Scale Sync runs its own broker so the ESP32 connects to this machine',
        },
        {
          name: 'Use an external broker (e.g. Mosquitto, Home Assistant)',
          value: 'external' as const,
          description: 'Point at an existing MQTT broker on your network',
        },
      ],
      current ? (current.broker_url ? 'external' : 'embedded') : undefined,
    ),
  );

  const device_id = await ctx.prompts.input('ESP32 device ID:', {
    default: current?.device_id ?? 'esp32-ble-proxy',
  });

  const topic_prefix = await ctx.prompts.input('MQTT topic prefix:', {
    default: current?.topic_prefix ?? 'ble-proxy',
  });

  let broker_url: string | undefined;
  let username: string | undefined;
  let password: string | undefined;
  let embedded_broker_port: number | undefined;
  let embedded_broker_bind: string | undefined;

  if (brokerMode === 'external') {
    broker_url = await ctx.prompts.input('MQTT broker URL:', {
      default: current?.broker_url ?? 'mqtt://localhost:1883',
      validate: validateBrokerUrl,
    });

    const hasAuth = await ctx.prompts.confirm('Does the MQTT broker require authentication?', {
      default: !!current?.username,
    });

    if (hasAuth) {
      username = await ctx.prompts.input('MQTT username:', {
        default: current?.username ?? undefined,
      });
      password = await promptSecret(ctx, 'MQTT password', current?.password, [
        'mqtt_proxy',
        'password',
      ]);
    }
  } else {
    const portStr = await ctx.prompts.input('Embedded broker port:', {
      default: String(current?.embedded_broker_port ?? 1883),
      validate: validatePort,
    });
    embedded_broker_port = Number(portStr);

    // The bind is not asked, so an existing one is kept: rebuilding it as
    // 0.0.0.0 silently put a broker bound to one LAN address, or to loopback
    // with auth, on every interface.
    embedded_broker_bind = current?.embedded_broker_bind ?? '0.0.0.0';

    // Default to true because the broker binds 0.0.0.0 (LAN-exposed) and the
    // schema now rejects a non-loopback bind without auth. Declining here
    // switches a non-loopback bind to loopback so the user gets a working
    // zero-config setup on single-host deployments. An existing loopback
    // broker without auth keeps that answer as its default.
    const wasOpenLoopback =
      current !== undefined &&
      !current.broker_url &&
      !current.username &&
      isLoopback(embedded_broker_bind);
    const wantAuth = await ctx.prompts.confirm(
      'Require username/password for the embedded broker? (recommended, broker is LAN-exposed)',
      { default: !wasOpenLoopback },
    );
    if (wantAuth) {
      // Both are required: a LAN-exposed broker with a username and an empty
      // password lets in anyone who knows the username.
      username = await ctx.prompts.input('MQTT username:', {
        default: current?.username ?? undefined,
        validate: (v) => (v.trim() ? true : 'A username is required'),
      });
      password = await promptSecret(
        ctx,
        'MQTT password',
        current?.password,
        ['mqtt_proxy', 'password'],
        { required: 'A password is required for a LAN-exposed broker' },
      );
    } else if (!isLoopback(embedded_broker_bind)) {
      embedded_broker_bind = '127.0.0.1';
      console.log(
        `\n  ${info('No auth selected, binding embedded broker to 127.0.0.1 (loopback only).')}`,
      );
    }
  }

  return {
    ...unmanaged(current, MQTT_PROXY_KEYS),
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

type EsphomeEndpoint = EsphomeProxyConfig['additional_proxies'][number];

const ESPHOME_ENDPOINT_KEYS = ['host', 'port', 'encryption_key', 'password'] as const;

/**
 * Ask for one ESPHome API endpoint, starting from `current`. `nameSuffix`
 * tells the .env names of several proxies apart.
 */
async function promptEsphomeEndpoint(
  ctx: WizardContext,
  label: string,
  current?: Partial<EsphomeEndpoint>,
  nameSuffix?: string,
): Promise<EsphomeEndpoint> {
  const host = await ctx.prompts.input(`${label} host (IP or mDNS name, e.g. ble-proxy.local):`, {
    default: current?.host,
    validate: validateEsphomeHost,
  });

  const portStr = await ctx.prompts.input(`${label} API port:`, {
    default: String(current?.port ?? 6053),
    validate: validatePort,
  });
  const port = Number(portStr);

  const currentMode = current
    ? current.encryption_key
      ? 'noise'
      : current.password
        ? 'password'
        : 'none'
    : undefined;
  const authMode = await ctx.prompts.select(
    `${label} authentication:`,
    currentFirst(
      [
        { name: 'None', value: 'none' as const },
        {
          name: 'Noise encryption key (Recommended)',
          value: 'noise' as const,
          description: '32-byte base64 pre-shared key from your ESPHome api config',
        },
        {
          name: 'Legacy password',
          value: 'password' as const,
          description: 'Deprecated plaintext auth. Prefer Noise if your ESPHome supports it',
        },
      ],
      currentMode,
    ),
  );

  let encryption_key: string | undefined;
  let password: string | undefined;
  if (authMode === 'noise') {
    encryption_key = await promptSecret(
      ctx,
      'ESPHome API encryption key (base64)',
      current?.encryption_key,
      ['esphome', 'encryption_key', nameSuffix],
    );
  } else if (authMode === 'password') {
    password = await promptSecret(ctx, 'ESPHome API password', current?.password, [
      'esphome',
      'password',
      nameSuffix,
    ]);
  }

  return {
    ...unmanaged(current, ESPHOME_ENDPOINT_KEYS),
    host: host.trim(),
    port,
    client_info: current?.client_info ?? 'ble-scale-sync',
    ...(encryption_key ? { encryption_key } : {}),
    ...(password ? { password } : {}),
  } as EsphomeEndpoint;
}

type KeepEditRemove = 'keep' | 'edit' | 'remove';

async function promptEsphomeProxy(
  ctx: WizardContext,
  current?: Partial<EsphomeProxyConfig>,
): Promise<EsphomeProxyConfig> {
  const { additional_proxies: existing = [], ...currentPrimary } = current ?? {};
  const primary = await promptEsphomeEndpoint(
    ctx,
    'ESPHome proxy',
    current ? (currentPrimary as Partial<EsphomeEndpoint>) : undefined,
  );

  const additional_proxies: EsphomeEndpoint[] = [];
  for (const proxy of existing) {
    const action = await ctx.prompts.select<KeepEditRemove>(
      `Additional ESPHome proxy ${proxy.host}:`,
      [
        { name: 'Keep unchanged', value: 'keep' },
        { name: 'Edit', value: 'edit' },
        { name: 'Remove', value: 'remove' },
      ],
    );
    if (action === 'keep') additional_proxies.push(proxy);
    else if (action === 'edit') {
      const suffix = String(additional_proxies.length + 2);
      additional_proxies.push(
        await promptEsphomeEndpoint(ctx, 'Additional ESPHome proxy', proxy, suffix),
      );
    }
  }
  while (
    await ctx.prompts.confirm('Add another ESPHome proxy? (mesh setup, optional)', {
      default: false,
    })
  ) {
    const suffix = String(additional_proxies.length + 2);
    additional_proxies.push(
      await promptEsphomeEndpoint(ctx, 'Additional ESPHome proxy', undefined, suffix),
    );
  }

  return {
    ...primary,
    ...(additional_proxies.length > 0 ? { additional_proxies } : {}),
  } as EsphomeProxyConfig;
}

function validateHaUrl(v: string): string | true {
  if (!/^(https?|wss?):\/\/\S+$/.test(v.trim())) {
    return 'Enter the Home Assistant URL, e.g. http://homeassistant.local:8123';
  }
  return true;
}

async function promptHaBluetooth(
  ctx: WizardContext,
  current?: Partial<HaBluetoothConfig>,
): Promise<HaBluetoothConfig> {
  const url = await ctx.prompts.input(
    'Home Assistant URL (e.g. http://homeassistant.local:8123):',
    { default: current?.url, validate: validateHaUrl },
  );
  // A password prompt: this is an admin token, and an input prompt left it on
  // screen and in the terminal scrollback.
  const token = await promptSecret(
    ctx,
    'Long-lived access token of an ADMIN user (Profile > Security), or ${HA_TOKEN} to read it from .env',
    current?.token,
    ['ha', 'token'],
    // HA rejects a token with a space, and a pasted one often ends in one.
    { required: 'Token is required', trim: true },
  );
  const source = await ctx.prompts.input(
    'Only accept advertisements from this HA scanner (source id; leave empty for all):',
    { default: current?.source ?? '' },
  );
  return {
    ...unmanaged(current, ['url', 'token', 'source']),
    url: url.trim(),
    token: (token ?? '').trim(),
    ...(source.trim() ? { source: source.trim() } : {}),
  } as HaBluetoothConfig;
}

export const bleStep: WizardStep = {
  id: 'ble',
  title: 'BLE Scale Discovery',
  order: 20,

  async run(ctx: WizardContext): Promise<void> {
    if (!ctx.config.ble) ctx.config.ble = { handler: 'auto' };

    // --- Handler selection ---
    const handler = await ctx.prompts.select(
      'How does this device connect to your BLE scale?',
      currentFirst(
        [
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
          {
            name: 'Via Home Assistant Bluetooth (Experimental, broadcast-only)',
            value: 'ha-bluetooth' as const,
            description:
              "Subscribe to Home Assistant's advertisement stream (any HA Bluetooth proxy)",
          },
        ],
        ctx.config.ble.handler,
      ),
    );

    ctx.config.ble.handler = handler;

    if (handler === 'mqtt-proxy') {
      ctx.config.ble.mqtt_proxy = await promptMqttProxy(
        ctx,
        ctx.config.ble.mqtt_proxy ?? undefined,
      );
      ctx.config.ble.esphome_proxy = undefined;
      ctx.config.ble.ha_bluetooth = undefined;
      console.log(`\n  ${info('MQTT proxy configured. Scale discovery will use the ESP32.')}`);
    } else if (handler === 'esphome-proxy') {
      ctx.config.ble.esphome_proxy = await promptEsphomeProxy(
        ctx,
        ctx.config.ble.esphome_proxy ?? undefined,
      );
      ctx.config.ble.mqtt_proxy = undefined;
      ctx.config.ble.ha_bluetooth = undefined;
      console.log(
        `\n  ${info('ESPHome proxy configured. Only broadcast scales are supported in phase 1.')}`,
      );
    } else if (handler === 'ha-bluetooth') {
      ctx.config.ble.ha_bluetooth = await promptHaBluetooth(
        ctx,
        ctx.config.ble.ha_bluetooth ?? undefined,
      );
      ctx.config.ble.mqtt_proxy = undefined;
      ctx.config.ble.esphome_proxy = undefined;
      console.log(
        `\n  ${info('Home Assistant Bluetooth configured. Broadcast scales only (no GATT).')}`,
      );
    } else {
      ctx.config.ble.mqtt_proxy = undefined;
      ctx.config.ble.esphome_proxy = undefined;
      ctx.config.ble.ha_bluetooth = undefined;
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
          // Third and last place that builds its own bus. Short-lived, but the
          // patch is applied here too so no bus in this codebase can ever run on
          // dbus-next's broken match-rule refcounting (#396).
          const { applyDbusMatchRefcountPatch } =
            await import('../../ble/handler-node-ble/dbus-match-patch.js');
          applyDbusMatchRefcountPatch();
          const { bluetooth, destroy } = NodeBle.default.createBluetooth();
          // An async D-Bus socket error is emitted on the MessageBus, not thrown
          // from the await, so the surrounding try/catch would not see it and the
          // process would die with an uncaught exception (#290).
          const { attachBusErrorHandler } =
            await import('../../ble/handler-node-ble/connection.js');
          attachBusErrorHandler(bluetooth, () => {
            /* enumeration falls through to manual entry */
          });
          try {
            availableAdapters = await bluetooth.adapters();
          } finally {
            destroy();
          }
        } catch {
          // D-Bus not available, or node-ble itself was skipped by an optional
          // install (#364). Both fall through to manual entry, but a missing
          // package is worth naming: otherwise the picker just reports that it
          // found no adapters.
          const missing = missingPackagesFor('node-ble');
          if (missing.length > 0) {
            console.log(
              `\n  ${warn(
                `Adapter list unavailable: ${missing.join(', ')} is not installed ` +
                  `(npm install ${missing.join(' ')}).`,
              )}`,
            );
          }
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
      // A configured scale is offered first, so picking this section again to
      // change the proxy does not mean scanning for the scale again.
      const currentMac = ctx.config.ble.scale_mac ?? undefined;
      const choice = await ctx.prompts.select('How do you want to identify your scale?', [
        ...(currentMac ? [{ name: `Keep the current scale (${currentMac})`, value: 'keep' }] : []),
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

      if (choice === 'keep') return;

      if (choice === 'skip') {
        ctx.config.ble.scale_mac = undefined;
        console.log('\n  Scale MAC skipped — auto-discovery will be used.');
        return;
      }

      if (choice === 'manual') {
        const mac = await ctx.prompts.input(
          'Enter scale MAC address (XX:XX:XX:XX:XX:XX, or empty to go back):',
          {
            default: currentMac,
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

        // The config keeps ${VAR} references (it is written back as typed, and
        // the token prompt suggests ${HA_TOKEN}); the scan needs the values.
        // An undefined variable throws here and is reported as a failed scan.
        const ble = resolveEnvReferences(ctx.config.ble!);
        let mqttProxy = ble.mqtt_proxy;
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
            ble.adapter ?? undefined,
            ble.esphome_proxy,
            ble.ha_bluetooth,
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
  validateHaUrl,
  promptMqttProxy,
  promptEsphomeProxy,
  promptHaBluetooth,
};
