import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveDisplayUnit,
  resolveUserProfile,
  resolveRuntimeConfig,
  resolveExportersForUser,
  resolveExporterSlotsForUser,
  resolveForSingleUser,
  resolveScaleAuth,
  buildAdapterRuntimeConfig,
} from '../../src/config/resolve.js';
import { ADAPTER_BLE_OPTIONS, BleSchema } from '../../src/config/schema.js';
import { QN_BLE_OPTIONS } from '../../src/scales/qn-scale/options.js';
import { RMSC04_BLE_OPTIONS } from '../../src/scales/renpho-msc04-options.js';
import type { AppConfig, UserConfig, ScaleConfig } from '../../src/config/schema.js';

// --- Test data ---

const USER: UserConfig = {
  name: 'Test',
  slug: 'test',
  height: 183,
  birth_date: '1990-06-15',
  gender: 'male',
  is_athlete: true,
  weight_range: { min: 70, max: 100 },
  last_known_weight: null,
};

const SCALE_CM: ScaleConfig = { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' };
const SCALE_IN: ScaleConfig = {
  weight_unit: 'lbs',
  height_unit: 'in',
  display_unit: 'weight_unit',
};

const BASE_CONFIG: AppConfig = {
  version: 1,
  scale: SCALE_CM,
  unknown_user: 'nearest',
  out_of_range: 'warn',
  update_check: true,
  users: [USER],
  global_exporters: [{ type: 'garmin' }, { type: 'mqtt', broker_url: 'mqtt://host' }],
  runtime: {
    continuous_mode: true,
    scan_cooldown: 60,
    dry_run: false,
    debug: false,
    watchdog_max_consecutive_failures: 10,
    watch_config: true,
    idle_rescan_delay: 5,
    no_reading_rescan_delay: 0,
    retry_failed_exports: true,
  },
  ble: {
    handler: 'auto',
    scale_mac: 'FF:03:00:13:A1:04',
  },
};

// --- resolveUserProfile ---

describe('resolveDisplayUnit (#429)', () => {
  const scale = (over: Partial<ScaleConfig>): ScaleConfig =>
    ({ weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit', ...over }) as ScaleConfig;

  // #269: before display_unit existed, a QN scale followed weight_unit. The
  // default has to keep an lb user's scale on lb.
  it('follows weight_unit by default', () => {
    expect(resolveDisplayUnit(scale({ weight_unit: 'lbs' }))).toBe('lbs');
    expect(resolveDisplayUnit(scale({ weight_unit: 'kg' }))).toBe('kg');
  });

  it('uses an explicit display_unit regardless of weight_unit', () => {
    expect(resolveDisplayUnit(scale({ weight_unit: 'kg', display_unit: 'st' }))).toBe('st');
    expect(resolveDisplayUnit(scale({ weight_unit: 'lbs', display_unit: 'kg' }))).toBe('kg');
  });
});

describe('resolveUserProfile', () => {
  it('computes age from birth_date', () => {
    const profile = resolveUserProfile(USER, SCALE_CM);
    const today = new Date();
    const expectedAge =
      today.getFullYear() - 1990 - (today < new Date(today.getFullYear(), 5, 15) ? 1 : 0);
    expect(profile.age).toBe(expectedAge);
  });

  // #75: the QN extended dialect sends this to the scale before the weigh-in
  // and refuses to complete when it is far from the real weight, so every
  // configured user needs one without adding a setting.
  it('uses last_known_weight as the weight anchor when config has one', () => {
    const profile = resolveUserProfile({ ...USER, last_known_weight: 82.4 }, SCALE_CM);
    expect(profile.lastKnownWeight).toBe(82.4);
  });

  it('falls back to the midpoint of weight_range before the first reading', () => {
    const profile = resolveUserProfile(USER, SCALE_CM);
    expect(profile.lastKnownWeight).toBe(85);
  });

  // The env-var config path has no range to ask for and writes this sentinel,
  // whose midpoint is 499.5 kg. Anything is better than handing a scale that.
  it('yields no anchor for the env-var sentinel weight range', () => {
    const profile = resolveUserProfile({ ...USER, weight_range: { min: 0, max: 999 } }, SCALE_CM);
    expect(profile.lastKnownWeight).toBeUndefined();
  });

  it('preserves height in cm when height_unit is cm', () => {
    const profile = resolveUserProfile(USER, SCALE_CM);
    expect(profile.height).toBe(183);
  });

  it('converts height from inches to cm when height_unit is in', () => {
    const userInches = { ...USER, height: 72 };
    const profile = resolveUserProfile(userInches, SCALE_IN);
    expect(profile.height).toBeCloseTo(72 * 2.54, 2);
  });

  it('maps gender correctly', () => {
    const profile = resolveUserProfile(USER, SCALE_CM);
    expect(profile.gender).toBe('male');
  });

  it('maps isAthlete correctly', () => {
    const profile = resolveUserProfile(USER, SCALE_CM);
    expect(profile.isAthlete).toBe(true);
  });

  it('handles female non-athlete', () => {
    const femaleUser = { ...USER, gender: 'female' as const, is_athlete: false };
    const profile = resolveUserProfile(femaleUser, SCALE_CM);
    expect(profile.gender).toBe('female');
    expect(profile.isAthlete).toBe(false);
  });

  // #497: only an explicit false reaches the profile, so every profile of a
  // config without the key is exactly what it was.
  it('carries estimate_body_composition: false into the profile', () => {
    const off = resolveUserProfile({ ...USER, estimate_body_composition: false }, SCALE_CM);
    expect(off.estimateBodyComposition).toBe(false);
  });

  it('adds nothing for estimate_body_composition true or absent', () => {
    for (const user of [USER, { ...USER, estimate_body_composition: true }]) {
      expect(resolveUserProfile(user, SCALE_CM)).not.toHaveProperty('estimateBodyComposition');
    }
  });

  it('computes correct age for birthday not yet passed this year', () => {
    const today = new Date();
    // Set birth_date to Dec 31 of last year's age computation
    const futureBirthday = `${today.getFullYear() - 30}-12-31`;
    const user = { ...USER, birth_date: futureBirthday };
    const profile = resolveUserProfile(user, SCALE_CM);
    // If Dec 31 hasn't happened yet this year, age should be 29
    if (today.getMonth() < 11 || (today.getMonth() === 11 && today.getDate() < 31)) {
      expect(profile.age).toBe(29);
    } else {
      expect(profile.age).toBe(30);
    }
  });
});

// --- resolveRuntimeConfig ---

describe('resolveRuntimeConfig', () => {
  it('extracts profile from first user', () => {
    const result = resolveRuntimeConfig(BASE_CONFIG);
    expect(result.profile.height).toBe(183);
    expect(result.profile.gender).toBe('male');
  });

  it('extracts scaleMac from ble config', () => {
    const result = resolveRuntimeConfig(BASE_CONFIG);
    expect(result.scaleMac).toBe('FF:03:00:13:A1:04');
  });

  it('returns undefined scaleMac when not configured', () => {
    const config = { ...BASE_CONFIG, ble: undefined };
    const result = resolveRuntimeConfig(config);
    expect(result.scaleMac).toBeUndefined();
  });

  it('extracts weight unit', () => {
    const result = resolveRuntimeConfig(BASE_CONFIG);
    expect(result.weightUnit).toBe('kg');
  });

  it('extracts runtime flags', () => {
    const result = resolveRuntimeConfig(BASE_CONFIG);
    expect(result.continuousMode).toBe(true);
    expect(result.scanCooldownSec).toBe(60);
    expect(result.dryRun).toBe(false);
  });

  it('defaults runtime flags when runtime is undefined', () => {
    const config = { ...BASE_CONFIG, runtime: undefined };
    const result = resolveRuntimeConfig(config);
    expect(result.continuousMode).toBe(false);
    expect(result.scanCooldownSec).toBe(30);
    expect(result.dryRun).toBe(false);
  });

  it('defaults bleHandler to auto when ble is undefined', () => {
    const config = { ...BASE_CONFIG, ble: undefined };
    const result = resolveRuntimeConfig(config);
    expect(result.bleHandler).toBe('auto');
    expect(result.mqttProxy).toBeUndefined();
  });

  it('extracts bleHandler and mqttProxy from ble config', () => {
    const config = {
      ...BASE_CONFIG,
      ble: {
        handler: 'mqtt-proxy' as const,
        scale_mac: 'FF:03:00:13:A1:04',
        mqtt_proxy: {
          broker_url: 'mqtt://localhost:1883',
          device_id: 'esp32-test',
          topic_prefix: 'ble-proxy',
          embedded_broker_port: 1883,
          embedded_broker_bind: '0.0.0.0',
          auto_connect: true,
        },
      },
    };
    const result = resolveRuntimeConfig(config);
    expect(result.bleHandler).toBe('mqtt-proxy');
    expect(result.mqttProxy).toEqual({
      broker_url: 'mqtt://localhost:1883',
      device_id: 'esp32-test',
      topic_prefix: 'ble-proxy',
      embedded_broker_port: 1883,
      embedded_broker_bind: '0.0.0.0',
      auto_connect: true,
    });
  });

  it('extracts bleAdapter from ble config', () => {
    const config = {
      ...BASE_CONFIG,
      ble: { ...BASE_CONFIG.ble!, adapter: 'hci1' },
    };
    const result = resolveRuntimeConfig(config);
    expect(result.bleAdapter).toBe('hci1');
  });

  it('returns undefined bleAdapter when not configured', () => {
    const result = resolveRuntimeConfig(BASE_CONFIG);
    expect(result.bleAdapter).toBeUndefined();
  });

  it('returns undefined bleAdapter when ble is undefined', () => {
    const config = { ...BASE_CONFIG, ble: undefined };
    const result = resolveRuntimeConfig(config);
    expect(result.bleAdapter).toBeUndefined();
  });
});

// --- resolveExportersForUser ---

describe('resolveExportersForUser', () => {
  it('returns global exporters when user has none', () => {
    const entries = resolveExportersForUser(BASE_CONFIG, USER);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('garmin');
    expect(entries[1].type).toBe('mqtt');
  });

  it('returns user exporters first, then global', () => {
    const userWithExporters = {
      ...USER,
      exporters: [{ type: 'webhook', url: 'http://test' }],
    };
    const entries = resolveExportersForUser(BASE_CONFIG, userWithExporters);
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe('webhook');
    expect(entries[1].type).toBe('garmin');
    expect(entries[2].type).toBe('mqtt');
  });

  it('deduplicates by type (user overrides global)', () => {
    const userWithGarmin = {
      ...USER,
      exporters: [{ type: 'garmin', email: 'user@example.com' }],
    };
    const entries = resolveExportersForUser(BASE_CONFIG, userWithGarmin);
    expect(entries).toHaveLength(2);
    // User's garmin overrides global garmin
    expect(entries[0].type).toBe('garmin');
    expect((entries[0] as Record<string, unknown>).email).toBe('user@example.com');
    expect(entries[1].type).toBe('mqtt');
  });

  // D029 (G-14): several entries of one type in one list are all exported to.
  // The second global webhook used to be dropped without a word.
  it('keeps every global entry of a type, not only the first', () => {
    const config = {
      ...BASE_CONFIG,
      global_exporters: [
        { type: 'webhook', url: 'http://a' },
        { type: 'webhook', url: 'http://b' },
      ],
    } as AppConfig;
    const entries = resolveExportersForUser(config, USER);
    expect(entries.map((e) => (e as Record<string, unknown>).url)).toEqual([
      'http://a',
      'http://b',
    ]);
  });

  it("drops every global entry of a type the user configured, keeps the user's duplicates", () => {
    const config = {
      ...BASE_CONFIG,
      global_exporters: [
        { type: 'webhook', url: 'http://global' },
        { type: 'mqtt', broker_url: 'mqtt://x' },
      ],
    } as AppConfig;
    const u = {
      ...USER,
      exporters: [
        { type: 'webhook', url: 'http://mine-1' },
        { type: 'webhook', url: 'http://mine-2' },
      ],
    } as UserConfig;
    const slots = resolveExporterSlotsForUser(config, u);
    expect(slots.map((s) => [s.list, s.index, s.entry.type])).toEqual([
      ['user', 0, 'webhook'],
      ['user', 1, 'webhook'],
      ['global', 1, 'mqtt'],
    ]);
  });

  it('returns empty array when no exporters configured', () => {
    const config = { ...BASE_CONFIG, global_exporters: undefined };
    const entries = resolveExportersForUser(config, USER);
    expect(entries).toHaveLength(0);
  });
});

// --- resolveForSingleUser ---

describe('resolveForSingleUser', () => {
  it('combines runtime config with exporter entries', () => {
    const result = resolveForSingleUser(BASE_CONFIG);
    expect(result.profile).toBeDefined();
    expect(result.profile.height).toBe(183);
    expect(result.exporterEntries).toHaveLength(2);
    expect(result.continuousMode).toBe(true);
    expect(result.scaleMac).toBe('FF:03:00:13:A1:04');
  });

  it('uses first user from config', () => {
    const multiUserConfig: AppConfig = {
      ...BASE_CONFIG,
      users: [USER, { ...USER, name: 'Second', slug: 'second', height: 170 }],
    };
    const result = resolveForSingleUser(multiUserConfig);
    expect(result.profile.height).toBe(183); // first user
  });

  it('resolves exporter entries for the first user', () => {
    const userWithExporters = {
      ...USER,
      exporters: [{ type: 'ntfy', topic: 'test' }],
    };
    const config = { ...BASE_CONFIG, users: [userWithExporters] };
    const result = resolveForSingleUser(config);
    expect(result.exporterEntries).toHaveLength(3); // ntfy + garmin + mqtt
    expect(result.exporterEntries[0].type).toBe('ntfy');
  });
});

describe('resolveScaleAuth', () => {
  it('maps the beurer_* keys of the user', () => {
    const user: UserConfig = {
      ...USER,
      beurer_pin: 1234,
      beurer_user_index: 2,
      beurer_provision: true,
      beurer_register_new_user: false,
    };
    expect(resolveScaleAuth(user)).toStrictEqual({
      pin: 1234,
      userIndex: 2,
      provision: true,
      registerNewUser: false,
    });
  });

  it('yields an all-unset auth for no user', () => {
    expect(resolveScaleAuth(undefined)).toStrictEqual({
      pin: undefined,
      userIndex: undefined,
      provision: undefined,
      registerNewUser: undefined,
    });
  });
});

describe('buildAdapterRuntimeConfig (X-06)', () => {
  const UNSET_OPTIONS = {
    qnProtocolByte: undefined,
    qnReportByte: undefined,
    qnWeightAck: undefined,
    qnUserKey: undefined,
    qnUserSlot: undefined,
    qnA4Prelude: undefined,
    qnTimeSyncLong: undefined,
    qnConfigLong: undefined,
    qnResultAck: undefined,
    rmsc04ProfileByte: undefined,
  };

  const cases: Array<{
    name: string;
    config: AppConfig;
    scaleMac: string | undefined;
    expected: Record<string, unknown>;
  }> = [
    {
      name: 'no ble block',
      config: { ...BASE_CONFIG, ble: undefined },
      scaleMac: undefined,
      expected: { bindKey: undefined, scaleMac: undefined, displayUnit: 'kg', ...UNSET_OPTIONS },
    },
    {
      name: 'null ble keys read as unset',
      config: {
        ...BASE_CONFIG,
        ble: {
          handler: 'auto',
          bind_key: null,
          qn_protocol_byte: null,
          qn_report_byte: null,
          qn_weight_ack: null,
          qn_user_key: null,
          qn_user_slot: null,
          qn_a4_prelude: null,
          qn_time_sync_long: null,
          qn_config_long: null,
          qn_result_ack: null,
          rmsc04_profile_byte: null,
        },
      },
      scaleMac: 'FF:03:00:13:A1:04',
      expected: {
        bindKey: undefined,
        scaleMac: 'FF:03:00:13:A1:04',
        displayUnit: 'kg',
        ...UNSET_OPTIONS,
      },
    },
    {
      name: 'every key set, explicit display unit',
      config: {
        ...BASE_CONFIG,
        scale: { ...SCALE_CM, display_unit: 'st' },
        ble: {
          handler: 'auto',
          bind_key: '00112233445566778899aabbccddeeff',
          qn_protocol_byte: 0x02,
          qn_report_byte: 0x01,
          qn_weight_ack: true,
          qn_user_key: 4321,
          qn_user_slot: 3,
          qn_a4_prelude: false,
          qn_time_sync_long: true,
          qn_config_long: false,
          qn_result_ack: true,
          rmsc04_profile_byte: '9e',
        },
      },
      scaleMac: 'AA:BB:CC:DD:EE:FF',
      expected: {
        bindKey: '00112233445566778899aabbccddeeff',
        scaleMac: 'AA:BB:CC:DD:EE:FF',
        displayUnit: 'st',
        qnProtocolByte: 0x02,
        qnReportByte: 0x01,
        qnWeightAck: true,
        qnUserKey: 4321,
        qnUserSlot: 3,
        qnA4Prelude: false,
        qnTimeSyncLong: true,
        qnConfigLong: false,
        qnResultAck: true,
        rmsc04ProfileByte: '9e',
      },
    },
    {
      name: 'display unit follows weight_unit by default',
      config: { ...BASE_CONFIG, scale: SCALE_IN },
      scaleMac: undefined,
      expected: { bindKey: undefined, scaleMac: undefined, displayUnit: 'lbs', ...UNSET_OPTIONS },
    },
  ];

  it.each(cases)('$name', ({ config, scaleMac, expected }) => {
    const out = buildAdapterRuntimeConfig(config, scaleMac);
    expect(out).toStrictEqual({
      ...expected,
      userWeights: config.users,
      profileForWeight: expect.any(Function),
    });
    // The live entries, not copies: the processor moves last_known_weight on them.
    expect(out.userWeights).toBe(config.users);
  });

  // An adapter-owned key added to the schema outside its fragment, or a fragment
  // left out of ADAPTER_BLE_OPTIONS, would be accepted by validation and then
  // silently ignored by every adapter.
  it('wires every adapter-owned ble.* key through', () => {
    const shape = BleSchema.shape as Record<
      string,
      { safeParse(v: unknown): { success: boolean } }
    >;
    expect(Object.keys(ADAPTER_BLE_OPTIONS)).toEqual([
      ...Object.keys(QN_BLE_OPTIONS),
      ...Object.keys(RMSC04_BLE_OPTIONS),
    ]);
    // Every key with an adapter's prefix comes from a fragment, nothing else.
    expect(Object.keys(shape).filter((k) => /^(qn|rmsc04)_/.test(k))).toEqual(
      Object.keys(ADAPTER_BLE_OPTIONS),
    );
    for (const key of Object.keys(ADAPTER_BLE_OPTIONS)) {
      expect(shape[key], `${key} is not in BleSchema`).toBeDefined();
      const value = [true, 7, '9e'].find((v) => shape[key].safeParse(v).success);
      expect(value, `no test value for ${key}`).toBeDefined();
      const config = { ...BASE_CONFIG, ble: { handler: 'auto', [key]: value } } as AppConfig;
      const field = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      const out = buildAdapterRuntimeConfig(config, undefined) as Record<string, unknown>;
      expect(out[field], `${key} -> ${field}`).toBe(value);
    }
  });

  describe('profileForWeight', () => {
    afterEach(() => vi.restoreAllMocks());

    const ALICE: UserConfig = {
      ...USER,
      name: 'Alice',
      slug: 'alice',
      height: 165,
      birth_date: '1980-02-01',
      gender: 'female',
      is_athlete: false,
      weight_range: { min: 50, max: 70 },
    };
    const BOB: UserConfig = {
      ...USER,
      name: 'Bob',
      slug: 'bob',
      weight_range: { min: 75, max: 100 },
    };
    const lookup = (users: UserConfig[], over: Partial<AppConfig> = {}) => {
      const fn = buildAdapterRuntimeConfig(
        { ...BASE_CONFIG, users, ...over },
        undefined,
      ).profileForWeight;
      expect(fn).toBeTypeOf('function');
      return fn!;
    };
    const silence = () => [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    ];

    it('gives a single user out of range their profile, without a log line', () => {
      const spies = silence();
      expect(lookup([USER])(150)).toEqual(resolveUserProfile(USER, SCALE_CM));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    it('picks the user whose range holds the weight', () => {
      const fn = lookup([ALICE, BOB]);
      expect(fn(60)).toEqual(resolveUserProfile(ALICE, SCALE_CM));
      expect(fn(80)).toEqual(resolveUserProfile(BOB, SCALE_CM));
    });

    it('breaks an overlap by last_known_weight, else by config order, silently', () => {
      const spies = silence();
      const wide = { ...BOB, weight_range: { min: 60, max: 100 } };
      expect(lookup([ALICE, wide])(65)).toEqual(resolveUserProfile(ALICE, SCALE_CM));
      const wideNear = { ...wide, last_known_weight: 66 };
      const aliceFar = { ...ALICE, last_known_weight: 52 };
      expect(lookup([aliceFar, wideNear])(65)).toEqual(resolveUserProfile(wideNear, SCALE_CM));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    it.each(['ignore', 'log'] as const)('returns undefined when %s matches nobody', (strategy) => {
      const spies = silence();
      expect(lookup([ALICE, BOB], { unknown_user: strategy })(72)).toBeUndefined();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });

    it('converts height_unit: in to cm', () => {
      const tall = { ...USER, height: 70 };
      const profile = lookup([tall], { scale: SCALE_IN })(80);
      expect(profile?.height).toBeCloseTo(177.8, 5);
    });

    it('sees a last_known_weight moved after the closure was built', () => {
      const alice = { ...ALICE, last_known_weight: 52 };
      const bob = { ...BOB, weight_range: { min: 60, max: 100 }, last_known_weight: 90 };
      const fn = lookup([alice, bob]);
      expect(fn(65)?.gender).toBe('female');
      bob.last_known_weight = 66;
      expect(fn(65)).toEqual(resolveUserProfile(bob, SCALE_CM));
    });
  });
});
