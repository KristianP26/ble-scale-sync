import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { vi } from 'vitest';
import { waitForRawReading } from '../../../src/ble/shared.js';
import type { RawReading } from '../../../src/ble/shared.js';
import type { BleChar, BleDevice } from '../../../src/ble/session/ports.js';
import { normalizeUuid } from '../../../src/ble/types.js';
import type { WeightUnit } from '../../../src/config/schema.js';
import type {
  AdapterRuntimeConfig,
  BodyComposition,
  ScaleAdapter,
  ScaleAuth,
  ScaleReading,
  UserProfile,
} from '../../../src/interfaces/scale-adapter.js';
import { adapters } from '../../../src/scales/index.js';
import { defaultProfile } from '../scale-test-utils.js';
import type { Trace } from './trace.js';

/** A fake, locally administered address: a fixture never carries a reporter's MAC (D074). */
export const FAKE_ADDRESS = '02:00:00:00:00:01';
/** Wall clock at the start of every session unless the fixture sets one: frames carrying the time stay stable. */
const DEFAULT_NOW = Date.UTC(2026, 0, 1);
/** How long after the last step the harness keeps the link up; longer than any hold plus its extensions. */
const TAIL_MS = 60_000;

export interface ReplayOptions {
  profile?: UserProfile;
  /** The reporter's `scale.weight_unit`, for the record: no session reads it, every decoder returns kg. */
  weightUnit?: WeightUnit;
  scaleAuth?: ScaleAuth;
  /** Characteristics the device exposes. Default: every one the adapter declares. */
  chars?: string[];
  /** Wall clock (ms since the epoch) at the session start. */
  now?: number;
}

/** What a module under tests/fixtures/ exports as `session` to have its traces replayed and pinned. */
export interface SessionFixture extends ReplayOptions {
  /** `name` of a registered adapter; every session gets a fresh instance of its class. */
  adapter: string;
  /** Given to `configure()` before the first session, as run.ts does. */
  config?: AdapterRuntimeConfig;
  /**
   * State the adapter keeps across sessions on purpose (X-11): result keys a
   * second session on the same instance may change, and why.
   */
  persists?: { keys: (keyof SessionResult)[]; why: string };
  /** Set when a cloned reading computes another payload today (A-02): finding ID and why. */
  identityBound?: string;
  /** Keyed by the golden's file name, unique within the family. */
  traces: Record<string, Trace>;
}

export interface SessionResult {
  /** What ended the session and when (ms from its start); `disconnect` means the link drop settled it. */
  settled: { by: 'reading' | 'disconnect' | 'error' | 'never'; atMs: number; error?: string };
  reading: ScaleReading | null;
  history: ScaleReading[];
  /** `seq` orders subscribes and writes against each other. */
  subscribes: { seq: number; atMs: number; uuid: string }[];
  writes: { seq: number; atMs: number; uuid: string; hex: string; withResponse: boolean }[];
  /** Notifications delivered while nothing listened on their characteristic. */
  rxDropped: number;
  payload: BodyComposition | null;
}

/** `0000ffb2-0000-1000-8000-00805f9b34fb` as `ffb2`, so a golden stays readable. */
const short = (uuid: string): string =>
  /^0000([0-9a-f]{4})00001000800000805f9b34fb$/.exec(uuid)?.[1] ?? uuid;

export function freshAdapter(f: SessionFixture): ScaleAdapter {
  const registered = adapters.find((a) => a.name === f.adapter);
  if (!registered) throw new Error(`no registered adapter is named "${f.adapter}"`);
  const a = new (registered.constructor as new () => ScaleAdapter)();
  if (f.config) a.configure?.(f.config);
  return a;
}

/** The only call of waitForRawReading here. */
function startSession(
  charMap: Map<string, BleChar>,
  device: BleDevice,
  adapter: ScaleAdapter,
  trace: Trace,
  o: ReplayOptions,
): Promise<RawReading> {
  return waitForRawReading({
    charMap,
    device,
    adapter,
    profile: o.profile ?? defaultProfile(),
    address: trace.advert?.address ?? FAKE_ADDRESS,
    scaleAuth: o.scaleAuth,
    deviceName: trace.advert?.localName || undefined,
    manufacturerData: trace.advert?.manufacturerData,
  });
}

/**
 * Replay a trace through the real waitForRawReading under fake timers: each
 * `rx` step is delivered at its time, and what the session wrote, subscribed
 * and settled with is returned. Owns the clock: fake timers are on for the
 * call only.
 */
export async function replaySession(
  adapter: ScaleAdapter,
  trace: Trace,
  o: ReplayOptions = {},
): Promise<SessionResult> {
  vi.useFakeTimers({ now: o.now ?? DEFAULT_NOW });
  try {
    const t0 = Date.now();
    const at = (): number => Date.now() - t0;
    let seq = 0;
    const r: SessionResult = {
      settled: { by: 'never', atMs: 0 },
      reading: null,
      history: [],
      subscribes: [],
      writes: [],
      rxDropped: 0,
      payload: null,
    };
    const listeners = new Map<string, (data: Buffer) => void>();
    const declared = [
      ...(adapter.characteristics ?? []).map((b) => b.uuid),
      adapter.charNotifyUuid,
      adapter.charWriteUuid,
    ].filter((u): u is string => !!u);
    const charMap = new Map<string, BleChar>();
    for (const uuid of (o.chars ?? declared).map(normalizeUuid)) {
      charMap.set(uuid, {
        subscribe: async (cb) => {
          listeners.set(uuid, cb);
          // A real CCCD write takes a round trip; a write issued meanwhile lands first.
          await Promise.resolve();
          r.subscribes.push({ seq: seq++, atMs: at(), uuid: short(uuid) });
          return () => listeners.get(uuid) === cb && listeners.delete(uuid);
        },
        write: async (data, withResponse) => {
          const h = Buffer.from(data).toString('hex');
          r.writes.push({ seq: seq++, atMs: at(), uuid: short(uuid), hex: h, withResponse });
        },
        read: async () => Buffer.alloc(0),
      });
    }
    let onDisconnect = (): void => {};
    const device: BleDevice = {
      onDisconnect: (cb) => (onDisconnect = cb),
      fireDisconnect: () => onDisconnect(),
    };
    let dropped = false;
    let done = false;
    startSession(charMap, device, adapter, trace, o).then(
      (raw) => {
        done = true;
        r.settled = { by: dropped ? 'disconnect' : 'reading', atMs: at() };
        r.reading = raw.reading;
        r.history = raw.history ?? [];
        r.payload = adapter.computeMetrics(raw.reading, o.profile ?? defaultProfile());
      },
      (e: unknown) => {
        done = true;
        r.settled = { by: 'error', atMs: at(), error: e instanceof Error ? e.message : String(e) };
      },
    );
    await vi.advanceTimersByTimeAsync(0);

    const notifyUuid = normalizeUuid(
      adapter.characteristics?.find((b) => b.type === 'notify')?.uuid ?? adapter.charNotifyUuid!,
    );
    const end = trace.disconnectAtMs ?? Infinity;
    for (const step of trace.steps) {
      if (done || step.dir !== 'rx' || step.atMs > end) continue;
      await vi.advanceTimersByTimeAsync(Math.max(0, step.atMs - at()));
      const listener = listeners.get(step.uuid ? normalizeUuid(step.uuid) : notifyUuid);
      if (listener) listener(Buffer.from(step.hex, 'hex'));
      else r.rxDropped += 1;
      await vi.advanceTimersByTimeAsync(0);
    }
    if (!done) {
      const last = trace.steps.at(-1)?.atMs ?? 0;
      await vi.advanceTimersByTimeAsync(Math.max(0, Math.min(end, last + TAIL_MS) - at()));
    }
    if (!done) {
      dropped = true;
      device.fireDisconnect();
      await vi.advanceTimersByTimeAsync(0);
    }
    return r;
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Modules under tests/fixtures/ that only share frames and constants with the
 * fixtures next to them. Every other module exports `session` or `adverts`, so
 * a fixture whose export is misspelled fails the loaders instead of dropping
 * out of the goldens without a word.
 */
const FIXTURE_HELPERS: ReadonlySet<string> = new Set(['qn/frames.ts', 'sig/frames.ts']);

/** Throws for a module under tests/fixtures/ that is neither a fixture nor in FIXTURE_HELPERS. */
export function assertFixtureModule(
  file: string,
  mod: { session?: unknown; adverts?: unknown },
): void {
  const path = file.split(sep).join('/');
  if (mod.session || mod.adverts || FIXTURE_HELPERS.has(path)) return;
  throw new Error(
    `tests/fixtures/${path} exports neither session nor adverts; a helper module goes in FIXTURE_HELPERS`,
  );
}

/**
 * Every module under tests/fixtures/ that exports `session`, with its family:
 * the directory directly under tests/fixtures/, which names the golden folder.
 */
export async function loadFixtures(): Promise<(SessionFixture & { family: string })[]> {
  const root = fileURLToPath(new URL('../../fixtures/', import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const out: (SessionFixture & { family: string })[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(root, file)).href)) as {
      session?: SessionFixture;
      adverts?: unknown;
    };
    assertFixtureModule(file, mod);
    if (!mod.session) continue;
    if (!file.includes(sep)) throw new Error(`${file}: a fixture belongs in a family directory`);
    const family = file.split(sep)[0];
    for (const name of Object.keys(mod.session.traces)) {
      if (seen.has(`${family}/${name}`)) throw new Error(`trace ${family}/${name} defined twice`);
      seen.add(`${family}/${name}`);
    }
    out.push({ ...mod.session, family });
  }
  return out;
}
