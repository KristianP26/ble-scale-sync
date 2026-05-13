import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AppConfig,
  UserConfig,
  WeightUnit,
  MqttProxyConfig,
} from '../../src/config/schema.js';
import type {
  BodyComposition,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
} from '../../src/interfaces/scale-adapter.js';
import type { RawReading } from '../../src/ble/shared.js';
import type { AppContext } from '../../src/runtime/context.js';
import type { Exporter } from '../../src/interfaces/exporter.js';

// Capture (and suppress) log output. console.log is the sink for logger.info().
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

vi.mock(import('../../src/orchestrator.js'), () => ({
  dispatchExports: vi.fn(),
  runHealthchecks: vi.fn(),
}));

vi.mock(import('../../src/ble/handler-mqtt-proxy/index.js'), async () => ({
  publishBeep: vi.fn(async () => undefined),
  publishDisplayReading: vi.fn(async () => undefined),
  publishDisplayResult: vi.fn(async () => undefined),
  // Re-exports kept as no-ops since processor only imports the three publish fns.
  scanAndReadRaw: vi.fn(),
  scanAndRead: vi.fn(),
  scanDevices: vi.fn(),
  publishConfig: vi.fn(),
  registerScaleMac: vi.fn(),
  ReadingWatcher: class {},
  AsyncQueue: class {},
  setDisplayUsers: vi.fn(),
  _resetProxyState: vi.fn(),
  _resetPersistentClient: vi.fn(),
  _resetDiscoveredMacs: vi.fn(),
}));

vi.mock(import('../../src/config/write.js'), async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    updateLastKnownWeight: vi.fn(),
  };
});

vi.mock(import('../../src/update-check.js'), () => ({
  checkAndLogUpdate: vi.fn(),
}));

const { processReading } = await import('../../src/runtime/processor.js');
const { dispatchExports } = await import('../../src/orchestrator.js');
const { publishBeep, publishDisplayReading, publishDisplayResult } =
  await import('../../src/ble/handler-mqtt-proxy/index.js');
const { updateLastKnownWeight } = await import('../../src/config/write.js');

// ─── Test fixtures ──────────────────────────────────────────────────────────

const FIXED_BODY_COMP: BodyComposition = {
  weight: 80,
  impedance: 500,
  bmi: 24,
  bodyFatPercent: 18,
  waterPercent: 60,
  boneMass: 3,
  muscleMass: 65,
  visceralFat: 5,
  physiqueRating: 6,
  bmr: 1800,
  metabolicAge: 30,
};

function fakeAdapter(payload: BodyComposition = FIXED_BODY_COMP): ScaleAdapter {
  return {
    name: 'FakeScale',
    charNotifyUuid: '0000aaa1-0000-1000-8000-00805f9b34fb',
    charWriteUuid: '0000aaa2-0000-1000-8000-00805f9b34fb',
    unlockCommand: [],
    unlockIntervalMs: 0,
    matches: () => true,
    parseNotification: () => null,
    isComplete: () => true,
    computeMetrics: vi.fn((_r: ScaleReading, _p: UserProfile): BodyComposition => payload),
  } as unknown as ScaleAdapter;
}

function rawReading(
  reading: ScaleReading = { weight: 80, impedance: 500 },
  payload: BodyComposition = FIXED_BODY_COMP,
): RawReading {
  return { reading, adapter: fakeAdapter(payload) };
}

const dad: UserConfig = {
  name: 'Dad',
  slug: 'dad',
  height: 183,
  birth_date: '1990-06-15',
  gender: 'male',
  is_athlete: false,
  weight_range: { min: 75, max: 95 },
  last_known_weight: 82,
};

const mom: UserConfig = {
  name: 'Mom',
  slug: 'mom',
  height: 165,
  birth_date: '1992-03-20',
  gender: 'female',
  is_athlete: false,
  weight_range: { min: 50, max: 70 },
  last_known_weight: 60,
};

function makeAppConfig(users: UserConfig[]): AppConfig {
  return {
    version: 1,
    scale: { weight_unit: 'kg', height_unit: 'cm' },
    unknown_user: 'nearest',
    users,
    update_check: false,
  };
}

interface CtxOverrides {
  bleHandler?: AppContext['bleHandler'];
  mqttProxy?: MqttProxyConfig;
  weightUnit?: WeightUnit;
  dryRun?: boolean;
  configSource?: AppContext['configSource'];
  configPath?: string;
}

function makeCtx(users: UserConfig[], overrides: CtxOverrides = {}): AppContext {
  return {
    config: makeAppConfig(users),
    scaleMac: undefined,
    weightUnit: overrides.weightUnit ?? 'kg',
    dryRun: overrides.dryRun ?? false,
    mqttProxy: overrides.mqttProxy,
    configSource: overrides.configSource ?? 'env',
    configPath: overrides.configPath,
    bleHandler: overrides.bleHandler ?? 'auto',
    bleAdapter: undefined,
    esphomeProxy: undefined,
    signal: new AbortController().signal,
    exporterCache: new Map(),
    embeddedBroker: null,
    abortApp: vi.fn(),
    setConfig: vi.fn(),
  } as AppContext;
}

function fakeExporter(name = 'webhook'): Exporter {
  return { name, export: vi.fn(async () => ({ success: true })) } as unknown as Exporter;
}

const MQTT_PROXY: MqttProxyConfig = {
  device_id: 'esp32-test',
  topic_prefix: 'ble-proxy',
  embedded_broker_port: 1883,
  embedded_broker_bind: '127.0.0.1',
} as unknown as MqttProxyConfig;

beforeEach(() => {
  vi.mocked(dispatchExports).mockReset();
  vi.mocked(dispatchExports).mockResolvedValue({
    success: true,
    details: [{ name: 'webhook', ok: true }],
  });
  vi.mocked(publishBeep).mockClear();
  vi.mocked(publishDisplayReading).mockClear();
  vi.mocked(publishDisplayResult).mockClear();
  vi.mocked(updateLastKnownWeight).mockClear();
  logSpy.mockClear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('processReading: single-user', () => {
  it('dry-run (no exporters) returns true and does not dispatch', async () => {
    const ctx = makeCtx([dad]);
    const ok = await processReading(ctx, rawReading());
    expect(ok).toBe(true);
    expect(dispatchExports).not.toHaveBeenCalled();
  });

  it('dispatches with ExportContext built from the single user', async () => {
    const ctx = makeCtx([dad]);
    const exporters = [fakeExporter()];
    const ok = await processReading(ctx, rawReading(), { singleUserExporters: exporters });
    expect(ok).toBe(true);
    expect(dispatchExports).toHaveBeenCalledOnce();
    const [calledExporters, payload, context] = vi.mocked(dispatchExports).mock.calls[0];
    expect(calledExporters).toBe(exporters);
    expect(payload.weight).toBe(80);
    expect(context).toEqual({
      userName: 'Dad',
      userSlug: 'dad',
      userConfig: dad,
    });
  });

  it('returns false when dispatchExports reports failure', async () => {
    vi.mocked(dispatchExports).mockResolvedValueOnce({ success: false, details: [] });
    const ctx = makeCtx([dad]);
    const ok = await processReading(ctx, rawReading(), { singleUserExporters: [fakeExporter()] });
    expect(ok).toBe(false);
  });

  it('logBodyComp emits metrics in fixed BodyComposition key order', async () => {
    const ctx = makeCtx([dad]);
    await processReading(ctx, rawReading());

    // Logger.info() prints to console.log with `<timestamp> [Sync] <msg>`.
    // Find the "Body composition:" header and check the next 9 metric lines.
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const headerIdx = lines.findIndex((s) => s.endsWith('Body composition:'));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    const metricLines = lines
      .slice(headerIdx + 1, headerIdx + 1 + 9)
      .map((s) => s.replace(/^[^[]*\[Sync\] /, ''));
    expect(metricLines).toEqual([
      '  bmi: 24',
      '  bodyFatPercent: 18',
      '  waterPercent: 60',
      '  boneMass: 3.00 kg',
      '  muscleMass: 65.00 kg',
      '  visceralFat: 5',
      '  physiqueRating: 6',
      '  bmr: 1800',
      '  metabolicAge: 30',
    ]);
  });
});

describe('processReading: multi-user', () => {
  it('returns true and beeps when no user matches and unknown_user is ignore', async () => {
    // Null last_known_weight on both users so matchUserByWeight cannot fall
    // back to last-known proximity (Tier 4) and reaches the unknown_user
    // strategy switch (Tier 5).
    const dadNoLast: UserConfig = { ...dad, last_known_weight: null };
    const momNoLast: UserConfig = { ...mom, last_known_weight: null };
    const config = makeAppConfig([dadNoLast, momNoLast]);
    config.unknown_user = 'ignore';
    const ctx: AppContext = {
      ...makeCtx([dadNoLast, momNoLast]),
      config,
      mqttProxy: MQTT_PROXY,
    };
    (ctx as { bleHandler: AppContext['bleHandler'] }).bleHandler = 'mqtt-proxy';

    const ok = await processReading(ctx, rawReading({ weight: 200, impedance: 0 }));
    expect(ok).toBe(true);
    expect(dispatchExports).not.toHaveBeenCalled();
    expect(publishBeep).toHaveBeenCalledWith(MQTT_PROXY, 600, 150, 3);
  });

  it('dispatches per matched user with drift warning in ExportContext when applicable', async () => {
    const ctx = makeCtx([dad, mom]);
    // 94 kg lands in upper 10% of dad's [75..95] range → triggers drift warn.
    const exporters = [fakeExporter()];
    const getter = vi.fn(() => exporters);
    const ok = await processReading(ctx, rawReading({ weight: 94, impedance: 500 }), {
      getExportersForUser: getter,
    });
    expect(ok).toBe(true);
    expect(getter).toHaveBeenCalledWith('dad');
    const [, , context] = vi.mocked(dispatchExports).mock.calls[0];
    expect(context).toMatchObject({ userName: 'Dad', userSlug: 'dad' });
    expect(context).toHaveProperty('driftWarning');
    expect(String((context as { driftWarning?: string }).driftWarning)).toMatch(/upper boundary/);
  });

  it('dry-run skips dispatch and last_known_weight write', async () => {
    const ctx = makeCtx([dad, mom], {
      dryRun: true,
      configSource: 'yaml',
      configPath: '/tmp/config.yaml',
    });
    const ok = await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      getExportersForUser: () => [fakeExporter()],
    });
    expect(ok).toBe(true);
    expect(dispatchExports).not.toHaveBeenCalled();
    expect(updateLastKnownWeight).not.toHaveBeenCalled();
  });

  it('writes last_known_weight only when configSource is yaml + configPath set', async () => {
    const ctx = makeCtx([dad, mom], { configSource: 'yaml', configPath: '/tmp/config.yaml' });
    await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      getExportersForUser: () => [fakeExporter()],
    });
    expect(updateLastKnownWeight).toHaveBeenCalledWith('/tmp/config.yaml', 'dad', 82, 82);
  });

  it('does not write last_known_weight when configSource is env', async () => {
    const ctx = makeCtx([dad, mom], { configSource: 'env' });
    await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      getExportersForUser: () => [fakeExporter()],
    });
    expect(updateLastKnownWeight).not.toHaveBeenCalled();
  });

  it('publishes display reading + result on mqtt-proxy handler', async () => {
    const ctx = makeCtx([dad, mom], { bleHandler: 'mqtt-proxy', mqttProxy: MQTT_PROXY });
    await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      getExportersForUser: () => [fakeExporter('webhook')],
    });
    // notifyReading is called with the raw reading weight (82) before
    // computeMetrics; notifyResult is called after with the computed payload
    // weight (FIXED_BODY_COMP.weight = 80).
    expect(publishDisplayReading).toHaveBeenCalledWith(MQTT_PROXY, 'dad', 'Dad', 82, 500, [
      'webhook',
    ]);
    expect(publishDisplayResult).toHaveBeenCalledWith(MQTT_PROXY, 'dad', 'Dad', 80, [
      { name: 'webhook', ok: true },
    ]);
    expect(publishBeep).toHaveBeenCalledWith(MQTT_PROXY, 1200, 200, 2);
  });

  it('does not publish on non-mqtt handlers', async () => {
    const ctx = makeCtx([dad, mom], { bleHandler: 'auto' });
    await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      getExportersForUser: () => [fakeExporter()],
    });
    expect(publishDisplayReading).not.toHaveBeenCalled();
    expect(publishDisplayResult).not.toHaveBeenCalled();
    expect(publishBeep).not.toHaveBeenCalled();
  });
});
