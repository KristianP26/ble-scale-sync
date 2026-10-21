import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { vi } from 'vitest';
import {
  DedupWindow,
  GraceTimers,
  emitDeduped,
  evaluateAdvertisement,
} from '../../../src/ble/advertisement.js';
import type { RawReading } from '../../../src/ble/shared.js';
import { bleLog, IMPEDANCE_GRACE_MS } from '../../../src/ble/types.js';
import type {
  AdapterRuntimeConfig,
  BleDeviceInfo,
  BodyComposition,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
} from '../../../src/interfaces/scale-adapter.js';
import { adapters } from '../../../src/scales/index.js';
import { resolveAdapter } from '../../../src/scales/resolve.js';
import { defaultProfile } from '../scale-test-utils.js';
import { FAKE_ADDRESS } from './session.js';
import type { Trace } from './trace.js';

/** DEDUP_WINDOW_MS of the proxy watchers (handler-*-proxy/watcher.ts, not exported). */
const DEDUP_WINDOW_MS = 30_000;
const DEFAULT_NOW = Date.UTC(2026, 0, 1);

/** One advertisement as a transport hands it over; the company id is never part of `mfr`'s bytes. */
export interface Advert {
  atMs: number;
  /** Manufacturer data: company id and payload hex. */
  mfr?: [number, string];
  /** Service data: uuid -> payload hex. */
  svc?: Record<string, string>;
  /** The same advert `count` more times, `everyMs` apart, as a scale repeats it. */
  repeat?: { count: number; everyMs: number };
}

export interface AdvertTrace extends Pick<Trace, 'provenance' | 'source'> {
  /**
   * What every advert carries besides its data. `address` defaults to
   * FAKE_ADDRESS; null is a transport without one (noble on macOS).
   */
  device?: { localName?: string; serviceUuids?: string[]; address?: string | null };
  /** Wall clock at atMs 0 (ms since the epoch). Default 2026-01-01 UTC. */
  now?: number;
  /** Replaces the fixture's `config` for this trace. */
  config?: AdapterRuntimeConfig;
  adverts: Advert[];
}

/** What a module under tests/fixtures/ exports as `adverts` to have its traces replayed and pinned. */
export interface AdvertFixture {
  /** `name` of a registered adapter; every trace gets a fresh instance of its class. */
  adapter: string;
  /** Given to `configure()` before the first advert, as run.ts does. */
  config?: AdapterRuntimeConfig;
  profile?: UserProfile;
  /** Keyed by the golden's file name, unique within the family. */
  traces: Record<string, AdvertTrace>;
}

export interface AdvertOutcome {
  atMs: number;
  /** A run of identical adverts with identical outcomes: when the last one came, and how many. */
  untilMs?: number;
  count?: number;
  data: string;
  /** Set when the registry resolves the advert to another adapter (or none): it is not evaluated. */
  resolvedTo?: string | null;
  decision?: 'complete' | 'partial' | 'wait' | 'gatt' | 'none';
  live?: number;
  reading?: ScaleReading;
  /** What the watcher did with it: queued, dropped by its dedup window, or held for impedance. */
  sink?: 'queued' | 'dedup' | 'held';
  warns?: string[];
}

export interface AdvertResult {
  adverts: AdvertOutcome[];
  /** What reached the queue, in order; `grace` is a weight-only reading whose hold ran out. */
  exports: {
    atMs: number;
    by: 'advert' | 'grace';
    reading: ScaleReading;
    payload: BodyComposition;
  }[];
}

function freshInstance(name: string, config?: AdapterRuntimeConfig): ScaleAdapter {
  const registered = adapters.find((a) => a.name === name);
  if (!registered) throw new Error(`no registered adapter is named "${name}"`);
  const a = new (registered.constructor as new () => ScaleAdapter)();
  if (config) a.configure?.(config);
  return a;
}

/**
 * Replay a trace of advertisements through the decision the transports share
 * (evaluateAdvertisement) and the proxy watchers' sink: registry resolution,
 * GraceTimers for a partial reading, DedupWindow and emitDeduped for a complete
 * one. Fake timers own both clocks (Date and performance), so the adapters'
 * repeat guards and the watcher's windows run on the trace's times.
 */
export function replayAdverts(f: AdvertFixture, trace: AdvertTrace): AdvertResult {
  vi.useFakeTimers({ now: trace.now ?? DEFAULT_NOW });
  const warns: string[] = [];
  const warn = vi.spyOn(bleLog, 'warn').mockImplementation((m) => void warns.push(m));
  try {
    const t0 = Date.now();
    const at = (): number => Date.now() - t0;
    const adapter = freshInstance(f.adapter, trace.config ?? f.config);
    const registry = adapters.map((a) => (a.name === f.adapter ? adapter : a));
    const profile = f.profile ?? defaultProfile();
    const result: AdvertResult = { adverts: [], exports: [] };
    const exported = (by: 'advert' | 'grace', reading: ScaleReading): void => {
      result.exports.push({
        atMs: at(),
        by,
        reading,
        payload: adapter.computeMetrics(reading, profile),
      });
    };
    const queue = { push: (raw: RawReading) => exported('advert', raw.reading) };
    const dedup = new DedupWindow(DEDUP_WINDOW_MS);
    const grace = new GraceTimers(IMPEDANCE_GRACE_MS, (_a, raw) => exported('grace', raw.reading));
    const { address = FAKE_ADDRESS, ...device } = trace.device ?? {};
    const key = address ?? 'no-address';

    const steps = trace.adverts.flatMap((s) =>
      Array.from({ length: (s.repeat?.count ?? 0) + 1 }, (_, i) => ({
        ...s,
        atMs: s.atMs + i * (s.repeat?.everyMs ?? 0),
      })),
    );
    for (const s of steps) {
      vi.advanceTimersByTime(s.atMs - at());
      const info: BleDeviceInfo = {
        localName: device.localName ?? '',
        serviceUuids: device.serviceUuids ?? [],
        ...(address !== null ? { address } : {}),
        ...(s.mfr
          ? { manufacturerData: { id: s.mfr[0], data: Buffer.from(s.mfr[1], 'hex') } }
          : {}),
        ...(s.svc
          ? {
              serviceData: Object.entries(s.svc).map(([uuid, h]) => ({
                uuid,
                data: Buffer.from(h, 'hex'),
              })),
            }
          : {}),
      };
      const data = [
        ...(s.mfr ? [`0x${s.mfr[0].toString(16).padStart(4, '0')} ${s.mfr[1]}`] : []),
        ...Object.entries(s.svc ?? {}).map(([uuid, h]) => `${uuid} ${h}`),
      ].join(', ');
      const out: AdvertOutcome = { atMs: at(), data };
      warns.length = 0;
      const resolved = resolveAdapter(info, registry);
      if (resolved !== adapter) {
        out.resolvedTo = resolved?.name ?? null;
      } else {
        const d = evaluateAdvertisement(adapter, info);
        out.decision = d.kind;
        if (d.kind === 'wait' && d.live) out.live = d.live.weight;
        if (d.kind === 'complete') {
          out.reading = d.reading;
          grace.cancel(key);
          const raw = { reading: d.reading, adapter };
          out.sink = emitDeduped(dedup, queue, key, raw, d.reading.weight) ? 'queued' : 'dedup';
        } else if (d.kind === 'partial') {
          out.reading = d.reading;
          grace.hold(key, { reading: d.reading, adapter });
          out.sink = 'held';
        }
      }
      if (warns.length > 0) out.warns = [...warns];
      const last = result.adverts.at(-1);
      const same = (o: AdvertOutcome): string =>
        JSON.stringify({ ...o, atMs: 0, untilMs: 0, count: 0 });
      if (last && same(last) === same(out)) {
        last.untilMs = out.atMs;
        last.count = (last.count ?? 1) + 1;
      } else {
        result.adverts.push(out);
      }
    }
    // Long enough for a hold armed by the last advert to run out.
    vi.advanceTimersByTime(IMPEDANCE_GRACE_MS + 1_000);
    grace.clear();
    return result;
  } finally {
    warn.mockRestore();
    vi.useRealTimers();
  }
}

/** Every module under tests/fixtures/ that exports `adverts`, with its family directory. */
export async function loadAdvertFixtures(): Promise<(AdvertFixture & { family: string })[]> {
  const root = fileURLToPath(new URL('../../fixtures/', import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .sort();
  const out: (AdvertFixture & { family: string })[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(root, file)).href)) as { adverts?: AdvertFixture };
    if (!mod.adverts) continue;
    if (!file.includes(sep)) throw new Error(`${file}: a fixture belongs in a family directory`);
    const family = file.split(sep)[0];
    for (const name of Object.keys(mod.adverts.traces)) {
      if (seen.has(`${family}/${name}`))
        throw new Error(`advert trace ${family}/${name} defined twice`);
      seen.add(`${family}/${name}`);
    }
    out.push({ ...mod.adverts, family });
  }
  return out;
}
