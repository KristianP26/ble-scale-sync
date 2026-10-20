import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AppConfig, UserConfig } from '../../src/config/schema.js';
import type { Exporter } from '../../src/interfaces/exporter.js';
import type {
  BodyComposition,
  ScaleAdapter,
  ScaleReading,
} from '../../src/interfaces/scale-adapter.js';
import type { RawReading } from '../../src/ble/shared.js';
import type { AppContext } from '../../src/runtime/context.js';

// The config write is not under test here and must not touch a real file: the
// replay anchor has to survive a restart WITHOUT config.yaml having moved,
// which is the case the 0.5 kg write threshold leaves behind.
vi.mock(import('../../src/config/write.js'), async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, updateLastKnownWeight: vi.fn() };
});

vi.mock(import('../../src/update-check.js'), () => ({
  checkAndLogUpdate: vi.fn(),
}));

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const { processReading } = await import('../../src/runtime/processor.js');
const { createAppContext } = await import('../../src/runtime/context.js');
const { resolveRuntimeConfig } = await import('../../src/config/resolve.js');

// Spelled out rather than imported: the file name is part of what the docs
// promise, and this test has to load (and fail on its own assertions) against
// code that does not have the module yet.
const ANCHOR_FILE = '.last-live-weigh-ins.json';

const PAYLOAD: BodyComposition = {
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

const adapter = {
  name: 'FakeScale',
  computeMetrics: (r: ScaleReading): BodyComposition => ({ ...PAYLOAD, weight: r.weight }),
} as unknown as ScaleAdapter;

function user(slug: string, lastKnown: number | null, range = { min: 50, max: 100 }): UserConfig {
  return {
    name: slug[0].toUpperCase() + slug.slice(1),
    slug,
    height: 180,
    birth_date: '1990-06-15',
    gender: 'male',
    is_athlete: false,
    weight_range: range,
    last_known_weight: lastKnown,
  };
}

/**
 * A config as a fresh process reads it from disk. Every process gets NEW user
 * objects: the processor keeps per-user-object state (what config.yaml held
 * before it moved the value), and reusing process 1's objects would carry that
 * across the simulated restart.
 */
function freshConfig(users: UserConfig[]): AppConfig {
  return {
    version: 1,
    scale: { weight_unit: 'kg', height_unit: 'cm' },
    unknown_user: 'nearest',
    out_of_range: 'warn',
    users: users.map((u) => ({ ...u, weight_range: { ...u.weight_range } })),
    update_check: false,
  } as AppConfig;
}

const at = (iso: string): Date => new Date(`2026-10-19T${iso}Z`);

describe('replay check across a process restart (#475, D067)', () => {
  let dir: string;
  let anchorFile: string;
  let garmin: Exporter & { export: ReturnType<typeof vi.fn> };

  /** One process: its own context over the same directory, created at `startIso`. */
  function startProcess(users: UserConfig[], startIso: string, dryRun = false): AppContext {
    vi.setSystemTime(at(startIso));
    const config = freshConfig(users);
    return createAppContext({
      config,
      // Retrying is off on purpose: without a config path the queue would land
      // next to the repository's .env.
      resolved: { ...resolveRuntimeConfig(config), retryFailedExports: false, dryRun },
      configSource: 'yaml',
      configPath: path.join(dir, 'config.yaml'),
      replayAnchorsPath: anchorFile,
      signal: new AbortController().signal,
      abortApp: () => {},
    } as Parameters<typeof createAppContext>[0]);
  }

  async function weighIn(
    ctx: AppContext,
    receivedIso: string,
    reading: ScaleReading,
    history?: ScaleReading[],
  ): Promise<void> {
    vi.setSystemTime(at(receivedIso));
    const raw: RawReading = { reading, adapter, ...(history ? { history } : {}) };
    if (ctx.config.users.length > 1) {
      await processReading(ctx, raw, { getExportersForUser: () => [garmin] });
    } else {
      await processReading(ctx, raw, { singleUserExporters: [garmin] });
    }
  }

  function exportedWeights(): Array<{ slug?: string; weight: number; historical: boolean }> {
    return garmin.export.mock.calls.map(([payload, context]) => {
      const c = context as { userSlug?: string; historical?: boolean };
      return {
        slug: c.userSlug,
        weight: (payload as BodyComposition).weight,
        historical: c.historical === true,
      };
    });
  }

  function savedFile(): Record<string, { weight: number; time: string }> {
    // Asserted first, so a missing file fails here and not on a thrown ENOENT.
    expect(fs.existsSync(anchorFile)).toBe(true);
    return JSON.parse(fs.readFileSync(anchorFile, 'utf-8'));
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-restart-'));
    anchorFile = path.join(dir, ANCHOR_FILE);
    garmin = {
      name: 'garmin',
      supportsBackdate: true,
      export: vi.fn(async () => ({ success: true })),
    } as unknown as Exporter & { export: ReturnType<typeof vi.fn> };
    vi.useFakeTimers({ toFake: ['Date'] });
    logSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips a copy of the last live weigh-in after a restart when the scale's clock runs ahead (probe1)", async () => {
    // config.yaml holds 79.7: the live 80 is 0.3 kg from it, below the 0.5 kg
    // threshold, so the file is not rewritten and only the anchor file can know
    // the weigh-in. Its stamp is 2 h ahead of the host (a container on UTC).
    const p1 = startProcess([user('dad', 79.7)], '07:00:00');
    await weighIn(p1, '07:00:05', { weight: 80, impedance: 500, timestamp: at('09:00:00') });
    expect(exportedWeights()).toEqual([{ slug: 'dad', weight: 80, historical: false }]);
    garmin.export.mockClear();

    const p2 = startProcess([user('dad', 79.7)], '07:30:00');
    // The scale hands over its stored copy, stamped by the same clock.
    await weighIn(p2, '09:10:00', { weight: 80, impedance: 500, timestamp: at('09:00:00') });

    expect(garmin.export).not.toHaveBeenCalled();
  });

  it.each([
    // A plain stored record, half an hour old when it arrives.
    ['a stored record', '08:30:00', { timestamp: at('08:00:00') }],
    // The #463 timing: a record from the scale's memory 260 s old, which is
    // live by age alone, measured just before the process started (D065).
    [
      'a reading from memory that predates the process start',
      '08:28:00',
      {
        timestamp: at('08:26:40'),
        fromMemory: true,
      },
    ],
  ])(
    'exports %s measured after the last live weigh-in of an earlier process',
    async (_label, startIso, extra) => {
      const p1 = startProcess([user('dad', 80)], '07:00:00');
      await weighIn(p1, '07:00:00', { weight: 80, impedance: 500 });
      garmin.export.mockClear();

      const p2 = startProcess([user('dad', 80)], startIso);
      await weighIn(p2, '08:31:00', { weight: 80.05, impedance: 480, ...extra });

      expect(exportedWeights()).toEqual([{ slug: 'dad', weight: 80.05, historical: true }]);
    },
  );

  it('skips a copy of an unstamped live weigh-in from an earlier run (R-1)', async () => {
    // Single-run mode: every run is a new process. The copy carries the
    // scale's clock 23 s after the live weigh-in was received (QN 19 B, E28).
    const p1 = startProcess([user('dad', 79.7)], '07:00:00');
    await weighIn(p1, '07:00:00', { weight: 80, impedance: 500 });
    garmin.export.mockClear();

    const p2 = startProcess([user('dad', 79.7)], '08:00:00');
    await weighIn(p2, '08:00:10', { weight: 80, impedance: 480, timestamp: at('07:00:23') });

    expect(garmin.export).not.toHaveBeenCalled();
  });

  it('saves the exact weight and the scale time of the last live weigh-in, keyed by slug', async () => {
    const p1 = startProcess([user('dad', 79.7)], '07:00:00');
    // 80.137 is a weight the config write would round to 80.14.
    await weighIn(p1, '07:00:05', { weight: 80.137, impedance: 500, timestamp: at('06:59:58') });

    expect(savedFile()).toEqual({ dad: { weight: 80.137, time: '2026-10-19T06:59:58.000Z' } });
    if (process.platform !== 'win32') {
      expect(fs.statSync(anchorFile).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ['no stamp', undefined],
    ['an unreadable stamp', new Date(NaN)],
  ])('saves the receipt time for a live weigh-in with %s', async (_label, timestamp) => {
    const p1 = startProcess([user('dad', 79.7)], '07:00:00');
    await weighIn(p1, '07:00:05', {
      weight: 80,
      impedance: 500,
      ...(timestamp ? { timestamp } : {}),
    });

    expect(savedFile()).toEqual({ dad: { weight: 80, time: '2026-10-19T07:00:05.000Z' } });
  });

  it('keeps one entry per user in multi-user mode', async () => {
    const users = [user('dad', 82, { min: 75, max: 95 }), user('mom', 60, { min: 50, max: 70 })];
    const p1 = startProcess(users, '07:00:00');
    await weighIn(p1, '07:00:00', { weight: 82.3, impedance: 500 });
    await weighIn(p1, '07:10:00', { weight: 60.2, impedance: 520 });

    expect(savedFile()).toEqual({
      dad: { weight: 82.3, time: '2026-10-19T07:00:00.000Z' },
      mom: { weight: 60.2, time: '2026-10-19T07:10:00.000Z' },
    });

    // And each user is restored and judged against their own entry.
    garmin.export.mockClear();
    const p2 = startProcess(users, '08:00:00');
    await weighIn(
      p2,
      '08:30:00',
      // Mom's record is a replay of her live weigh-in; Dad's is new.
      { weight: 82.35, impedance: 480, timestamp: at('07:30:00') },
      [{ weight: 60.2, impedance: 520, timestamp: at('07:10:20') }],
    );
    expect(exportedWeights()).toEqual([{ slug: 'dad', weight: 82.35, historical: true }]);
  });

  it('saves nothing for a stored record, a dry run or an export that failed everywhere', async () => {
    // Stored record only.
    const p1 = startProcess([user('dad', 80)], '07:00:00');
    await weighIn(p1, '07:30:00', { weight: 80.5, impedance: 480, timestamp: at('07:00:00') });
    expect(garmin.export).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(anchorFile)).toBe(false);

    // Dry run.
    const p2 = startProcess([user('dad', 80)], '07:40:00', true);
    await weighIn(p2, '07:40:00', { weight: 80.5, impedance: 500 });
    expect(fs.existsSync(anchorFile)).toBe(false);

    // Every exporter failed.
    garmin.export.mockResolvedValue({ success: false, error: 'down' });
    const p3 = startProcess([user('dad', 80)], '07:50:00');
    await weighIn(p3, '07:50:00', { weight: 80.5, impedance: 500 });
    expect(fs.existsSync(anchorFile)).toBe(false);
  });

  it('keeps skipping a stored copy of an older weigh-in that matches last_known_weight (probe-a)', async () => {
    // config.yaml holds 79.6 from an earlier live weigh-in; the last one, 80.0,
    // moved it by 0.4 kg, so only the anchor file has it. A stored copy of the
    // earlier weigh-in, within 0.1 kg of the file, is skipped as before.
    const p1 = startProcess([user('dad', 79.6)], '07:00:00');
    await weighIn(p1, '07:00:00', { weight: 80, impedance: 500 });
    garmin.export.mockClear();

    const p2 = startProcess([user('dad', 79.6)], '08:00:00');
    await weighIn(p2, '08:00:10', {
      weight: 79.62,
      impedance: 480,
      timestamp: new Date('2026-10-18T07:00:00Z'),
    });

    expect(garmin.export).not.toHaveBeenCalled();
  });

  it('ignores a saved weigh-in 0.5 kg or more away from last_known_weight', async () => {
    // A stale entry (a downgrade that moved config.yaml but not this file, or
    // config.yaml restored from a backup): the record is judged by the weight
    // rule against config.yaml alone, as v1.33.0 did.
    fs.writeFileSync(
      anchorFile,
      JSON.stringify({ dad: { weight: 80, time: '2026-10-19T06:00:00.000Z' } }),
    );
    const p2 = startProcess([user('dad', 79)], '08:00:00');
    // 79.05, stamped well after the saved time: exported against the saved
    // anchor, skipped against config.yaml.
    await weighIn(p2, '08:30:00', { weight: 79.05, impedance: 480, timestamp: at('07:30:00') });

    expect(garmin.export).not.toHaveBeenCalled();
  });
});
