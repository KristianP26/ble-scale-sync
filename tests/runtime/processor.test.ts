import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
import type { Exporter, ExportResultDetail } from '../../src/interfaces/exporter.js';
import type { DispatchResult } from '../../src/orchestrator.js';
import type { DisplayNotifier } from '../../src/interfaces/display-notifier.js';

// Capture (and suppress) log output. console.log is the sink for logger.info().
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

vi.mock(import('../../src/orchestrator.js'), () => ({
  dispatchExports: vi.fn(),
  runHealthchecks: vi.fn(),
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
const { setExporterSlot } = await import('../../src/runtime/exporter-slot.js');
const { dispatchExports } = await import('../../src/orchestrator.js');
const { updateLastKnownWeight } = await import('../../src/config/write.js');
const { checkAndLogUpdate } = await import('../../src/update-check.js');

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

function makeAppConfig(
  users: UserConfig[],
  outOfRange: AppConfig['out_of_range'] = 'warn',
): AppConfig {
  return {
    version: 1,
    scale: { weight_unit: 'kg', height_unit: 'cm' },
    unknown_user: 'nearest',
    out_of_range: outOfRange,
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
  display?: DisplayNotifier;
  outOfRange?: AppConfig['out_of_range'];
  exportQueuePath?: string;
}

function makeCtx(users: UserConfig[], overrides: CtxOverrides = {}): AppContext {
  return {
    // Copies: the processor now keeps last_known_weight current in memory
    // (E-03), so the shared fixtures would otherwise carry one test's weigh-in
    // into the next.
    config: makeAppConfig(
      users.map((u) => ({ ...u })),
      overrides.outOfRange,
    ),
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
    lastExportedWeights: new Map(),
    embeddedBroker: null,
    display: overrides.display,
    retryFailedExports: overrides.exportQueuePath !== undefined,
    exportQueuePath: overrides.exportQueuePath,
    abortApp: vi.fn(),
    setConfig: vi.fn(),
  } as AppContext;
}

/** A DisplayNotifier whose three methods are vi mocks, for capability assertions. */
function fakeDisplay(): DisplayNotifier & {
  reading: ReturnType<typeof vi.fn>;
  result: ReturnType<typeof vi.fn>;
  beep: ReturnType<typeof vi.fn>;
} {
  return { reading: vi.fn(), result: vi.fn(), beep: vi.fn() };
}

function fakeExporter(name = 'webhook'): Exporter {
  return { name, export: vi.fn(async () => ({ success: true })) } as unknown as Exporter;
}

/**
 * A dispatch outcome as the real orchestrator returns it: the details paired
 * with the exporter INSTANCES they came from (D029), matched here by name in
 * the order given. The queue reads the instance, not the name.
 */
function withAttempts(result: { success: boolean; details: ExportResultDetail[] }) {
  return async (exporters: Exporter[]): Promise<DispatchResult> => {
    const unused = [...exporters];
    const attempts = result.details.map((detail) => {
      const at = unused.findIndex((e) => e.name === detail.name);
      const [exporter] = unused.splice(at, 1);
      return { exporter, detail };
    });
    return { ...result, attempts };
  };
}

beforeEach(() => {
  vi.mocked(dispatchExports).mockReset();
  vi.mocked(dispatchExports).mockImplementation(async (exporters) => {
    const attempts = exporters.map((exporter) => ({
      exporter,
      detail: { name: exporter.name, ok: true as const },
    }));
    return { success: true, details: attempts.map((a) => a.detail), attempts };
  });
  vi.mocked(updateLastKnownWeight).mockClear();
  vi.mocked(checkAndLogUpdate).mockClear();
  logSpy.mockClear();
  warnSpy.mockClear();
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
    // timestamp: every dispatch now carries the measurement time, live ones
    // included (D027, F-06). No `historical` flag: this is a live weigh-in.
    expect(context).toEqual({
      userName: 'Dad',
      userSlug: 'dad',
      // The configured user object itself; its last_known_weight is the live
      // weigh-in by the time this runs (E-03), so not the `dad` fixture.
      userConfig: ctx.config.users[0],
      weightUnit: 'kg',
      timestamp: expect.any(Date),
    });
  });

  it('returns false when dispatchExports reports failure', async () => {
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({ success: false, details: [] }),
    );
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

  it('notifies the display with RAW scale weight, result with computed weight', async () => {
    const display = fakeDisplay();
    const ctx = makeCtx([dad], { display });

    // raw reading 82 kg + 500 Ohm, payload (FIXED_BODY_COMP) is 80 kg.
    // The display reading must show the raw 82; result uses the computed 80.
    await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      singleUserExporters: [fakeExporter('webhook')],
    });

    expect(display.reading).toHaveBeenCalledWith('dad', 'Dad', 82, 500, ['webhook']);
    expect(display.result).toHaveBeenCalledWith('dad', 'Dad', 80, [{ name: 'webhook', ok: true }]);
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
    const display = fakeDisplay();
    const ctx: AppContext = {
      ...makeCtx([dadNoLast, momNoLast], { display }),
      config,
    };

    const ok = await processReading(ctx, rawReading({ weight: 200, impedance: 0 }));
    expect(ok).toBe(true);
    expect(dispatchExports).not.toHaveBeenCalled();
    expect(display.beep).toHaveBeenCalledWith(600, 150, 3);
  });

  // E-19: the matcher already logs its own warning; the processor repeated it.
  it('logs the unknown_user: log warning once', async () => {
    const dadNoLast: UserConfig = { ...dad, last_known_weight: null };
    const momNoLast: UserConfig = { ...mom, last_known_weight: null };
    const config = makeAppConfig([dadNoLast, momNoLast]);
    config.unknown_user = 'log';
    const ctx: AppContext = { ...makeCtx([dadNoLast, momNoLast]), config };
    warnSpy.mockClear();

    await processReading(ctx, rawReading({ weight: 200, impedance: 0 }));
    const hits = warnSpy.mock.calls.filter((c) => String(c[0]).includes('logging and skipping'));
    expect(hits).toHaveLength(1);
  });

  it('dispatches per matched user with drift warning in ExportContext when applicable', async () => {
    const ctx = makeCtx([dad, mom], { weightUnit: 'lbs' });
    // 94 kg lands in upper 10% of dad's [75..95] range → triggers drift warn.
    const exporters = [fakeExporter()];
    const getter = vi.fn(() => exporters);
    const ok = await processReading(ctx, rawReading({ weight: 94, impedance: 500 }), {
      getExportersForUser: getter,
    });
    expect(ok).toBe(true);
    expect(getter).toHaveBeenCalledWith('dad');
    const [, , context] = vi.mocked(dispatchExports).mock.calls[0];
    expect(context).toMatchObject({ userName: 'Dad', userSlug: 'dad', weightUnit: 'lbs' });
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

  it('does not write last_known_weight when every exporter failed', async () => {
    // The anchor means "the weight we ACTUALLY exported". Writing it after a
    // total failure poisoned the retry: the scale reconnects, replays the same
    // frame now carrying a timestamp, and the replay dedup drops it as already
    // synced. The weigh-in is lost with nothing left to retry from.
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({ success: false, details: [] }),
    );
    const ctx = makeCtx([dad, mom], { configSource: 'yaml', configPath: '/tmp/config.yaml' });
    const ok = await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      getExportersForUser: () => [fakeExporter()],
    });
    expect(ok).toBe(false);
    expect(updateLastKnownWeight).not.toHaveBeenCalled();
  });

  it('does not set the single-user replay anchor when every exporter failed', async () => {
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({ success: false, details: [] }),
    );
    const ctx = makeCtx([dad]);
    await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      singleUserExporters: [fakeExporter()],
    });
    expect(ctx.lastExportedWeights.has('dad')).toBe(false);
  });

  // Not a regression test: this one passes with or without the fix. It is here
  // as a guard so a later change cannot quietly stop anchoring altogether,
  // which the two tests above would not catch (they only assert the negative).
  it('sets the single-user replay anchor when the export succeeds', async () => {
    const ctx = makeCtx([dad]);
    await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      singleUserExporters: [fakeExporter()],
    });
    expect(ctx.lastExportedWeights.get('dad')).toBe(82);
  });

  it('does not write last_known_weight when configSource is env', async () => {
    const ctx = makeCtx([dad, mom], { configSource: 'env' });
    await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      getExportersForUser: () => [fakeExporter()],
    });
    expect(updateLastKnownWeight).not.toHaveBeenCalled();
  });

  it('notifies the display reading + result + beep when a notifier is attached', async () => {
    const display = fakeDisplay();
    const ctx = makeCtx([dad, mom], { display });
    await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      getExportersForUser: () => [fakeExporter('webhook')],
    });
    // reading is called with the raw weight (82) before computeMetrics; result
    // is called after with the computed payload weight (FIXED_BODY_COMP = 80).
    expect(display.reading).toHaveBeenCalledWith('dad', 'Dad', 82, 500, ['webhook']);
    expect(display.result).toHaveBeenCalledWith('dad', 'Dad', 80, [{ name: 'webhook', ok: true }]);
    expect(display.beep).toHaveBeenCalledWith(1200, 200, 2);
  });

  it('is a safe no-op when no display notifier is attached', async () => {
    // Non-mqtt handlers never attach ctx.display; the transport-agnostic
    // processor must simply skip the calls without throwing (#183).
    const ctx = makeCtx([dad, mom]);
    expect(ctx.display).toBeUndefined();
    const ok = await processReading(ctx, rawReading({ weight: 82, impedance: 500 }), {
      getExportersForUser: () => [fakeExporter()],
    });
    expect(ok).toBe(true);
    expect(dispatchExports).toHaveBeenCalled();
  });
});

// ─── Historical replay tests ────────────────────────────────────────────────

describe('processReading: historical replay', () => {
  function rawWithHistory(...readings: ScaleReading[]): RawReading {
    const reading = readings[readings.length - 1];
    const history = readings.length > 1 ? readings.slice(0, -1) : undefined;
    return { reading, adapter: fakeAdapter(), history };
  }

  it('single-user: dispatches each historical reading then the live one in order with timestamps', async () => {
    const ctx = makeCtx([dad]);
    const exporters = [fakeExporter('garmin')];
    const raw = rawWithHistory(
      { weight: 80, impedance: 480, timestamp: new Date('2025-07-01T07:00:00Z') },
      { weight: 81, impedance: 490, timestamp: new Date('2025-07-02T07:00:00Z') },
      { weight: 82, impedance: 500 },
    );

    await processReading(ctx, raw, { singleUserExporters: exporters });

    expect(dispatchExports).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(dispatchExports).mock.calls;
    expect((calls[0][2] as { timestamp?: Date }).timestamp?.toISOString()).toBe(
      '2025-07-01T07:00:00.000Z',
    );
    expect((calls[1][2] as { timestamp?: Date }).timestamp?.toISOString()).toBe(
      '2025-07-02T07:00:00.000Z',
    );
    // The stored records are flagged; the live one is not, and carries the
    // receipt time rather than no time at all (D027, F-06).
    expect(calls[0][2]?.historical).toBe(true);
    expect(calls[1][2]?.historical).toBe(true);
    expect(calls[2][2]?.historical).toBeUndefined();
    expect(calls[2][2]?.timestamp).toBeInstanceOf(Date);
  });

  it('returns success of the last dispatch (live)', async () => {
    vi.mocked(dispatchExports)
      .mockImplementationOnce(withAttempts({ success: false, details: [] }))
      .mockImplementationOnce(
        withAttempts({ success: true, details: [{ name: 'garmin', ok: true }] }),
      );
    const ctx = makeCtx([dad]);
    const raw = rawWithHistory(
      { weight: 80, impedance: 480, timestamp: new Date('2025-07-01T07:00:00Z') },
      { weight: 82, impedance: 500 },
    );
    const ok = await processReading(ctx, raw, { singleUserExporters: [fakeExporter('garmin')] });
    expect(ok).toBe(true);
  });

  it('multi-user: writes last_known_weight once with the live raw weight', async () => {
    const ctx = makeCtx([dad, mom], { configSource: 'yaml', configPath: '/tmp/config.yaml' });
    const raw = rawWithHistory(
      { weight: 80, impedance: 480, timestamp: new Date('2025-07-01T07:00:00Z') },
      { weight: 82, impedance: 500 },
    );
    await processReading(ctx, raw, { getExportersForUser: () => [fakeExporter('garmin')] });
    expect(updateLastKnownWeight).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateLastKnownWeight).mock.calls[0][2]).toBe(82);
  });

  it('multi-user dedup: historical reading within tolerance of last_known_weight is skipped', async () => {
    // dad.last_known_weight = 82 in the fixture; the first historical (82.05) is
    // within +/-0.1 tolerance and should be skipped. The second (82.4) and the
    // live (82.5) both run.
    const ctx = makeCtx([dad, mom], { configSource: 'yaml', configPath: '/tmp/config.yaml' });
    const raw = rawWithHistory(
      { weight: 82.05, impedance: 480, timestamp: new Date('2025-07-01T07:00:00Z') },
      { weight: 82.4, impedance: 490, timestamp: new Date('2025-07-02T07:00:00Z') },
      { weight: 82.5, impedance: 500 },
    );
    await processReading(ctx, raw, { getExportersForUser: () => [fakeExporter('garmin')] });
    expect(dispatchExports).toHaveBeenCalledTimes(2);
  });

  it('multi-user: checkAndLogUpdate fires even when the last reading is deduped', async () => {
    // dad.last_known_weight = 82. The single (also last) historical reading
    // 82.05 falls inside the +/-0.1 dedup window, so the for-loop continues
    // on isLast. If checkAndLogUpdate lived inside the loop on isLast, this
    // cycle would silently skip the update check.
    const ctx = makeCtx([dad, mom], { configSource: 'yaml', configPath: '/tmp/config.yaml' });
    const raw: RawReading = {
      reading: {
        weight: 82.05,
        impedance: 480,
        timestamp: new Date('2025-07-01T07:00:00Z'),
      },
      adapter: fakeAdapter(),
    };
    await processReading(ctx, raw, { getExportersForUser: () => [fakeExporter('garmin')] });
    expect(checkAndLogUpdate).toHaveBeenCalledTimes(1);
    expect(dispatchExports).not.toHaveBeenCalled();
  });

  it('single-user: dispatches each entry with timestamp when last is also historical (no live frame)', async () => {
    // No last_known_weight: the newest record (82 kg) would otherwise be
    // deduped against it, which single-user mode now does too (E-09).
    const ctx = makeCtx([{ ...dad, last_known_weight: null }]);
    const exporters = [fakeExporter('garmin')];
    // Three historical readings, no live. shared.ts disconnect-with-history
    // promotes the newest as `reading` (timestamp still set), rest in history.
    const raw: RawReading = {
      reading: {
        weight: 82,
        impedance: 500,
        timestamp: new Date('2025-07-03T07:00:00Z'),
      },
      adapter: fakeAdapter(),
      history: [
        { weight: 80, impedance: 480, timestamp: new Date('2025-07-01T07:00:00Z') },
        { weight: 81, impedance: 490, timestamp: new Date('2025-07-02T07:00:00Z') },
      ],
    };

    await processReading(ctx, raw, { singleUserExporters: exporters });

    expect(dispatchExports).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(dispatchExports).mock.calls;
    expect((calls[0][2] as { timestamp?: Date }).timestamp?.toISOString()).toBe(
      '2025-07-01T07:00:00.000Z',
    );
    expect((calls[1][2] as { timestamp?: Date }).timestamp?.toISOString()).toBe(
      '2025-07-02T07:00:00.000Z',
    );
    expect((calls[2][2] as { timestamp?: Date }).timestamp?.toISOString()).toBe(
      '2025-07-03T07:00:00.000Z',
    );
  });

  // Reversed on purpose (E-09). Single-user used to ignore last_known_weight
  // for the replay dedup because it never wrote the field, so the value could
  // only be a stale hand-entered one. It now persists it after every exported
  // live weigh-in, and in single-run mode (a new process per run) that file
  // value is the ONLY memory of what was already exported, so ignoring it
  // re-exported the same stored records on every run.
  it('single-user: dedups stored records against the persisted last_known_weight', async () => {
    const lone: UserConfig = { ...dad, last_known_weight: 82 };
    const ctx = makeCtx([lone]);
    const exporters = [fakeExporter('garmin')];
    // Both stored records within +/-0.1 of last_known_weight; only the live
    // weigh-in goes out.
    const raw = rawWithHistory(
      { weight: 82.05, impedance: 480, timestamp: new Date('2025-07-01T07:00:00Z') },
      { weight: 82.07, impedance: 490, timestamp: new Date('2025-07-02T07:00:00Z') },
      { weight: 82.5, impedance: 500 },
    );

    await processReading(ctx, raw, { singleUserExporters: exporters });

    expect(dispatchExports).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchExports).mock.calls[0][1].weight).toBe(80); // FIXED_BODY_COMP
    expect(vi.mocked(dispatchExports).mock.calls[0][2]?.historical).toBeUndefined();
  });

  it('single-user: dedups a replay frame against the runtime anchor on a LATER reading (#164)', async () => {
    const ctx = makeCtx([dad]);
    const exporters = [fakeExporter('garmin')];

    // First weigh-in establishes the runtime anchor at the live raw weight 82.5.
    await processReading(ctx, rawReading({ weight: 82.5, impedance: 500 }), {
      singleUserExporters: exporters,
    });
    expect(ctx.lastExportedWeights.get('dad')).toBe(82.5);

    vi.mocked(dispatchExports).mockClear();

    // Second reading: a cache-replay historical frame at 82.55 (within +/-0.1 of
    // the anchor) is deduped; the live 83.0 frame dispatches.
    const raw = rawWithHistory(
      { weight: 82.55, impedance: 480, timestamp: new Date('2025-07-01T07:00:00Z') },
      { weight: 83.0, impedance: 500 },
    );
    await processReading(ctx, raw, { singleUserExporters: exporters });

    expect(dispatchExports).toHaveBeenCalledTimes(1);
    // The one dispatch is the live weigh-in: not flagged as a stored record.
    expect(vi.mocked(dispatchExports).mock.calls[0][2]?.historical).toBeUndefined();
    expect(ctx.lastExportedWeights.get('dad')).toBe(83.0);
  });

  it('single-user: dry-run does not advance the runtime dedup anchor', async () => {
    const ctx = makeCtx([dad]);
    // Dry run = undefined exporters. The anchor must stay unset so a later real
    // export is not spuriously deduped.
    await processReading(ctx, rawReading({ weight: 82.5, impedance: 500 }));
    expect(ctx.lastExportedWeights.has('dad')).toBe(false);
    expect(dispatchExports).not.toHaveBeenCalled();
  });
});

// ─── out_of_range (#395) ────────────────────────────────────────────────────

/**
 * weight_range was only ever a MATCHING input. A weight outside every range
 * still resolved to somebody and exported: through tier 1 with one user, or
 * through the last_known_weight proximity tier with several. The reporter's
 * 178 kg suitcase reading reached Garmin and a retained MQTT topic, and then
 * overwrote last_known_weight, which cost the NEXT genuine weigh-in as well.
 */
describe('processReading: out_of_range', () => {
  it('multi-user: skip stops the tier-4 fallthrough before the exporters', async () => {
    const ctx = makeCtx([dad, mom], {
      outOfRange: 'skip',
      configSource: 'yaml',
      configPath: '/tmp/config.yaml',
    });
    const ok = await processReading(ctx, rawReading({ weight: 178, impedance: 0 }), {
      getExportersForUser: () => [fakeExporter()],
    });

    expect(ok).toBe(true);
    expect(dispatchExports).not.toHaveBeenCalled();
    expect(updateLastKnownWeight).not.toHaveBeenCalled();
  });

  const warnings = (): string => warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join(' | ');

  it('multi-user: warn is the default and still exports, as before', async () => {
    const ctx = makeCtx([dad, mom], {
      configSource: 'yaml',
      configPath: '/tmp/config.yaml',
    });
    await processReading(ctx, rawReading({ weight: 178, impedance: 0 }), {
      getExportersForUser: () => [fakeExporter()],
    });

    expect(dispatchExports).toHaveBeenCalledTimes(1);
    expect(updateLastKnownWeight).toHaveBeenCalledTimes(1);
    // warn is not silence: the reading has to be called out even though it goes.
    expect(warnings()).toMatch(/outside/i);
    expect(warnings()).toMatch(/out_of_range: warn/);
  });

  it('multi-user: skip does not fire on a reading inside a range', async () => {
    const ctx = makeCtx([dad, mom], {
      outOfRange: 'skip',
      configSource: 'yaml',
      configPath: '/tmp/config.yaml',
    });
    await processReading(ctx, rawReading({ weight: 82.4, impedance: 500 }), {
      getExportersForUser: () => [fakeExporter()],
    });

    expect(dispatchExports).toHaveBeenCalledTimes(1);
    expect(updateLastKnownWeight).toHaveBeenCalledTimes(1);
    expect(warnings()).not.toMatch(/out_of_range/);
  });

  // Tier 1 always matches, so a single-user install is the case where the
  // range never guarded anything at all.
  it('single-user: skip stops the always-matching tier-1 export', async () => {
    const ctx = makeCtx([dad], { outOfRange: 'skip' });
    const ok = await processReading(ctx, rawReading({ weight: 178, impedance: 0 }), {
      singleUserExporters: [fakeExporter()],
    });

    expect(ok).toBe(true);
    expect(dispatchExports).not.toHaveBeenCalled();
    expect(ctx.lastExportedWeights.has('dad')).toBe(false);
  });

  // The single-user path never calls the matcher, so nothing else in it would
  // ever mention the range. Without an explicit warning here, `warn` mode is
  // silent on the one install shape where the range guarded nothing at all,
  // while three documentation pages promise it is logged.
  it('single-user: warn exports the reading AND says so', async () => {
    const ctx = makeCtx([dad]);
    await processReading(ctx, rawReading({ weight: 178, impedance: 0 }), {
      singleUserExporters: [fakeExporter()],
    });

    expect(dispatchExports).toHaveBeenCalledTimes(1);
    expect(ctx.lastExportedWeights.get('dad')).toBe(178);
    expect(warnings()).toMatch(/outside Dad's range \[75-95\]/);
    expect(warnings()).toMatch(/out_of_range: warn/);
  });

  it('a skipped reading does not even reach the update check', async () => {
    const ctx = makeCtx([dad], { outOfRange: 'skip' });
    await processReading(ctx, rawReading({ weight: 178, impedance: 0 }), {
      singleUserExporters: [fakeExporter()],
    });
    expect(checkAndLogUpdate).not.toHaveBeenCalled();
  });

  // Both reversed on purpose (E-04, D027). The guard used to gate the whole
  // batch on the live weight, because the stored records were assumed to be
  // the live user's. They are now attributed and gated one by one on their own
  // weight, so an out-of-range stored record is dropped on its own, and an
  // out-of-range live reading no longer takes good stored records with it.
  it('drops an out-of-range stored record and still exports the live reading', async () => {
    const ctx = makeCtx([dad], { outOfRange: 'skip' });
    const raw: RawReading = {
      reading: { weight: 82.5, impedance: 500 },
      adapter: fakeAdapter(),
      history: [{ weight: 178, impedance: 0, timestamp: new Date('2025-07-01T07:00:00Z') }],
    };
    await processReading(ctx, raw, { singleUserExporters: [fakeExporter()] });

    expect(dispatchExports).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchExports).mock.calls[0][2]?.historical).toBeUndefined();
  });

  it('skips an out-of-range live reading without taking an in-range stored record with it', async () => {
    const ctx = makeCtx([dad], { outOfRange: 'skip' });
    const raw: RawReading = {
      reading: { weight: 178, impedance: 0 },
      adapter: fakeAdapter(),
      history: [{ weight: 82.5, impedance: 480, timestamp: new Date('2025-07-01T07:00:00Z') }],
    };
    await processReading(ctx, raw, { singleUserExporters: [fakeExporter()] });

    expect(dispatchExports).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchExports).mock.calls[0][2]?.historical).toBe(true);
    // A stored record never moves the anchor (D027).
    expect(ctx.lastExportedWeights.has('dad')).toBe(false);
  });
});

describe('failed exports are queued for a later cycle (#412)', () => {
  let dir: string;
  let queuePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-queue-'));
    queuePath = path.join(dir, 'queue.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function exporterNamed(name: string, supportsBackdate: boolean): Exporter {
    return { name, supportsBackdate, export: vi.fn() } as unknown as Exporter;
  }

  it('queues a backdate-capable exporter, with the user it was measured for', async () => {
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({
        success: false,
        details: [{ name: 'garmin', ok: false, error: 'target down' }],
      }),
    );
    const ctx = makeCtx([dad], { exportQueuePath: queuePath });

    await processReading(ctx, rawReading(), {
      singleUserExporters: [exporterNamed('garmin', true)],
    });

    const lines = fs.readFileSync(queuePath, 'utf-8').trim().split(String.fromCharCode(10));
    expect(lines).toHaveLength(1);
    const queued = JSON.parse(lines[0]) as {
      exporter: string;
      userSlug?: string;
      lastError?: string;
      payload: { weight: number };
    };
    expect(queued.exporter).toBe('garmin');
    expect(queued.userSlug).toBe(dad.slug);
    expect(queued.lastError).toBe('target down');
    expect(queued.payload.weight).toBe(80);
  });

  it('does not queue an exporter that cannot record a past reading', async () => {
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({
        success: false,
        details: [{ name: 'mqtt', ok: false, error: 'broker down' }],
      }),
    );
    const ctx = makeCtx([dad], { exportQueuePath: queuePath });

    await processReading(ctx, rawReading(), {
      singleUserExporters: [exporterNamed('mqtt', false)],
    });

    // A late MQTT publish would contradict the live retained value, so the
    // reading is genuinely gone and the log has to say so.
    expect(fs.existsSync(queuePath)).toBe(false);
    const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
    expect(logged).toContain('not recoverable');
  });

  it('queues only the failures, not the exporters that succeeded', async () => {
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({
        success: true,
        details: [
          { name: 'file', ok: true },
          { name: 'garmin', ok: false, error: 'target down' },
        ],
      }),
    );
    const ctx = makeCtx([dad], { exportQueuePath: queuePath });

    await processReading(ctx, rawReading(), {
      singleUserExporters: [exporterNamed('file', true), exporterNamed('garmin', true)],
    });

    const lines = fs.readFileSync(queuePath, 'utf-8').trim().split(String.fromCharCode(10));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).exporter).toBe('garmin');
  });

  // D029: two exporters of one type in one list are both exported to, so the
  // queue entry must say WHICH one failed. The type name cannot.
  it('queues the failed instance with the config slot it was built from', async () => {
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({
        success: true,
        details: [
          { name: 'webhook', ok: true },
          { name: 'webhook', ok: false, error: 'HTTP 500' },
        ],
      }),
    );
    const first = exporterNamed('webhook', true);
    const second = exporterNamed('webhook', true);
    setExporterSlot(first, { list: 'global', index: 0 });
    setExporterSlot(second, { list: 'global', index: 1 });
    const ctx = makeCtx([dad], { exportQueuePath: queuePath });

    await processReading(ctx, rawReading(), { singleUserExporters: [first, second] });

    const lines = fs.readFileSync(queuePath, 'utf-8').trim().split(String.fromCharCode(10));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      exporter: 'webhook',
      exporterList: 'global',
      exporterIndex: 1,
    });
  });

  it('writes nothing when retrying is turned off, even with a path available', async () => {
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({
        success: false,
        details: [{ name: 'garmin', ok: false, error: 'target down' }],
      }),
    );
    // A path AND the flag off: without both, this test could pass because the
    // path was missing rather than because the flag was respected.
    const ctx = { ...makeCtx([dad], { exportQueuePath: queuePath }), retryFailedExports: false };

    await processReading(ctx, rawReading(), {
      singleUserExporters: [exporterNamed('garmin', true)],
    });
    expect(fs.existsSync(queuePath)).toBe(false);
  });

  it('stamps a queued LIVE reading with its measurement time, not the retry time', async () => {
    // A live weigh-in has no `reading.timestamp` - that field marks a historical
    // replay - so the ExportContext carries none either, and the entry used to
    // be written without one. On retry the exporter then got no timestamp at
    // all and `file` fell back to `new Date()`, recording a reading taken at
    // 07:00 as having happened whenever the retry succeeded.
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({
        success: false,
        details: [{ name: 'garmin', ok: false, error: 'target down' }],
      }),
    );
    const ctx = makeCtx([dad], { exportQueuePath: queuePath });

    const before = Date.now();
    await processReading(ctx, rawReading(), {
      singleUserExporters: [exporterNamed('garmin', true)],
    });
    const after = Date.now();

    const queued = JSON.parse(
      fs.readFileSync(queuePath, 'utf-8').trim().split(String.fromCharCode(10))[0],
    ) as { timestamp?: string };

    expect(queued.timestamp).toBeTypeOf('string');
    const stamped = Date.parse(queued.timestamp!);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('keeps a historical frame own timestamp rather than the observation time', async () => {
    const measured = new Date('2026-09-01T07:00:00.000Z');
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({
        success: false,
        details: [{ name: 'garmin', ok: false, error: 'target down' }],
      }),
    );
    const ctx = makeCtx([dad], { exportQueuePath: queuePath });
    await processReading(ctx, rawReading({ weight: 80, impedance: 500, timestamp: measured }), {
      singleUserExporters: [exporterNamed('garmin', true)],
    });

    const queued = JSON.parse(
      fs.readFileSync(queuePath, 'utf-8').trim().split(String.fromCharCode(10))[0],
    ) as { timestamp?: string };
    expect(queued.timestamp).toBe(measured.toISOString());
  });

  // Reversed on purpose (F-06). The live dispatch used to carry no
  // timestamp, so every backdate exporter took its own `new Date()` while the
  // queue entry carried a different, earlier time: a retry was then a second
  // measurement to the target, not the same one. "Historical" is now its own
  // flag, so stamping the live dispatch no longer filters out live MQTT.
  it('hands the LIVE dispatch the same measurement time the queue entry carries', async () => {
    vi.mocked(dispatchExports).mockImplementationOnce(
      withAttempts({
        success: false,
        details: [{ name: 'garmin', ok: false, error: 'target down' }],
      }),
    );
    const ctx = makeCtx([dad], { exportQueuePath: queuePath });

    await processReading(ctx, rawReading(), {
      singleUserExporters: [exporterNamed('garmin', true)],
    });

    const [, , context] = vi.mocked(dispatchExports).mock.calls[0];
    const queued = JSON.parse(
      fs.readFileSync(queuePath, 'utf-8').trim().split(String.fromCharCode(10))[0],
    ) as { timestamp?: string };
    expect(context?.timestamp).toBeInstanceOf(Date);
    expect(context?.timestamp?.toISOString()).toBe(queued.timestamp);
    expect(context?.historical).toBeUndefined();
  });
});
