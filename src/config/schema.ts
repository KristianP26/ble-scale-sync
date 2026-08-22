import { z } from 'zod';
import { isLoopback } from '../ble/loopback.js';
import { isValidScaleId, SCALE_ID_HINT } from '../ble/scale-id.js';

// --- Sub-schemas ---

export const EsphomeEndpointSchema = z
  .object({
    host: z.string().min(1, 'ESPHome host is required'),
    port: z.number().int().min(1).max(65535).default(6053),
    encryption_key: z.string().optional().nullable(),
    password: z.string().optional().nullable(),
    client_info: z.string().default('ble-scale-sync'),
  })
  .refine((c) => !(c.encryption_key && c.password), {
    message: 'Set either encryption_key (Noise) or password (legacy), not both',
    path: ['encryption_key'],
  });

export const EsphomeProxySchema = z
  .object({
    host: z.string().min(1, 'ESPHome host is required'),
    port: z.number().int().min(1).max(65535).default(6053),
    encryption_key: z.string().optional().nullable(),
    password: z.string().optional().nullable(),
    client_info: z.string().default('ble-scale-sync'),
    // Additional ESPHome proxies for a mesh setup. Optional; an empty list
    // (the default) preserves the original single-proxy behavior. GATT
    // connects route to the proxy that last saw the scale (#116).
    additional_proxies: z.array(EsphomeEndpointSchema).default([]),
    /**
     * Seconds without a single BLE advertisement from a proxy before its client
     * is torn down and rebuilt. 0 (the default) disables the watchdog entirely.
     *
     * Off by default on purpose. A home proxy normally sees some BLE traffic
     * constantly, so a long silence means the transport died (#303: a single
     * ECONNRESET produced 4h35m of nothing while the proxy itself stayed
     * healthy). But a rebuild is a real teardown, and there is a documented
     * setup where it would fire forever without helping: a proxy already
     * adopted by Home Assistant only serves one advertisement subscription, so
     * the rebuild succeeds and advertisements still never arrive. Opt in with
     * 180 to 600 once you have seen the silence in your own log.
     */
    advertisement_timeout: z.number().int().min(0).max(86400).default(0),
  })
  .refine((c) => !(c.encryption_key && c.password), {
    message: 'Set either encryption_key (Noise) or password (legacy), not both',
    path: ['encryption_key'],
  });

export type EsphomeEndpointConfig = z.infer<typeof EsphomeEndpointSchema>;

export const MqttProxySchema = z
  .object({
    broker_url: z
      .string()
      .min(1, 'MQTT broker URL must not be empty')
      .refine((v) => /^mqtts?:\/\//.test(v), {
        message: 'Must start with mqtt:// or mqtts://',
      })
      .optional()
      .nullable(),
    device_id: z.string().default('esp32-ble-proxy'),
    username: z.string().optional().nullable(),
    password: z.string().optional().nullable(),
    topic_prefix: z.string().default('ble-proxy'),
    embedded_broker_port: z.number().int().min(1).max(65535).default(1883),
    embedded_broker_bind: z
      .string()
      .regex(/^\S+$/, 'Must be a non-empty hostname or IP with no whitespace')
      .default('0.0.0.0'),
    auto_connect: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), the ESP32 autonomously connects to known scale MACs ' +
          'the instant they appear in a scan, eliminating the MQTT round-trip latency. ' +
          'Set to false to use the legacy host-initiated connect flow.',
      ),
  })
  .refine(
    (c) => {
      if (c.broker_url) return true;
      if (isLoopback(c.embedded_broker_bind)) return true;
      return !!c.username;
    },
    {
      message:
        'Embedded broker bound to a non-loopback interface must have username/password set. ' +
        'Either add mqtt_proxy.username + mqtt_proxy.password, or change embedded_broker_bind ' +
        'to 127.0.0.1.',
      path: ['username'],
    },
  );

export const BleSchema = z
  .object({
    scale_mac: z
      .string()
      .refine((v) => isValidScaleId(v), {
        message: `Must be ${SCALE_ID_HINT}`,
      })
      .optional()
      .nullable(),
    bind_key: z
      .string()
      .regex(/^[0-9a-fA-F]{32}$/, 'Must be a 32-character hex bind key (16 bytes)')
      .optional()
      .nullable(),
    noble_driver: z.enum(['abandonware', 'stoprocent']).optional().nullable(),
    handler: z.enum(['auto', 'mqtt-proxy', 'esphome-proxy']).default('auto'),
    adapter: z
      .string()
      .regex(/^hci\d+$/, 'Must be a Linux HCI adapter name (e.g., hci0, hci1)')
      .optional()
      .nullable(),
    /**
     * Override protocol auto-detection with a named scale adapter (#318/#319).
     * Note the distinction from `adapter` above, which selects the host's
     * Bluetooth controller: this one selects the scale protocol.
     */
    force_scale_adapter: z.string().min(1).optional().nullable(),
    /**
     * How long one GATT session may wait for a complete reading, in seconds
     * (default 120). Some scales refuse to run a standalone weigh-in while a
     * host holds the session open (the Beurer BF500 shows "APP", #83), so a
     * shorter session frees the scale sooner. The cost is proportionally more
     * Bluetooth adapter resets per hour, since every failed read triggers one.
     */
    session_timeout_sec: z.number().int().min(5).max(600).optional().nullable(),
    /**
     * Protocol byte the QN handshake echoes back to the scale (#75, #331).
     *
     * The QN family disagrees about which value its firmware accepts, and the
     * wrong one is silent rather than an error: the scale acknowledges the whole
     * handshake and never streams a weight. The scale-info frame length picks a
     * default (0 for the 18-byte variant, the value the scale itself sent for
     * anything longer); set this when a scale runs the full handshake and then
     * reports nothing, or when its scale-info frame is unreliable in transit
     * (proxy transports) and sessions without it open on the wrong byte.
     */
    qn_protocol_byte: z.number().int().min(0).max(255).optional().nullable(),
    mqtt_proxy: MqttProxySchema.optional(),
    esphome_proxy: EsphomeProxySchema.optional(),
  })
  .refine((ble) => ble.handler !== 'mqtt-proxy' || ble.mqtt_proxy !== undefined, {
    message: 'mqtt_proxy config is required when handler is "mqtt-proxy"',
    path: ['mqtt_proxy'],
  })
  .refine((ble) => ble.handler !== 'esphome-proxy' || ble.esphome_proxy !== undefined, {
    message: 'esphome_proxy config is required when handler is "esphome-proxy"',
    path: ['esphome_proxy'],
  });
// NOTE: force_scale_adapter also requires a scale_mac, but that pairing is NOT
// checked here. Schema validation runs before applyEnvOverrides (yaml-load.ts),
// so a config.yaml that names a forced adapter and takes its MAC from the
// documented SCALE_MAC Docker override would be rejected while being perfectly
// valid. The check lives in src/index.ts, after the effective MAC is known.

export const ScaleSchema = z.object({
  weight_unit: z.enum(['kg', 'lbs']).default('kg'),
  height_unit: z.enum(['cm', 'in']).default('cm'),
});

export const ExporterEntrySchema = z
  .object({
    type: z.string().min(1, 'Exporter type is required'),
  })
  .passthrough();

const WeightRangeSchema = z
  .object({
    min: z.number().positive('Must be a positive number'),
    max: z.number().positive('Must be a positive number'),
  })
  .refine((range) => range.max > range.min, {
    message: 'max must be greater than min',
  });

export const UserSchema = z.object({
  name: z.string().min(1, 'User name is required'),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  height: z.number().positive('Must be a positive number (e.g., 183)'),
  birth_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format (e.g., "1990-06-15")'),
  gender: z.enum(['male', 'female']),
  is_athlete: z.boolean(),
  weight_range: WeightRangeSchema,
  last_known_weight: z.number().nullable().default(null),
  exporters: z.array(ExporterEntrySchema).optional(),
  // Beurer SIG-standard scales (BF720 / BF105) gate measurements behind a
  // User Control Point consent code. Obtain it once by pairing the scale with
  // the Beurer / openScale app (or read it off the scale's control unit), then
  // put it here. z.coerce so a `${ENV}` reference (resolved to a string before
  // schema parse) still validates.
  beurer_pin: z.coerce.number().int().min(0).max(9999).optional(),
  beurer_user_index: z.coerce.number().int().min(0).max(255).optional(),
  /**
   * Write this user's profile (date of birth, gender, height, activity level)
   * into the scale when it has nothing stored. Removing the batteries wipes
   * every slot on a Beurer BF7xx/BF9xx (#229), and the vendor app is otherwise
   * the only way to recreate one. Opt in: the field heuristics are validated
   * against a single captured device.
   */
  beurer_provision: z.boolean().optional(),
});

export const RuntimeSchema = z.object({
  continuous_mode: z.boolean().default(false),
  scan_cooldown: z.number().int().min(5).max(3600).default(30),
  dry_run: z.boolean().default(false),
  debug: z.boolean().default(false),
  /**
   * Continuous-mode watchdog: exit the process after this many consecutive scan
   * failures (after at least one successful scan). Docker `restart: unless-stopped`
   * then performs a clean BlueZ recovery. Set to 0 to disable.
   */
  watchdog_max_consecutive_failures: z.number().int().min(0).max(1000).default(10),
  /**
   * Auto-reload config.yaml on edit (continuous mode only). When false, only
   * SIGHUP triggers a reload. Useful on flaky filesystems or when restart-based
   * deploys are preferred. Default true.
   */
  watch_config: z.boolean().default(true),
});

export const DockerSchema = z.object({
  mode: z.enum(['pull', 'build']).default('pull'),
});

export const AppConfigSchema = z.object({
  version: z.literal(1),
  ble: BleSchema.optional(),
  scale: ScaleSchema.default({ weight_unit: 'kg', height_unit: 'cm' }),
  unknown_user: z.enum(['nearest', 'log', 'ignore']).default('nearest'),
  users: z.array(UserSchema).min(1, 'At least one user is required'),
  global_exporters: z.array(ExporterEntrySchema).optional(),
  runtime: RuntimeSchema.optional(),
  docker: DockerSchema.optional(),
  update_check: z.boolean().default(true),
});

// --- Standalone types ---

export type WeightUnit = 'kg' | 'lbs';

// --- Inferred types ---

export type MqttProxyConfig = z.infer<typeof MqttProxySchema>;
export type EsphomeProxyConfig = z.infer<typeof EsphomeProxySchema>;
export type BleConfig = z.infer<typeof BleSchema>;
export type ScaleConfig = z.infer<typeof ScaleSchema>;
export type ExporterEntry = z.infer<typeof ExporterEntrySchema>;
export type UserConfig = z.infer<typeof UserSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeSchema>;
export type DockerConfig = z.infer<typeof DockerSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type UnknownUserStrategy = AppConfig['unknown_user'];

// --- Error formatting ---

export function formatConfigError(error: z.ZodError): string {
  const lines = ['Configuration error in config.yaml:', ''];

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    lines.push(`  ${path}`);
    lines.push(`    ${issue.message}`);
    lines.push('');
  }

  lines.push("Run 'npm run validate' to check your config, or 'npm run setup' to reconfigure.");

  return lines.join('\n');
}
