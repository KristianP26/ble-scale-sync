import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForRawReading } from '../../src/ble/shared.js';
import type { BleChar, BleDevice } from '../../src/ble/session/ports.js';
import { normalizeUuid } from '../../src/ble/types.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import { ActiveEraAdapter } from '../../src/scales/active-era.js';
import type { ScaleReading, UserProfile } from '../../src/interfaces/scale-adapter.js';
import {
  ALPHA_HANDSHAKE,
  ALPHA_LOCK_D6,
  ALPHA_LOCK_D6_NO_IMPEDANCE,
  ALPHA_NO_WRITE,
  ALPHA_PLATEAU_THEN_LOCK,
  ISSUE_458_DUMP_2,
  OPENSCALE_1358,
  parseDump,
  received,
  timed,
  type TimedFrame,
} from '../helpers/ac27-captures.js';
import { freshAdapter, replaySession } from '../helpers/replay/session.js';
import { session as ac27 } from '../fixtures/active-era/ac27.js';
import { session as fitdays } from '../fixtures/active-era/ac27-fitdays-profile.js';

/**
 * AC 27 weigh-ins end to end through `waitForRawReading`, at the spacing the
 * captures and logs recorded (#458, #462, #466). Kept out of shared.test.ts so
 * the frame fixtures stay with the family they belong to.
 */

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

const PROFILE: UserProfile = { height: 175, age: 49, gender: 'male', isAthlete: false };

interface MockChar extends BleChar {
  push(data: Buffer): void;
  subscribed: boolean;
  written: Array<{ data: Buffer; withResponse: boolean }>;
}

/** What reached the link, in order: a completed subscribe or a write. */
let events: string[] = [];

function mockChar(): MockChar {
  let onData: ((data: Buffer) => void) | null = null;
  const c: MockChar = {
    subscribed: false,
    written: [],
    subscribe: vi.fn(async (cb) => {
      c.subscribed = true;
      onData = cb;
      // A real CCCD write takes a round trip; a write issued meanwhile lands first.
      await Promise.resolve();
      events.push('subscribed');
      return () => {
        onData = null;
      };
    }),
    write: vi.fn(async (data: Buffer, withResponse: boolean) => {
      events.push('write');
      c.written.push({ data: Buffer.from(data), withResponse });
    }),
    read: vi.fn(async () => Buffer.alloc(0)),
    push: (data) => onData?.(data),
  };
  return c;
}

function mockDevice(): BleDevice & { disconnect: () => void } {
  let cb: (() => void) | null = null;
  let fired = false;
  const fire = (): void => {
    if (fired || !cb) return;
    fired = true;
    cb();
  };
  return { onDisconnect: (f) => (cb = f), fireDisconnect: fire, disconnect: fire };
}

async function startSession(profile: UserProfile = PROFILE) {
  events = [];
  const notify = mockChar();
  const write = mockChar();
  const device = mockDevice();
  const charMap = new Map<string, BleChar>([
    [normalizeUuid(uuid16(0xffb2)), notify],
    [normalizeUuid(uuid16(0xffb1)), write],
  ]);
  const adapter = new ActiveEraAdapter();
  const promise = waitForRawReading({
    charMap,
    device,
    adapter,
    profile,
    address: 'E0D38E019138',
    scaleAuth: undefined,
  });
  let result: ScaleReading | null = null;
  let settled = false;
  void promise.then(
    (r) => {
      settled = true;
      result = r.reading;
    },
    () => (settled = true),
  );
  await vi.waitFor(() => expect(notify.subscribed).toBe(true));
  await vi.advanceTimersByTimeAsync(0);

  /** Deliver frames at their recorded spacing; the clock carries over between calls. */
  let at = 0;
  const play = async (frames: TimedFrame[]): Promise<void> => {
    for (const f of frames) {
      await vi.advanceTimersByTimeAsync(f.atMs - at);
      at = f.atMs;
      notify.push(f.frame);
    }
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    adapter,
    device,
    write,
    play,
    isSettled: () => settled,
    reading: (): ScaleReading | null => result,
  };
}

/** #458 dump lines at their one-second timestamps. */
const fromDump = (text: string): TimedFrame[] =>
  parseDump(text).map((f) => ({ atMs: f.atS * 1000, dir: 'rx' as const, frame: f.frame }));

describe('AC 27 weigh-ins through waitForRawReading (#458, #462, #466)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // I1: the scale never locks and never sends D6. It used to run into the
  // session timeout with nothing.
  it('ALPHA without a profile: completes 8 s after the weight held steady', async () => {
    const s = await startSession();
    const frames = received(ALPHA_NO_WRITE);
    await s.play(frames);
    // The fifth identical 88.58 kg frame (00:10:03.862) is 2920 ms in, the
    // last frame 6220 ms in; the hold runs 8 s from the former.
    await vi.advanceTimersByTimeAsync(2920 + 8000 - 6220 - 1);
    expect(s.isSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.isSettled()).toBe(true);
    expect(s.reading()).toEqual({ weight: 88.58, impedance: 0 });
  });

  // I5: the same scale under openScale's MGB init.
  it('openScale #1358: completes on the fifth identical frame plus the hold', async () => {
    const s = await startSession();
    const frames = received(OPENSCALE_1358);
    // fifth identical 98.64 kg frame: 12:31:12.926, 3543 ms after the first
    const steadyAt = frames[11].atMs;
    expect(steadyAt).toBe(3543);
    await s.play(frames);
    await vi.advanceTimersByTimeAsync(steadyAt + 8000 - frames.at(-1)!.atMs - 1);
    expect(s.isSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.reading()).toEqual({ weight: 98.64, impedance: 0 });
  });

  // I2: a result without impedance is still the result.
  it('ALPHA lock and a D6 with 0 ohm: settles on the D6 at once', async () => {
    const s = await startSession();
    await s.play(received(ALPHA_LOCK_D6_NO_IMPEDANCE));
    expect(s.isSettled()).toBe(true);
    expect(s.reading()).toEqual({ weight: 89.24, impedance: 0, scaleComposition: 36 });
  });

  // I3
  it('ALPHA lock and D6 2.075 s later: settles on the D6 with 469 ohm', async () => {
    const s = await startSession();
    const frames = received(ALPHA_LOCK_D6);
    await s.play(frames.slice(0, -1));
    expect(s.isSettled()).toBe(false);
    await s.play([frames.at(-1)!]);
    expect(s.isSettled()).toBe(true);
    expect(s.reading()).toEqual({ weight: 88.97, impedance: 469, scaleComposition: 36 });
  });

  // I4: #458 locks, runs a balance phase for 13 s and sends D6 16 s after the
  // lock. The 8 s hold alone would have ended on the weight without impedance.
  it('#458 dump 2: waits through the balance phase for the D6', async () => {
    const s = await startSession();
    const frames = fromDump(ISSUE_458_DUMP_2);
    const d6 = frames.findIndex((f) => f.frame[18] === 0xd6);
    await s.play(frames.slice(0, d6));
    expect(s.isSettled()).toBe(false);
    await s.play([frames[d6]]);
    expect(s.isSettled()).toBe(true);
    expect(s.reading()!.weight).toBeCloseTo(87.62, 3);
    expect(s.reading()!.impedance).toBeCloseTo(434.92, 2);
  });

  // I6: the weight holds still for five frames before the lock comes. The
  // plateau must not end the weigh-in before the D6.
  it('ALPHA plateau, then lock, then D6: settles on the D6', async () => {
    const s = await startSession();
    const frames = received(ALPHA_PLATEAU_THEN_LOCK);
    await s.play(frames.slice(0, -1));
    expect(s.isSettled()).toBe(false);
    await s.play([frames.at(-1)!]);
    expect(s.isSettled()).toBe(true);
    expect(s.reading()).toEqual({ weight: 88.58, impedance: 469, scaleComposition: 36 });
  });

  it('a disconnect during the hold settles on the held weight', async () => {
    const s = await startSession();
    await s.play(received(ALPHA_NO_WRITE));
    expect(s.isSettled()).toBe(false);
    s.device.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.reading()).toEqual({ weight: 88.58, impedance: 0 });
  });

  // The FitDays order: subscribe first, then D0, DF 01, D0; ACK after the D6.
  it('writes the profile after subscribing and acknowledges the D6', async () => {
    vi.setSystemTime(0x6ab05637 * 1000); // the scale clock FitDays sent at 23:55:03
    // the fake profile the openScale PR #1534 tester entered in FitDays
    const s = await startSession({ height: 165, age: 31, gender: 'female', isAthlete: false });
    const captured = timed(ALPHA_HANDSHAKE)
      .filter((f) => f.dir === 'tx')
      .map((f) => f.frame);
    expect(s.write.written.map((w) => w.data)).toEqual([captured[0], captured[3], captured[4]]);
    expect(events.slice(0, 2)).toEqual(['subscribed', 'write']);
    await s.play(received(ALPHA_HANDSHAKE));
    expect(s.reading()).toEqual({ weight: 88.95, impedance: 469, scaleComposition: 36 });
    expect(s.write.written.at(-1)).toEqual({ data: captured.at(-1), withResponse: true });
  });
});

// The session goldens of tests/fixtures/active-era rest on the generic replay
// harness (D074), so it has to reach what the hand-driven sessions above reach.
describe('the same AC 27 captures through the replay harness', () => {
  it.each([
    ['alpha-no-write', 'reading', 10920, { weight: 88.58, impedance: 0 }],
    ['openscale-1358', 'reading', 11543, { weight: 98.64, impedance: 0 }],
    [
      'alpha-lock-d6-no-impedance',
      'reading',
      2186,
      { weight: 89.24, impedance: 0, scaleComposition: 36 },
    ],
    ['alpha-lock-d6', 'reading', 9933, { weight: 88.97, impedance: 469, scaleComposition: 36 }],
    [
      'issue-458-dump-2',
      'reading',
      19000,
      {
        weight: expect.closeTo(87.62, 3),
        impedance: expect.closeTo(434.92, 2),
        scaleComposition: 7,
      },
    ],
    [
      'alpha-plateau-then-lock',
      'reading',
      6767,
      { weight: 88.58, impedance: 469, scaleComposition: 36 },
    ],
    ['alpha-no-write-dropped-in-hold', 'disconnect', 6220, { weight: 88.58, impedance: 0 }],
  ])('%s: settled by %s at %i ms', async (name, by, atMs, reading) => {
    const r = await replaySession(freshAdapter(ac27), ac27.traces[name], ac27);
    expect(r.settled).toEqual({ by, atMs });
    expect(r.reading).toEqual(reading);
  });

  it('alpha-handshake: subscribe, the profile writes, the D6 ACK', async () => {
    const r = await replaySession(
      freshAdapter(fitdays),
      fitdays.traces['alpha-handshake'],
      fitdays,
    );
    const captured = timed(ALPHA_HANDSHAKE)
      .filter((f) => f.dir === 'tx')
      .map((f) => f.frame.toString('hex'));
    expect(r.subscribes[0].seq).toBe(0);
    expect(r.writes.map((w) => w.hex)).toEqual([
      captured[0],
      captured[3],
      captured[4],
      captured.at(-1),
    ]);
    expect(r.writes.at(-1)!.withResponse).toBe(true);
    expect(r.reading).toEqual({ weight: 88.95, impedance: 469, scaleComposition: 36 });
  });
});
