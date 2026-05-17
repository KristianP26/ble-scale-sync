import { describe, it, expect } from 'vitest';
import {
  AppConfigSchema,
  BleSchema,
  ScaleSchema,
  UserSchema,
  ExporterEntrySchema,
  RuntimeSchema,
  DockerSchema,
  formatConfigError,
} from '../../src/config/schema.js';
import { ZodError } from 'zod';

// --- Valid full config (matches Section 1 of the plan) ---

const VALID_USER = {
  name: 'Dad',
  slug: 'dad',
  height: 183,
  birth_date: '1990-06-15',
  gender: 'male' as const,
  is_athlete: true,
  weight_range: { min: 75, max: 95 },
  last_known_weight: null,
  exporters: [
    {
      type: 'garmin',
      email: 'dad@example.com',
      password: '${GARMIN_PASSWORD_DAD}',
      token_dir: './garmin-tokens/dad',
    },
  ],
};

const VALID_CONFIG = {
  version: 1 as const,
  ble: {
    scale_mac: 'FF:03:00:13:A1:04',
    noble_driver: null,
  },
  scale: {
    weight_unit: 'kg' as const,
    height_unit: 'cm' as const,
  },
  unknown_user: 'nearest' as const,
  users: [VALID_USER],
  global_exporters: [
    {
      type: 'mqtt',
      broker_url: 'mqtts://broker.hivemq.com:8883',
      topic: 'scale/body-composition',
    },
  ],
  runtime: {
    continuous_mode: false,
    scan_cooldown: 30,
    dry_run: false,
    debug: false,
  },
};

// ─── AppConfigSchema ───────────────────────────────────────────────────────

describe('AppConfigSchema', () => {
  it('validates a full valid config', () => {
    const result = AppConfigSchema.safeParse(VALID_CONFIG);
    expect(result.success).toBe(true);
  });

  it('validates minimal config (required fields only)', () => {
    const minimal = {
      version: 1,
      users: [
        {
          name: 'Me',
          slug: 'me',
          height: 170,
          birth_date: '1995-01-01',
          gender: 'female',
          is_athlete: false,
          weight_range: { min: 50, max: 80 },
        },
      ],
    };
    const result = AppConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scale.weight_unit).toBe('kg');
      expect(result.data.scale.height_unit).toBe('cm');
      expect(result.data.unknown_user).toBe('nearest');
      expect(result.data.users[0].last_known_weight).toBeNull();
    }
  });

  it('rejects missing version', () => {
    const { version: _, ...noVersion } = VALID_CONFIG;
    const result = AppConfigSchema.safeParse(noVersion);
    expect(result.success).toBe(false);
  });

  it('rejects wrong version', () => {
    const result = AppConfigSchema.safeParse({ ...VALID_CONFIG, version: 2 });
    expect(result.success).toBe(false);
  });

  it('rejects empty users array', () => {
    const result = AppConfigSchema.safeParse({ ...VALID_CONFIG, users: [] });
    expect(result.success).toBe(false);
  });

  it('rejects missing users', () => {
    const { users: _, ...noUsers } = VALID_CONFIG;
    const result = AppConfigSchema.safeParse(noUsers);
    expect(result.success).toBe(false);
  });

  it('accepts config with docker section', () => {
    const result = AppConfigSchema.safeParse({
      ...VALID_CONFIG,
      docker: { mode: 'build' },
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults for unknown_user', () => {
    const { unknown_user: _, ...noUnknown } = VALID_CONFIG;
    const result = AppConfigSchema.safeParse(noUnknown);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unknown_user).toBe('nearest');
    }
  });

  it('validates all three unknown_user strategies', () => {
    for (const strategy of ['nearest', 'log', 'ignore'] as const) {
      const result = AppConfigSchema.safeParse({ ...VALID_CONFIG, unknown_user: strategy });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid unknown_user', () => {
    const result = AppConfigSchema.safeParse({ ...VALID_CONFIG, unknown_user: 'skip' });
    expect(result.success).toBe(false);
  });
});

// ─── UserSchema ────────────────────────────────────────────────────────────

describe('UserSchema', () => {
  it('validates a complete user', () => {
    const result = UserSchema.safeParse(VALID_USER);
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, name: '' });
    expect(result.success).toBe(false);
  });

  it('accepts an optional beurer_pin and coerces a string (env ref) (#168)', () => {
    const numeric = UserSchema.safeParse({ ...VALID_USER, beurer_pin: 3752 });
    expect(numeric.success).toBe(true);
    const fromEnv = UserSchema.safeParse({ ...VALID_USER, beurer_pin: '3752' });
    expect(fromEnv.success && fromEnv.data.beurer_pin).toBe(3752);
  });

  it('leaves beurer_pin undefined when absent (no coerce to 0) (#168)', () => {
    const result = UserSchema.safeParse(VALID_USER);
    expect(result.success && result.data.beurer_pin).toBeUndefined();
  });

  it('rejects an out-of-range beurer_pin (#168)', () => {
    expect(UserSchema.safeParse({ ...VALID_USER, beurer_pin: 99999 }).success).toBe(false);
  });

  it('rejects invalid slug (uppercase)', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, slug: 'Dad' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid slug (spaces)', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, slug: 'my dad' });
    expect(result.success).toBe(false);
  });

  it('accepts valid slug with numbers and hyphens', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, slug: 'user-1' });
    expect(result.success).toBe(true);
  });

  it('rejects negative height', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, height: -5 });
    expect(result.success).toBe(false);
  });

  it('rejects zero height', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, height: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid birth_date format', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, birth_date: 'March 20' });
    expect(result.success).toBe(false);
  });

  it('rejects birth_date without leading zeros', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, birth_date: '1990-6-15' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid gender', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, gender: 'other' });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean is_athlete', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, is_athlete: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects weight_range where min >= max', () => {
    const result = UserSchema.safeParse({
      ...VALID_USER,
      weight_range: { min: 95, max: 75 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects weight_range where min === max', () => {
    const result = UserSchema.safeParse({
      ...VALID_USER,
      weight_range: { min: 80, max: 80 },
    });
    expect(result.success).toBe(false);
  });

  it('defaults last_known_weight to null', () => {
    const { last_known_weight: _, ...noLKW } = VALID_USER;
    const result = UserSchema.safeParse(noLKW);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.last_known_weight).toBeNull();
    }
  });

  it('accepts numeric last_known_weight', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, last_known_weight: 82.3 });
    expect(result.success).toBe(true);
  });

  it('allows missing exporters', () => {
    const { exporters: _, ...noExporters } = VALID_USER;
    const result = UserSchema.safeParse(noExporters);
    expect(result.success).toBe(true);
  });

  it('accepts height as decimal', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, height: 183.5 });
    expect(result.success).toBe(true);
  });
});

// ─── BleSchema ─────────────────────────────────────────────────────────────

describe('BleSchema', () => {
  it('accepts valid MAC address', () => {
    const result = BleSchema.safeParse({ scale_mac: 'FF:03:00:13:A1:04' });
    expect(result.success).toBe(true);
  });

  it('accepts CoreBluetooth UUID', () => {
    const result = BleSchema.safeParse({
      scale_mac: '12345678-1234-1234-1234-123456789ABC',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid MAC', () => {
    const result = BleSchema.safeParse({ scale_mac: 'not-a-mac' });
    expect(result.success).toBe(false);
  });

  it('accepts null scale_mac', () => {
    const result = BleSchema.safeParse({ scale_mac: null });
    expect(result.success).toBe(true);
  });

  it('accepts omitted scale_mac', () => {
    const result = BleSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts valid noble_driver values', () => {
    for (const driver of ['abandonware', 'stoprocent'] as const) {
      const result = BleSchema.safeParse({ noble_driver: driver });
      expect(result.success).toBe(true);
    }
  });

  it('accepts null noble_driver', () => {
    const result = BleSchema.safeParse({ noble_driver: null });
    expect(result.success).toBe(true);
  });

  it('rejects invalid noble_driver', () => {
    const result = BleSchema.safeParse({ noble_driver: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('defaults handler to auto', () => {
    const result = BleSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.handler).toBe('auto');
    }
  });

  it('accepts handler mqtt-proxy with mqtt_proxy config', () => {
    const result = BleSchema.safeParse({
      handler: 'mqtt-proxy',
      mqtt_proxy: {
        broker_url: 'mqtt://localhost:1883',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.handler).toBe('mqtt-proxy');
      expect(result.data.mqtt_proxy?.broker_url).toBe('mqtt://localhost:1883');
      expect(result.data.mqtt_proxy?.device_id).toBe('esp32-ble-proxy');
      expect(result.data.mqtt_proxy?.topic_prefix).toBe('ble-proxy');
    }
  });

  it('rejects handler mqtt-proxy without mqtt_proxy config', () => {
    const result = BleSchema.safeParse({ handler: 'mqtt-proxy' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('mqtt_proxy config is required');
    }
  });

  it('accepts handler mqtt-proxy with mqtt_proxy config omitting broker_url when bind is loopback', () => {
    const result = BleSchema.safeParse({
      handler: 'mqtt-proxy',
      mqtt_proxy: { embedded_broker_bind: '127.0.0.1' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mqtt_proxy?.broker_url).toBeUndefined();
      expect(result.data.mqtt_proxy?.embedded_broker_port).toBe(1883);
      expect(result.data.mqtt_proxy?.embedded_broker_bind).toBe('127.0.0.1');
    }
  });

  it('accepts embedded broker on non-loopback bind when username is set', () => {
    const result = BleSchema.safeParse({
      handler: 'mqtt-proxy',
      mqtt_proxy: { username: 'esp32', password: 'secret' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects embedded broker on non-loopback bind without auth', () => {
    const result = BleSchema.safeParse({
      handler: 'mqtt-proxy',
      mqtt_proxy: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('non-loopback');
    }
  });

  it('accepts custom embedded_broker_port and embedded_broker_bind', () => {
    const result = BleSchema.safeParse({
      handler: 'mqtt-proxy',
      mqtt_proxy: {
        embedded_broker_port: 1884,
        embedded_broker_bind: '127.0.0.1',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mqtt_proxy?.embedded_broker_port).toBe(1884);
      expect(result.data.mqtt_proxy?.embedded_broker_bind).toBe('127.0.0.1');
    }
  });

  it('rejects embedded_broker_port outside 1-65535', () => {
    const result = BleSchema.safeParse({
      handler: 'mqtt-proxy',
      mqtt_proxy: { embedded_broker_port: 70000 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects embedded_broker_bind with whitespace', () => {
    const result = BleSchema.safeParse({
      handler: 'mqtt-proxy',
      mqtt_proxy: { embedded_broker_bind: '0.0.0.0 injection' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty embedded_broker_bind', () => {
    const result = BleSchema.safeParse({
      handler: 'mqtt-proxy',
      mqtt_proxy: { embedded_broker_bind: '' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts handler esphome-proxy with esphome_proxy config', () => {
    const result = BleSchema.safeParse({
      handler: 'esphome-proxy',
      esphome_proxy: {
        host: 'ble-proxy.local',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.esphome_proxy?.host).toBe('ble-proxy.local');
      expect(result.data.esphome_proxy?.port).toBe(6053);
      expect(result.data.esphome_proxy?.client_info).toBe('ble-scale-sync');
    }
  });

  it('rejects handler esphome-proxy without esphome_proxy config', () => {
    const result = BleSchema.safeParse({ handler: 'esphome-proxy' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('esphome_proxy config is required');
    }
  });

  it('rejects esphome_proxy with empty host', () => {
    const result = BleSchema.safeParse({
      handler: 'esphome-proxy',
      esphome_proxy: { host: '' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts esphome_proxy with encryption_key and custom port', () => {
    const result = BleSchema.safeParse({
      handler: 'esphome-proxy',
      esphome_proxy: {
        host: '192.168.1.42',
        port: 6053,
        encryption_key: 'Lw1vKZ+BASE64KEYxxxxx==',
        client_info: 'pi-zero',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.esphome_proxy?.encryption_key).toBe('Lw1vKZ+BASE64KEYxxxxx==');
      expect(result.data.esphome_proxy?.client_info).toBe('pi-zero');
    }
  });

  it('rejects esphome_proxy with both encryption_key and password set', () => {
    const result = BleSchema.safeParse({
      handler: 'esphome-proxy',
      esphome_proxy: {
        host: 'ble-proxy.local',
        encryption_key: 'Lw1vKZ+BASE64KEYxxxxx==',
        password: 'legacy-plaintext',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('not both');
    }
  });

  it('accepts handler auto without mqtt_proxy', () => {
    const result = BleSchema.safeParse({ handler: 'auto' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid handler value', () => {
    const result = BleSchema.safeParse({ handler: 'noble' });
    expect(result.success).toBe(false);
  });

  it('accepts valid adapter name hci0', () => {
    const result = BleSchema.safeParse({ adapter: 'hci0' });
    expect(result.success).toBe(true);
  });

  it('accepts valid adapter name hci1', () => {
    const result = BleSchema.safeParse({ adapter: 'hci1' });
    expect(result.success).toBe(true);
  });

  it('accepts multi-digit adapter hci12', () => {
    const result = BleSchema.safeParse({ adapter: 'hci12' });
    expect(result.success).toBe(true);
  });

  it('accepts null adapter', () => {
    const result = BleSchema.safeParse({ adapter: null });
    expect(result.success).toBe(true);
  });

  it('accepts omitted adapter', () => {
    const result = BleSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.adapter).toBeUndefined();
    }
  });

  it('rejects invalid adapter name (eth0)', () => {
    const result = BleSchema.safeParse({ adapter: 'eth0' });
    expect(result.success).toBe(false);
  });

  it('rejects adapter without hci prefix', () => {
    const result = BleSchema.safeParse({ adapter: '1' });
    expect(result.success).toBe(false);
  });

  it('rejects adapter with uppercase HCI', () => {
    const result = BleSchema.safeParse({ adapter: 'HCI0' });
    expect(result.success).toBe(false);
  });
});

// ─── ScaleSchema ───────────────────────────────────────────────────────────

describe('ScaleSchema', () => {
  it('applies defaults when empty', () => {
    const result = ScaleSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.weight_unit).toBe('kg');
      expect(result.data.height_unit).toBe('cm');
    }
  });

  it('accepts lbs and in', () => {
    const result = ScaleSchema.safeParse({ weight_unit: 'lbs', height_unit: 'in' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid weight_unit', () => {
    const result = ScaleSchema.safeParse({ weight_unit: 'stones' });
    expect(result.success).toBe(false);
  });
});

// ─── ExporterEntrySchema ───────────────────────────────────────────────────

describe('ExporterEntrySchema', () => {
  it('validates entry with type and extra fields', () => {
    const result = ExporterEntrySchema.safeParse({
      type: 'mqtt',
      broker_url: 'mqtts://host:8883',
      topic: 'scale/data',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('mqtt');
      expect(result.data.broker_url).toBe('mqtts://host:8883');
    }
  });

  it('rejects missing type', () => {
    const result = ExporterEntrySchema.safeParse({ broker_url: 'mqtts://host:8883' });
    expect(result.success).toBe(false);
  });

  it('rejects empty type', () => {
    const result = ExporterEntrySchema.safeParse({ type: '' });
    expect(result.success).toBe(false);
  });

  it('accepts any string type (lenient — validated per-exporter later)', () => {
    const result = ExporterEntrySchema.safeParse({ type: 'custom-exporter' });
    expect(result.success).toBe(true);
  });
});

// ─── RuntimeSchema ─────────────────────────────────────────────────────────

describe('RuntimeSchema', () => {
  it('applies defaults when empty', () => {
    const result = RuntimeSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.continuous_mode).toBe(false);
      expect(result.data.scan_cooldown).toBe(30);
      expect(result.data.dry_run).toBe(false);
      expect(result.data.debug).toBe(false);
    }
  });

  it('rejects scan_cooldown below 5', () => {
    const result = RuntimeSchema.safeParse({ scan_cooldown: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects scan_cooldown above 3600', () => {
    const result = RuntimeSchema.safeParse({ scan_cooldown: 9999 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer scan_cooldown', () => {
    const result = RuntimeSchema.safeParse({ scan_cooldown: 30.5 });
    expect(result.success).toBe(false);
  });
});

// ─── DockerSchema ──────────────────────────────────────────────────────────

describe('DockerSchema', () => {
  it('defaults to pull', () => {
    const result = DockerSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('pull');
    }
  });

  it('accepts build mode', () => {
    const result = DockerSchema.safeParse({ mode: 'build' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid mode', () => {
    const result = DockerSchema.safeParse({ mode: 'compose' });
    expect(result.success).toBe(false);
  });
});

// ─── formatConfigError() ───────────────────────────────────────────────────

describe('formatConfigError()', () => {
  it('formats a single error with path', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, height: 'tall' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = formatConfigError(result.error);
      expect(msg).toContain('Configuration error in config.yaml:');
      expect(msg).toContain('height');
      expect(msg).toContain('npm run validate');
      expect(msg).toContain('npm run setup');
    }
  });

  it('formats multiple errors', () => {
    const result = UserSchema.safeParse({
      name: '',
      slug: 'INVALID SLUG',
      height: -1,
      birth_date: 'nope',
      gender: 'x',
      is_athlete: 'yes',
      weight_range: { min: -1, max: -2 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = formatConfigError(result.error);
      expect(msg).toContain('name');
      expect(msg).toContain('slug');
      expect(msg).toContain('height');
      expect(msg).toContain('birth_date');
    }
  });

  it('handles root-level errors', () => {
    const error = new ZodError([
      {
        code: 'invalid_type',
        expected: 'object',
        received: 'string',
        path: [],
        message: 'Expected object, received string',
      },
    ]);
    const msg = formatConfigError(error);
    expect(msg).toContain('(root)');
  });

  it('includes actionable hints', () => {
    const result = UserSchema.safeParse({ ...VALID_USER, height: 'tall' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = formatConfigError(result.error);
      expect(msg).toContain("Run 'npm run validate'");
      expect(msg).toContain("'npm run setup'");
    }
  });
});
