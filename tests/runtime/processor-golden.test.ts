import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppConfig, UserConfig } from '../../src/config/schema.js';
import type {
  BodyComposition,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
} from '../../src/interfaces/scale-adapter.js';
import type { Exporter, ExportContext } from '../../src/interfaces/exporter.js';
import type { AppContext } from '../../src/runtime/context.js';

/**
 * Processor goldens: one RawReading cycle in, the whole outcome out as data
 * (architecture audit 2026-10-21, wave 0 item 0.4, R step 0).
 *
 * Each scenario below runs processReading through the REAL orchestrator and
 * pins, in tests/golden/processor/<id>.json, what every exporter instance got
 * (payload, user, time, historical flag, slot), what was queued for retry,
 * what was written to config.yaml and the replay-anchor file, the in-memory
 * state after the cycle, the display calls and the log lines (which are the
 * only place a skip reason exists today). Only the exporters themselves, the
 * file writes and the update check are fakes.
 *
 * RULE: a refactor commit never changes a golden file. A golden change goes in
 * its own commit that says why the behaviour changed. Regenerate with
 * `npx vitest run tests/runtime/processor-golden.test.ts -u` and review the diff.
 *
 * Per-branch assertions with intent live in processor.test.ts and
 * processor-reading-contract.test.ts; this file only adds the whole-plan pin.
 */

const lines: string[] = [];
const capture = (...args: unknown[]): void => {
  // Drop the logger timestamp (frozen anyway) and the leading blank lines.
  const text = args.map(String).join(' ').replace(/^\n+/, '');
  lines.push(text.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} /, ''));
};
vi.spyOn(console, 'log').mockImplementation(capture);
vi.spyOn(console, 'warn').mockImplementation(capture);
vi.spyOn(console, 'error').mockImplementation(capture);
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

vi.mock(import('../../src/config/write.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  updateLastKnownWeight: vi.fn(),
}));
vi.mock(import('../../src/update-check.js'), () => ({ checkAndLogUpdate: vi.fn() }));
vi.mock(import('../../src/runtime/export-queue.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  enqueue: vi.fn(),
}));
vi.mock(import('../../src/runtime/replay-anchors.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  persistReplayAnchor: vi.fn(),
}));

const { processReading } = await import('../../src/runtime/processor.js');
const { setExporterSlot } = await import('../../src/runtime/exporter-slot.js');
const { updateLastKnownWeight } = await import('../../src/config/write.js');
const { checkAndLogUpdate } = await import('../../src/update-check.js');
const { enqueue } = await import('../../src/runtime/export-queue.js');
const { persistReplayAnchor } = await import('../../src/runtime/replay-anchors.js');

const NOW = new Date('2026-10-21T08:00:00.000Z');
const BODY_COMP_LINE =
  /^\[Sync\] .*(Body composition:|  (bmi|bodyFatPercent|waterPercent|boneMass|muscleMass|visceralFat|physiqueRating|bmr|metabolicAge): )/;

// --- Corpus ------------------------------------------------------------------

/** A frame: `at` is minutes relative to NOW (absent = no stamp). */
interface FrameSpec {
  kg: number;
  ohm?: number;
  at?: number;
  fromMemory?: boolean;
  userIndex?: number;
}
/** An exporter: `slot` is `<list>:<index>` as resolveExporterSlotsForUser hands it out. */
interface ExporterSpec {
  name: string;
  backdate?: boolean;
  reporter?: boolean;
  fail?: boolean;
  slot?: string;
}
interface Scenario {
  id: string;
  users: Array<keyof typeof USERS | Partial<UserConfig>>;
  config?: Partial<Pick<AppConfig, 'out_of_range' | 'unknown_user'>>;
  dryRun?: boolean;
  /** Set: config.yaml exists, so last_known_weight is written. */
  yaml?: boolean;
  /** Set: retry queue on. */
  queue?: boolean;
  /** Last live weigh-in an earlier process saved (D067): slug -> [kg, minutes]. */
  saved?: Record<string, [number, number]>;
  /** Absent: no exporters at all (the single-user dry-run signal). */
  exporters?: ExporterSpec[];
  live?: FrameSpec;
  history?: FrameSpec[];
}

const USERS = {
  dad: {
    name: 'Dad',
    slug: 'dad',
    height: 183,
    birth_date: '1990-06-15',
    gender: 'male',
    is_athlete: false,
    weight_range: { min: 75, max: 95 },
    last_known_weight: 82,
  },
  mom: {
    name: 'Mom',
    slug: 'mom',
    height: 165,
    birth_date: '1992-03-20',
    gender: 'female',
    is_athlete: false,
    weight_range: { min: 50, max: 70 },
    last_known_weight: 60,
  },
} satisfies Record<string, UserConfig>;

// Without a remembered weight, so a weight outside every range reaches unknown_user.
const STRANGERS = [
  { ...USERS.dad, last_known_weight: null },
  { ...USERS.mom, last_known_weight: null },
];
const GARMIN: ExporterSpec = { name: 'garmin', backdate: true, slot: 'global:0' };
const MQTT: ExporterSpec = { name: 'mqtt', slot: 'global:1' };

const CORPUS: Scenario[] = [
  // Single user
  {
    id: 'single-live-exported',
    users: ['dad'],
    yaml: true,
    exporters: [GARMIN, MQTT],
    live: { kg: 83.4, ohm: 480 },
  },
  { id: 'single-no-exporters-dry-run', users: ['dad'], live: { kg: 83.4, ohm: 480 } },
  {
    id: 'single-ctx-dry-run',
    users: ['dad'],
    dryRun: true,
    yaml: true,
    exporters: [GARMIN],
    live: { kg: 83.4, ohm: 480 },
  },
  {
    id: 'single-empty-exporter-list',
    users: ['dad'],
    exporters: [],
    live: { kg: 83.4, ohm: 480 },
  },
  {
    id: 'single-history-dedup-and-backdate',
    users: ['dad'],
    exporters: [GARMIN, MQTT],
    history: [
      { kg: 82.05, ohm: 470, at: -1440, fromMemory: true },
      { kg: 84.3, ohm: 475, at: -120 },
      { kg: 84.6, ohm: 0, fromMemory: true },
    ],
    live: { kg: 84.4, ohm: 480, at: -1 },
  },
  {
    id: 'single-history-only',
    users: ['dad'],
    exporters: [GARMIN, MQTT],
    history: [{ kg: 85.1, ohm: 470, at: -600 }],
  },
  {
    id: 'single-replay-vs-saved-anchor',
    users: ['dad'],
    saved: { dad: [84.4, -30] },
    exporters: [GARMIN],
    history: [
      { kg: 84.4, at: -32 },
      { kg: 84.45, at: -10 },
      { kg: 84.42, at: -25 },
    ],
    live: { kg: 84.5, ohm: 480 },
  },
  {
    id: 'single-stamp-ahead-of-host',
    users: ['dad'],
    exporters: [GARMIN],
    live: { kg: 83.0, ohm: 480, at: 10 },
  },
  {
    id: 'single-out-of-range-warn',
    users: ['dad'],
    yaml: true,
    exporters: [GARMIN],
    live: { kg: 120.0, ohm: 0 },
  },
  {
    id: 'single-out-of-range-skip',
    users: ['dad'],
    config: { out_of_range: 'skip' },
    yaml: true,
    exporters: [GARMIN],
    history: [
      { kg: 130.0, at: -300 },
      { kg: 86.0, at: -200 },
    ],
    live: { kg: 120.0, ohm: 0 },
  },
  {
    id: 'single-scale-user-slot',
    users: [{ ...USERS.dad, beurer_user_index: 1 }],
    exporters: [GARMIN],
    history: [
      { kg: 86.0, at: -300, userIndex: 2 },
      { kg: 86.5, at: -200, userIndex: 1 },
      { kg: 87.0, at: -100 },
    ],
  },
  {
    id: 'single-implausible-impedance',
    users: ['dad'],
    exporters: [GARMIN],
    live: { kg: 83.0, ohm: 6553 },
  },
  {
    id: 'single-all-failed-queued',
    users: ['dad'],
    yaml: true,
    queue: true,
    exporters: [
      { ...GARMIN, fail: true },
      { ...MQTT, fail: true },
      { name: 'webhook', backdate: true, fail: true, slot: 'global:2' },
    ],
    live: { kg: 83.0, ohm: 480 },
  },
  {
    id: 'single-partial-failure',
    users: ['dad'],
    yaml: true,
    queue: true,
    exporters: [{ ...GARMIN, fail: true }, MQTT],
    live: { kg: 83.0, ohm: 480 },
  },
  {
    id: 'single-queue-off',
    users: ['dad'],
    exporters: [{ ...GARMIN, fail: true }],
    live: { kg: 83.0, ohm: 480 },
  },
  {
    id: 'single-reporter-exporter',
    users: ['dad'],
    exporters: [GARMIN, { ...MQTT, fail: true }, { name: 'ntfy', reporter: true, slot: 'user:0' }],
    live: { kg: 83.0, ohm: 480 },
  },
  // Multi user
  {
    id: 'multi-live-match-drift',
    users: ['dad', 'mom'],
    yaml: true,
    exporters: [GARMIN, MQTT],
    live: { kg: 94.2, ohm: 500 },
  },
  {
    id: 'multi-live-tiebreak-by-last-known',
    users: ['dad', { ...USERS.mom, weight_range: { min: 60, max: 85 } }],
    exporters: [GARMIN],
    live: { kg: 80.0, ohm: 500 },
  },
  {
    id: 'multi-unknown-ignore',
    users: STRANGERS,
    config: { unknown_user: 'ignore' },
    exporters: [GARMIN],
    history: [{ kg: 30.0, at: -300 }],
    live: { kg: 30.0, ohm: 500 },
  },
  {
    id: 'multi-unknown-log',
    users: STRANGERS,
    config: { unknown_user: 'log' },
    exporters: [GARMIN],
    live: { kg: 72.0, ohm: 500 },
  },
  {
    id: 'multi-unknown-nearest',
    users: STRANGERS,
    exporters: [GARMIN],
    live: { kg: 72.0, ohm: 500 },
  },
  {
    id: 'multi-out-of-range-skip',
    users: ['dad', 'mom'],
    config: { out_of_range: 'skip' },
    exporters: [GARMIN],
    history: [{ kg: 61.0, at: -300 }],
    live: { kg: 120.0, ohm: 0 },
  },
  {
    id: 'multi-stored-attribution',
    users: ['dad', { ...USERS.mom, beurer_user_index: 2 }],
    exporters: [GARMIN, MQTT],
    history: [
      { kg: 61.5, at: -1440 },
      { kg: 90.0, at: -1000, userIndex: 2 },
      { kg: 82.0, at: -900 },
      { kg: 140.0, at: -800 },
    ],
    live: { kg: 83.1, ohm: 500 },
  },
  {
    id: 'multi-stored-slot-claimed-twice',
    users: [
      { ...USERS.dad, beurer_user_index: 1 },
      { ...USERS.mom, beurer_user_index: 1 },
    ],
    exporters: [GARMIN],
    history: [{ kg: 61.0, at: -300, userIndex: 1 }],
  },
  {
    id: 'multi-stored-ambiguous',
    users: [
      { ...USERS.dad, weight_range: { min: 60, max: 95 }, last_known_weight: null },
      { ...USERS.mom, weight_range: { min: 50, max: 80 }, last_known_weight: null },
    ],
    exporters: [GARMIN],
    history: [{ kg: 72.0, at: -300 }],
  },
  {
    id: 'multi-dry-run',
    users: ['dad', 'mom'],
    dryRun: true,
    yaml: true,
    exporters: [GARMIN],
    live: { kg: 61.0, ohm: 500 },
  },
  {
    id: 'multi-saved-anchor-per-user',
    users: ['dad', 'mom'],
    saved: { dad: [84.0, -60], mom: [61.0, -600] },
    exporters: [GARMIN],
    history: [
      { kg: 84.0, at: -20 },
      { kg: 61.05, at: -30 },
    ],
    live: { kg: 61.2, ohm: 500 },
  },
];

// --- Runner ------------------------------------------------------------------

const minutes = (m: number): Date => new Date(NOW.getTime() + m * 60_000);

function reading(f: FrameSpec): ScaleReading {
  return {
    weight: f.kg,
    impedance: f.ohm ?? 0,
    ...(f.at !== undefined ? { timestamp: minutes(f.at) } : {}),
    ...(f.fromMemory ? { fromMemory: true } : {}),
    ...(f.userIndex !== undefined ? { userIndex: f.userIndex } : {}),
  };
}

const iso = (d: Date | undefined): string | undefined => d?.toISOString();

async function run(s: Scenario): Promise<unknown> {
  const users: UserConfig[] = s.users.map((u) =>
    typeof u === 'string' ? { ...USERS[u] } : ({ ...u } as UserConfig),
  );
  const exports: unknown[] = [];
  const metricsInputs: unknown[] = [];
  const display: unknown[] = [];
  const instances = new Map<string, Exporter[]>();

  const exportersFor = (slug: string): Exporter[] => {
    const cached = instances.get(slug);
    if (cached) return cached;
    const built = (s.exporters ?? []).map((spec) => {
      const id = `${slug}/${spec.name}${spec.slot ? `@${spec.slot}` : ''}`;
      const e: Exporter = {
        name: spec.name,
        ...(spec.backdate ? { supportsBackdate: true } : {}),
        ...(spec.reporter ? { reportsExports: true } : {}),
        export: async (data: BodyComposition, c?: ExportContext) => {
          exports.push({
            to: id,
            weight: data.weight,
            impedance: data.impedance,
            user: c?.userSlug,
            timestamp: iso(c?.timestamp),
            historical: c?.historical,
            driftWarning: c?.driftWarning,
            exportResults: c?.exportResults,
          });
          return spec.fail ? { success: false, error: 'HTTP 500' } : { success: true };
        },
      };
      if (spec.slot) {
        const [list, index] = spec.slot.split(':');
        setExporterSlot(e, { list: list as 'user' | 'global', index: Number(index) });
      }
      return e;
    });
    instances.set(slug, built);
    return built;
  };

  const adapter = {
    name: 'GoldenScale',
    computeMetrics: (r: ScaleReading, p: UserProfile): BodyComposition => {
      metricsInputs.push({ weight: r.weight, impedance: r.impedance, profile: p });
      return {
        weight: r.weight,
        impedance: r.impedance,
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
    },
  } as unknown as ScaleAdapter;

  const saved = Object.entries(s.saved ?? {});
  const ctx = {
    config: {
      version: 1,
      scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' },
      unknown_user: s.config?.unknown_user ?? 'nearest',
      out_of_range: s.config?.out_of_range ?? 'warn',
      users,
      update_check: false,
    },
    weightUnit: 'kg',
    dryRun: s.dryRun ?? false,
    configSource: s.yaml ? 'yaml' : 'env',
    configPath: s.yaml ? '<config.yaml>' : undefined,
    retryFailedExports: s.queue ?? false,
    exportQueuePath: s.queue ? '<queue.json>' : undefined,
    replayAnchorsPath: '<anchors.json>',
    signal: new AbortController().signal,
    lastExportedWeights: new Map(saved.map(([slug, [kg]]) => [slug, kg])),
    lastExportedAt: new Map(saved.map(([slug, [, at]]) => [slug, minutes(at)])),
    display: {
      reading: (...a: unknown[]) => display.push(['reading', ...a]),
      result: (...a: unknown[]) => display.push(['result', ...a]),
      beep: (...a: unknown[]) => display.push(['beep', ...a]),
    },
  } as unknown as AppContext;

  const raw = {
    reading: s.live ? reading(s.live) : reading(s.history![s.history!.length - 1]),
    ...(s.history ? { history: (s.live ? s.history : s.history.slice(0, -1)).map(reading) } : {}),
    adapter,
  };
  const multi = users.length > 1;
  const returned = await processReading(ctx, raw, {
    ...(multi ? { getExportersForUser: exportersFor } : {}),
    ...(!multi && s.exporters ? { singleUserExporters: exportersFor(users[0].slug) } : {}),
  });

  return {
    returned,
    exports,
    computeMetrics: metricsInputs,
    queued: vi.mocked(enqueue).mock.calls.map(([, entry]) => entry),
    lastKnownWeightWrites: vi.mocked(updateLastKnownWeight).mock.calls,
    replayAnchorWrites: vi.mocked(persistReplayAnchor).mock.calls.map(([, slug, w, t]) => ({
      slug,
      weight: w.get(slug),
      time: iso(t.get(slug)),
    })),
    updateChecks: vi.mocked(checkAndLogUpdate).mock.calls.length,
    display,
    after: {
      lastExportedWeights: Object.fromEntries(ctx.lastExportedWeights),
      lastExportedAt: Object.fromEntries(
        [...ctx.lastExportedAt].map(([slug, d]) => [slug, iso(d)]),
      ),
      lastKnownWeight: Object.fromEntries(users.map((u) => [u.slug, u.last_known_weight])),
    },
    log: lines.filter((l) => !BODY_COMP_LINE.test(l)),
  };
}

describe('processor goldens (tests/golden/processor)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    // cliCommand() in log hints differs between `npm test` and `npx vitest`.
    vi.stubEnv('npm_command', '');
    vi.stubEnv('npm_lifecycle_event', '');
    lines.length = 0;
    vi.mocked(enqueue).mockClear();
    vi.mocked(updateLastKnownWeight).mockClear();
    vi.mocked(persistReplayAnchor).mockClear();
    vi.mocked(checkAndLogUpdate).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each(CORPUS.map((s) => [s.id, s] as const))('%s', async (id, scenario) => {
    const outcome = await run(scenario);
    await expect(`${JSON.stringify(outcome, null, 2)}\n`).toMatchFileSnapshot(
      `../golden/processor/${id}.json`,
    );
  });
});
