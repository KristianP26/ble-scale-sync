import { describe, it, expect, vi } from 'vitest';
import { adapters } from '../../../src/scales/index.js';
import { defaultProfile } from '../../helpers/scale-test-utils.js';
import {
  freshAdapter,
  loadFixtures,
  replaySession,
  type SessionResult,
} from '../../helpers/replay/session.js';

/**
 * Contracts over the adapter registry and every fixture under tests/fixtures/
 * (D074). An adapter joins the session contracts by having a fixture; nothing
 * here is per adapter except the known failures below.
 */

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

const fixtures = await loadFixtures();

/** Declarative members of ScaleAdapter, pinned by value. */
const FIELDS = [
  'match',
  'requiresBonding',
  'singleBond',
  'charNotifyUuid',
  'charWriteUuid',
  'altCharNotifyUuid',
  'altCharWriteUuid',
  'characteristics',
  'unlockCommand',
  'unlockCommands',
  'unlockIntervalMs',
  'preferPassive',
  'ackWithResponse',
  'completionHoldMs',
];
/** Optional hooks, pinned by presence. */
const HOOKS = [
  'configure',
  'onConnected',
  'onSessionStart',
  'onSessionEnd',
  'buildAck',
  'parseCharNotification',
  'parseBroadcast',
  'parseLiveBroadcast',
  'parseServiceData',
  'isFinal',
  'isCompositionPending',
  'isStatusFrame',
  'advertisesPendingReading',
  'dedupMark',
  'restoreDedupMark',
];

const toHex = (c: number[]): string => Buffer.from(c).toString('hex');

describe('X-04: the declarative surface of every registered adapter', () => {
  it('matches golden/descriptors.json', async () => {
    const surface = adapters.map((a) => {
      const fields = a as unknown as Record<string, unknown>;
      const out: Record<string, unknown> = { name: a.name };
      for (const k of FIELDS) if (fields[k] !== undefined) out[k] = fields[k];
      if (a.unlockCommand) out.unlockCommand = toHex(a.unlockCommand);
      if (a.unlockCommands) out.unlockCommands = a.unlockCommands.map(toHex);
      out.hooks = HOOKS.filter((h) => typeof fields[h] === 'function');
      return out;
    });
    await expect(JSON.stringify(surface, null, 2) + '\n').toMatchFileSnapshot(
      '../../golden/descriptors.json',
    );
  });

  // Nothing converts a weight after the decoder any more (A-13); a flag that
  // says "I already return kg" would only suggest that something does.
  it('no adapter declares normalizesWeight', () => {
    expect(adapters.filter((a) => 'normalizesWeight' in a).map((a) => a.name)).toEqual([]);
  });
});

const without = (r: SessionResult, keys: (keyof SessionResult)[] = []): Partial<SessionResult> =>
  Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k as keyof SessionResult)));

// Session 1 is another trace of the same fixture where there is one, so state
// it leaks has something to differ by; its payload is computed only after
// session 2, as the watcher transports can do (#394).
describe('X-11: a session on a used instance behaves like one on a fresh instance', () => {
  for (const f of fixtures) {
    const names = Object.keys(f.traces);
    names.forEach((name, i) => {
      const before = names[(i + names.length - 1) % names.length];
      it(`${f.family}: ${before} then ${name}`, async () => {
        const profile = f.profile ?? defaultProfile();
        const used = freshAdapter(f);
        const first = await replaySession(used, f.traces[before], f);
        const second = await replaySession(used, f.traces[name], f);
        const lateFirst = first.reading && used.computeMetrics(first.reading, profile);
        const fresh = await replaySession(freshAdapter(f), f.traces[name], f);
        const freshFirst = await replaySession(freshAdapter(f), f.traces[before], f);
        expect(without(second, f.persists?.keys)).toEqual(without(fresh, f.persists?.keys));
        if (!f.persists?.keys.includes('payload')) expect(lateFirst).toEqual(freshFirst.payload);
      });
    });
  }
});

/**
 * A fixture's `identityBound` names an adapter whose computeMetrics reads state
 * keyed on the reading object, so a copy of the reading gets another payload.
 * Fixing them is A-02's work; until then the test runs as an expected failure
 * and turns red once one is fixed.
 *
 * The copy is computed only after the next session has run, as on the watcher
 * transports (#394): right after its own session the adapter's live cache
 * still holds the same weigh-in, and a fallback to it would pass unnoticed.
 */
describe('A-02: computeMetrics of a copied reading gives the same payload', () => {
  for (const name of new Set(fixtures.map((f) => f.adapter))) {
    const known = fixtures.find((f) => f.adapter === name && f.identityBound)?.identityBound;
    (known ? it.fails : it)(`${name}${known ? ` (fails today: ${known})` : ''}`, async () => {
      for (const f of fixtures.filter((x) => x.adapter === name)) {
        const names = Object.keys(f.traces);
        for (const [i, trace] of names.entries()) {
          const a = freshAdapter(f);
          const r = await replaySession(a, f.traces[trace], f);
          const profile = f.profile ?? defaultProfile();
          const readings = [r.reading, ...r.history].filter((x) => x !== null);
          const originals = readings.map((x) => a.computeMetrics(x, profile));
          const copies = readings.map((x) => structuredClone(x));
          const next = names[(i + 1) % names.length];
          if (next !== trace) {
            await replaySession(a, f.traces[next], f);
          } else {
            a.onSessionEnd?.();
            a.onSessionStart?.();
          }
          expect(copies.map((c) => a.computeMetrics(c, profile))).toEqual(originals);
        }
      }
    });
  }
});
