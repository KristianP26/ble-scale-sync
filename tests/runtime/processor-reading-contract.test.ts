import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig, UserConfig } from '../../src/config/schema.js';
import type {
  BodyComposition,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
} from '../../src/interfaces/scale-adapter.js';
import type { RawReading } from '../../src/ble/shared.js';
import type { AppContext } from '../../src/runtime/context.js';
import type { Exporter, ExportContext, ExportResult } from '../../src/interfaces/exporter.js';

/**
 * The reading contract of ADR D027 and D028, run through the REAL orchestrator.
 *
 * The older processor tests mock `dispatchExports`, and that mock is exactly
 * what hid these defects: which exporter receives a stored record, and what
 * time it carries, are decided inside the orchestrator. Only the file write and
 * the update check are stubbed here.
 */

vi.spyOn(console, 'log').mockImplementation(() => {});
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

vi.mock(import('../../src/config/write.js'), async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, updateLastKnownWeight: vi.fn() };
});
vi.mock(import('../../src/update-check.js'), () => ({ checkAndLogUpdate: vi.fn() }));

const { processReading } = await import('../../src/runtime/processor.js');
const { updateLastKnownWeight } = await import('../../src/config/write.js');

const PAYLOAD: BodyComposition = {
  weight: 0,
  impedance: 0,
  bmi: 24,
  bodyFatPercent: 18,
  waterPercent: 60,
  boneMass: 3,
  muscleMass: 60,
  visceralFat: 5,
  physiqueRating: 5,
  bmr: 1800,
  metabolicAge: 30,
};

/** An adapter whose computeMetrics records exactly what it was handed. */
function recordingAdapter(): ScaleAdapter & { seen: ScaleReading[] } {
  const seen: ScaleReading[] = [];
  return {
    seen,
    name: 'Fake',
    charNotifyUuid: 'aaa1',
    charWriteUuid: 'aaa2',
    unlockCommand: [],
    unlockIntervalMs: 0,
    matches: () => true,
    parseNotification: () => null,
    isComplete: () => true,
    computeMetrics: (r: ScaleReading, _p: UserProfile): BodyComposition => {
      seen.push({ ...r });
      return { ...PAYLOAD, weight: r.weight, impedance: r.impedance };
    },
  } as unknown as ScaleAdapter & { seen: ScaleReading[] };
}

interface Recorder extends Exporter {
  calls: { weight: number; context: ExportContext }[];
}

function exporter(name: string, supportsBackdate: boolean, result?: () => Promise<ExportResult>) {
  const calls: Recorder['calls'] = [];
  const e: Recorder = {
    name,
    supportsBackdate,
    calls,
    export: async (data, context) => {
      calls.push({ weight: data.weight, context: context! });
      return result ? result() : { success: true };
    },
  };
  return e;
}

const user = (over: Partial<UserConfig>): UserConfig =>
  ({
    name: 'Dad',
    slug: 'dad',
    height: 183,
    birth_date: '1990-06-15',
    gender: 'male',
    is_athlete: false,
    weight_range: { min: 75, max: 95 },
    last_known_weight: null,
    ...over,
  }) as UserConfig;

function makeCtx(users: UserConfig[], over: Partial<AppContext> = {}): AppContext {
  const config: AppConfig = {
    version: 1,
    scale: { weight_unit: 'kg', height_unit: 'cm' },
    unknown_user: 'nearest',
    out_of_range: 'warn',
    users,
    update_check: false,
  } as AppConfig;
  return {
    config,
    scaleMac: undefined,
    weightUnit: 'kg',
    dryRun: false,
    mqttProxy: undefined,
    configSource: 'env',
    configPath: undefined,
    bleHandler: 'auto',
    bleAdapter: undefined,
    esphomeProxy: undefined,
    haBluetooth: undefined,
    signal: new AbortController().signal,
    exporterCache: new Map(),
    lastExportedWeights: new Map(),
    embeddedBroker: null,
    retryFailedExports: false,
    exportQueuePath: undefined,
    abortApp: vi.fn(),
    setConfig: vi.fn(),
    ...over,
  } as AppContext;
}

const DAYS_AGO = (n: number): Date => new Date(Date.now() - n * 24 * 3600_000);

beforeEach(() => {
  vi.mocked(updateLastKnownWeight).mockClear();
  warnSpy.mockClear();
});

describe('D027: what time a reading carries, and what counts as history', () => {
  it('treats a reading the scale stamped seconds ago as a live weigh-in', async () => {
    // A scale that stamps its live frames (SIG Time Stamp flag) must still
    // reach live-only targets. A timestamp used to BE the history marker, so
    // this weigh-in silently skipped MQTT.
    const mqtt = exporter('mqtt', false);
    const garmin = exporter('garmin', true);
    const stamped = new Date(Date.now() - 30_000);
    const ctx = makeCtx([user({})]);
    const raw: RawReading = {
      reading: { weight: 82, impedance: 500, timestamp: stamped },
      adapter: recordingAdapter(),
    };

    await processReading(ctx, raw, { singleUserExporters: [mqtt, garmin] });

    expect(mqtt.calls).toHaveLength(1);
    expect(garmin.calls[0].context.timestamp).toEqual(stamped);
    expect(ctx.lastExportedWeights.get('dad')).toBe(82);
  });

  it('sends a stored record only to backdate exporters, with its own time', async () => {
    const mqtt = exporter('mqtt', false);
    const garmin = exporter('garmin', true);
    const stored = DAYS_AGO(2);
    const ctx = makeCtx([user({})]);
    const raw: RawReading = {
      reading: { weight: 82, impedance: 500 },
      history: [{ weight: 80, impedance: 480, timestamp: stored }],
      adapter: recordingAdapter(),
    };

    await processReading(ctx, raw, { singleUserExporters: [mqtt, garmin] });

    expect(mqtt.calls.map((c) => c.weight)).toEqual([82]);
    expect(garmin.calls.map((c) => c.weight)).toEqual([80, 82]);
    expect(garmin.calls[0].context.timestamp).toEqual(stored);
  });

  it('gives a live weigh-in one measurement time, and the retry queue the same one (F-04, F-06)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-contract-'));
    try {
      const queuePath = path.join(dir, 'queue.jsonl');
      const garmin = exporter('garmin', true, async () => ({ success: false, error: 'timeout' }));
      const ctx = makeCtx([user({})], { retryFailedExports: true, exportQueuePath: queuePath });

      await processReading(
        ctx,
        { reading: { weight: 82, impedance: 500 }, adapter: recordingAdapter() },
        { singleUserExporters: [garmin] },
      );

      // Garmin used to get no timestamp for a live reading, so every retry
      // process stamped its own `now` and could upload the weigh-in twice.
      const sent = garmin.calls[0].context.timestamp;
      expect(sent).toBeInstanceOf(Date);
      const queued = JSON.parse(fs.readFileSync(queuePath, 'utf-8').trim()) as {
        timestamp: string;
      };
      expect(queued.timestamp).toBe(sent!.toISOString());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not move the anchor or last_known_weight with a stored record', async () => {
    const garmin = exporter('garmin', true);
    const ctx = makeCtx([user({ last_known_weight: 82 })], {
      configSource: 'yaml',
      configPath: '/tmp/config.yaml',
    });
    // Disconnect after a replay with no live frame: the newest stored record
    // arrives as `reading`, which used to be treated as the live weigh-in.
    const raw: RawReading = {
      reading: { weight: 85, impedance: 500, timestamp: DAYS_AGO(1) },
      adapter: recordingAdapter(),
    };

    await processReading(ctx, raw, { singleUserExporters: [garmin] });

    expect(garmin.calls).toHaveLength(1);
    expect(ctx.lastExportedWeights.has('dad')).toBe(false);
    expect(ctx.config.users[0].last_known_weight).toBe(82);
    expect(updateLastKnownWeight).not.toHaveBeenCalled();
  });
});

describe('D027 / E-04: a stored record belongs to whoever it weighs like', () => {
  const dad = (): UserConfig => user({ last_known_weight: 82 });
  const mom = (over: Partial<UserConfig> = {}): UserConfig =>
    user({
      name: 'Mom',
      slug: 'mom',
      gender: 'female',
      weight_range: { min: 50, max: 70 },
      last_known_weight: 60,
      ...over,
    });

  function perUser(): { lookup: (slug: string) => Exporter[]; by: Record<string, Recorder> } {
    const by: Record<string, Recorder> = {
      dad: exporter('garmin', true),
      mom: exporter('garmin', true),
    };
    return { lookup: (slug) => [by[slug]], by };
  }

  it('sends Mom her stored weigh-in even though Dad is on the scale', async () => {
    const { lookup, by } = perUser();
    const ctx = makeCtx([dad(), mom()]);
    const raw: RawReading = {
      reading: { weight: 83, impedance: 500 },
      history: [{ weight: 61, impedance: 520, timestamp: DAYS_AGO(1) }],
      adapter: recordingAdapter(),
    };

    await processReading(ctx, raw, { getExportersForUser: lookup });

    expect(by.dad.calls.map((c) => c.weight)).toEqual([83]);
    expect(by.mom.calls.map((c) => c.weight)).toEqual([61]);
  });

  it('prefers the scale user slot the frame names over the weight', async () => {
    const { lookup, by } = perUser();
    const ctx = makeCtx([dad(), mom({ beurer_user_index: 2 })]);
    const raw: RawReading = {
      reading: { weight: 83, impedance: 500 },
      // Weighs like Dad, but the scale says it is user 2's record.
      history: [{ weight: 80, impedance: 520, timestamp: DAYS_AGO(1), userIndex: 2 }],
      adapter: recordingAdapter(),
    };

    await processReading(ctx, raw, { getExportersForUser: lookup });

    expect(by.mom.calls.map((c) => c.weight)).toEqual([80]);
    expect(by.dad.calls.map((c) => c.weight)).toEqual([83]);
  });

  it('drops a stored record that fits two users with nothing to tell them apart', async () => {
    const { lookup, by } = perUser();
    // Overlapping ranges and no last_known_weight: only config order decides.
    const ctx = makeCtx([
      user({ weight_range: { min: 60, max: 95 } }),
      mom({ weight_range: { min: 50, max: 75 }, last_known_weight: null }),
    ]);
    const raw: RawReading = {
      reading: { weight: 90, impedance: 500 },
      history: [{ weight: 70, impedance: 520, timestamp: DAYS_AGO(1) }],
      adapter: recordingAdapter(),
    };

    await processReading(ctx, raw, { getExportersForUser: lookup });

    expect(by.dad.calls.map((c) => c.weight)).toEqual([90]);
    expect(by.mom.calls).toHaveLength(0);
    const warned = warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join(' | ');
    expect(warned).toMatch(/Dropping a stored record of 70\.00 kg: it fits more than one user/);
  });
});

describe('E-03 / E-09: last_known_weight follows the live weigh-ins', () => {
  it('multi-user: keeps the in-memory value current, so the next replay of it dedups', async () => {
    const garmin = exporter('garmin', true);
    const users = [
      user({ last_known_weight: 80 }),
      user({ name: 'Mom', slug: 'mom', weight_range: { min: 50, max: 70 }, last_known_weight: 60 }),
    ];
    const ctx = makeCtx(users, { configSource: 'yaml', configPath: '/tmp/config.yaml' });
    const lookup = (): Exporter[] => [garmin];

    await processReading(
      ctx,
      { reading: { weight: 82.3, impedance: 500 }, adapter: recordingAdapter() },
      { getExportersForUser: lookup },
    );
    expect(ctx.config.users[0].last_known_weight).toBe(82.3);

    // The scale later replays that same weigh-in from its memory.
    garmin.calls.length = 0;
    await processReading(
      ctx,
      {
        reading: { weight: 82.3, impedance: 500, timestamp: DAYS_AGO(1) },
        adapter: recordingAdapter(),
      },
      { getExportersForUser: lookup },
    );
    expect(garmin.calls).toHaveLength(0);
  });

  it('single-user: persists last_known_weight to config.yaml', async () => {
    const ctx = makeCtx([user({ last_known_weight: 80 })], {
      configSource: 'yaml',
      configPath: '/tmp/config.yaml',
    });

    await processReading(
      ctx,
      { reading: { weight: 82.3, impedance: 500 }, adapter: recordingAdapter() },
      { singleUserExporters: [exporter('garmin', true)] },
    );

    expect(updateLastKnownWeight).toHaveBeenCalledWith('/tmp/config.yaml', 'dad', 82.3, 80);
  });

  it('compares the 0.5 kg write threshold against the file, not the moving memory', async () => {
    const ctx = makeCtx([user({ last_known_weight: 80 })], {
      configSource: 'yaml',
      configPath: '/tmp/config.yaml',
    });
    const run = (w: number): Promise<boolean> =>
      processReading(
        ctx,
        { reading: { weight: w, impedance: 500 }, adapter: recordingAdapter() },
        { singleUserExporters: [exporter('garmin', true)] },
      );

    await run(80.3);
    await run(80.6);

    // Both below 0.5 kg against the previous weigh-in, but 80.6 is 0.6 kg away
    // from the 80 still on disk, so the second call must compare against 80.
    expect(vi.mocked(updateLastKnownWeight).mock.calls.at(-1)).toEqual([
      '/tmp/config.yaml',
      'dad',
      80.6,
      80,
    ]);
  });
});

describe('D028: the processor decides whether an impedance is usable', () => {
  it.each([6553.5, 65535, 40, 5000])('hands computeMetrics 0 instead of %s ohm', async (ohm) => {
    const adapter = recordingAdapter();
    const ctx = makeCtx([user({})]);
    await processReading(
      ctx,
      { reading: { weight: 82, impedance: ohm }, adapter },
      { singleUserExporters: [] },
    );
    expect(adapter.seen[0].impedance).toBe(0);
  });

  it('leaves a plausible impedance alone', async () => {
    const adapter = recordingAdapter();
    const ctx = makeCtx([user({})]);
    await processReading(
      ctx,
      { reading: { weight: 82, impedance: 437 }, adapter },
      { singleUserExporters: [] },
    );
    expect(adapter.seen[0].impedance).toBe(437);
  });
});

describe('E-10: a shutdown during an export is named, not silent', () => {
  it('logs the reading and the exports still running when the app is told to stop', async () => {
    const ac = new AbortController();
    let release!: () => void;
    const garmin = exporter(
      'garmin',
      true,
      () => new Promise<ExportResult>((r) => (release = () => r({ success: true }))),
    );
    const ctx = makeCtx([user({})], { signal: ac.signal });

    const done = processReading(
      ctx,
      { reading: { weight: 82.4, impedance: 500 }, adapter: recordingAdapter() },
      { singleUserExporters: [garmin] },
    );
    await vi.waitFor(() => expect(garmin.calls).toHaveLength(1));
    ac.abort();
    release();
    await done;

    const warned = warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join(' | ');
    expect(warned).toMatch(/Shutdown requested while exporting 82\.40 kg for Dad measured at/);
    expect(warned).toMatch(/\[garmin\] had not finished/);
  });
});
