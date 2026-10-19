import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Coverage for buildReadingSource() (#186, rewired in #246). Transport selection
// now lives in createReadingSource (covered by tests/ble/reading-source.test.ts);
// here we mock the factory and assert buildReadingSource wires the returned plan
// into the loop bundle (watcher -> source + reload; poll -> watchdog + cooldown).

const h = vi.hoisted(() => {
  class FakePollSource {
    nextReading = vi.fn();
    constructor(
      public ctx: unknown,
      public adapters: unknown,
    ) {}
  }
  const watchdogInstances: Array<{
    maxFailures: number;
    onTrip: (c: { consecutiveFailures: number }) => void;
    recordSuccess: ReturnType<typeof vi.fn>;
    recordFailure: ReturnType<typeof vi.fn>;
  }> = [];
  class FakeWatchdog {
    recordSuccess = vi.fn();
    recordFailure = vi.fn();
    constructor(
      public maxFailures: number,
      public onTrip: (c: { consecutiveFailures: number }) => void,
    ) {
      watchdogInstances.push(this);
    }
  }
  return {
    FakePollSource,
    FakeWatchdog,
    watchdogInstances,
    createReadingSource: vi.fn(),
    raceWithLiveness: vi.fn(() => new Promise(() => {})),
    resolveUserProfile: vi.fn(() => ({ __profile: 'sentinel' })),
    abortableSleep: vi.fn(async () => undefined),
  };
});

vi.mock('../../src/ble/index.js', () => ({ createReadingSource: h.createReadingSource }));
vi.mock('../../src/runtime/poll-source.js', () => ({ PollReadingSource: h.FakePollSource }));
vi.mock('../../src/ble/watchdog.js', () => ({ ConsecutiveFailureWatchdog: h.FakeWatchdog }));
vi.mock('../../src/runtime/proxy-liveness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/proxy-liveness.js')>();
  return { ...actual, raceWithLiveness: h.raceWithLiveness };
});
vi.mock('../../src/config/resolve.js', () => ({ resolveUserProfile: h.resolveUserProfile }));
vi.mock('../../src/ble/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ble/types.js')>();
  return { ...actual, abortableSleep: h.abortableSleep };
});

const { buildReadingSource } = await import('../../src/runtime/sources.js');
const { POST_DISCONNECT_GRACE_MS, PairingDeferredError, SessionTimeoutError, StaleLinkError } =
  await import('../../src/ble/types.js');
import type { AppContext } from '../../src/runtime/context.js';
import type { ScaleAdapter } from '../../src/interfaces/scale-adapter.js';
import { tagBleFailure } from '../../src/ble/failure-kind.js';
import { currentProfile } from '../../src/ble/reading-source.js';
import type { ProfileSource } from '../../src/ble/reading-source.js';

const ADAPTERS = [{ name: 'A' }] as unknown as ScaleAdapter[];

function makeCtx(overrides: Partial<AppContext> = {}): AppContext {
  return {
    bleHandler: 'auto',
    mqttProxy: undefined,
    esphomeProxy: undefined,
    scaleMac: 'AA:BB:CC:DD:EE:FF',
    weightUnit: 'lbs',
    signal: new AbortController().signal,
    abortApp: vi.fn(),
    config: {
      users: [{ beurer_pin: 1234, beurer_user_index: 2 }],
      scale: {},
      runtime: { scan_cooldown: 5 },
    },
    ...overrides,
  } as unknown as AppContext;
}

/** Make the factory return a watcher plan with an arg-capturing updateConfig. */
function watcherPlan(failureLogPrefix: string) {
  const watcher = {
    start: vi.fn(),
    stop: vi.fn(),
    nextReading: vi.fn(),
    updateConfig: vi.fn(),
  };
  return { kind: 'watcher' as const, watcher, failureLogPrefix };
}

describe('buildReadingSource() wiring (#186, #246)', () => {
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    origExitCode = process.exitCode;
    vi.clearAllMocks();
    h.watchdogInstances.length = 0;
    h.resolveUserProfile.mockReturnValue({ __profile: 'sentinel' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = origExitCode;
    vi.restoreAllMocks();
  });

  it('passes the transport-selection inputs to createReadingSource', async () => {
    h.createReadingSource.mockResolvedValue(watcherPlan('Error processing reading'));
    const ctx = makeCtx({ bleHandler: 'mqtt-proxy', mqttProxy: { broker_url: 'x' } as never });
    await buildReadingSource(ctx, ADAPTERS, 10, 30);

    expect(h.createReadingSource).toHaveBeenCalledWith({
      bleHandler: 'mqtt-proxy',
      mqttProxy: ctx.mqttProxy,
      esphomeProxy: undefined,
      adapters: ADAPTERS,
      targetMac: ctx.scaleMac,
      profile: expect.any(Function),
      scaleAuth: { pin: 1234, userIndex: 2 },
      weightUnit: 'lbs',
    });
    const { profile } = h.createReadingSource.mock.calls[0][0] as { profile: ProfileSource };
    expect(currentProfile(profile)).toEqual({ __profile: 'sentinel' });
  });

  it('hands the watcher a profile source that resolves users[0] on every call (#331)', async () => {
    const plan = watcherPlan('Error processing ESPHome reading');
    h.createReadingSource.mockResolvedValue(plan);
    const ctx = makeCtx({ bleHandler: 'esphome-proxy', esphomeProxy: { host: 'h' } as never });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 10, 30);
    const { profile } = h.createReadingSource.mock.calls[0][0] as { profile: ProfileSource };

    // The processor moves last_known_weight in memory after every export; a
    // snapshot taken at startup kept the scale on the startup anchor.
    h.resolveUserProfile.mockReturnValueOnce({ lastKnownWeight: 70 } as never);
    h.resolveUserProfile.mockReturnValueOnce({ lastKnownWeight: 72.5 } as never);
    expect(currentProfile(profile)).toEqual({ lastKnownWeight: 70 });
    expect(currentProfile(profile)).toEqual({ lastKnownWeight: 72.5 });

    bundle.onSourceReload?.();
    const sent = plan.watcher.updateConfig.mock.calls[0][0] as { profile: ProfileSource };
    h.resolveUserProfile.mockReturnValueOnce({ lastKnownWeight: 92 } as never);
    expect(currentProfile(sent.profile)).toEqual({ lastKnownWeight: 92 });
  });

  it('watcher plan: returns the watcher as the source with its prefix and a re-resolving reload', async () => {
    const plan = watcherPlan('Error processing ESPHome reading');
    h.createReadingSource.mockResolvedValue(plan);
    const ctx = makeCtx({ bleHandler: 'esphome-proxy', esphomeProxy: { host: 'h' } as never });

    const bundle = await buildReadingSource(ctx, ADAPTERS, 10, 30);

    // The watcher is wrapped rather than returned directly, so the proxy
    // liveness check can sit around nextReading (#281). start/stop/nextReading
    // still have to reach the watcher itself.
    expect(bundle.failureLogPrefix).toBe('Error processing ESPHome reading');
    await bundle.source.start?.();
    expect(plan.watcher.start).toHaveBeenCalled();
    await bundle.source.stop?.();
    expect(plan.watcher.stop).toHaveBeenCalled();

    bundle.onSourceReload?.();
    expect(plan.watcher.updateConfig).toHaveBeenCalledWith({
      adapters: ADAPTERS,
      targetMac: ctx.scaleMac,
      profile: expect.any(Function),
      scaleAuth: { pin: 1234, userIndex: 2 },
      weightUnit: 'lbs',
    });

    // The unit is read again on reload, like everything else the watcher gets.
    (ctx as { weightUnit: string }).weightUnit = 'kg';
    bundle.onSourceReload?.();
    expect(plan.watcher.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ weightUnit: 'kg' }),
    );
  });

  it('poll plan: PollReadingSource + watchdog-wired hooks', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const ctx = makeCtx({ bleHandler: 'auto' });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);

    expect(bundle.source).toBeInstanceOf(h.FakePollSource);
    expect((bundle.source as unknown as { ctx: unknown }).ctx).toBe(ctx);
    expect((bundle.source as unknown as { adapters: unknown }).adapters).toBe(ADAPTERS);
    expect(bundle.failureLogPrefix).toBe('No scale found');

    const wd = h.watchdogInstances[0];
    expect(wd.maxFailures).toBe(7);

    bundle.onFailure?.(new Error('boom'));
    expect(wd.recordFailure).toHaveBeenCalledOnce();

    await bundle.onSuccess?.();
    expect(wd.recordSuccess).toHaveBeenCalledOnce();
    // appliesGraceFloor=false → sleeps exactly cooldown*1000.
    expect(h.abortableSleep).toHaveBeenCalledWith(5000, ctx.signal);
  });

  it('poll plan: uses fallback cooldown when runtime.scan_cooldown is unset', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const ctx = makeCtx({
      bleHandler: 'auto',
      config: { users: [{}], scale: {}, runtime: {} } as never,
    });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);
    await bundle.onSuccess?.();
    expect(h.abortableSleep).toHaveBeenCalledWith(30_000, ctx.signal);
  });

  it('poll plan: appliesGraceFloor applies the post-disconnect grace floor', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: true });
    const ctx = makeCtx({ bleHandler: 'auto' }); // cooldown 5s = 5000ms < 25000ms floor
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);
    await bundle.onSuccess?.();
    expect(POST_DISCONNECT_GRACE_MS).toBe(25_000);
    expect(h.abortableSleep).toHaveBeenCalledWith(POST_DISCONNECT_GRACE_MS, ctx.signal);
  });

  // #398. The classification already existed for the watchdog (#213); the
  // backoff just never saw it.
  it('poll plan: an idle failure gets the idle delay, a wedge-suspect gets the backoff', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const ctx = makeCtx({
      bleHandler: 'auto',
      config: {
        users: [{}],
        scale: {},
        runtime: { scan_cooldown: 5, idle_rescan_delay: 3 },
      } as never,
    });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);

    const idle = tagBleFailure(new Error('Device not found'), 'idle');
    expect(bundle.failureDelayMs?.(idle)).toBe(3_000);

    // Untagged and wedge-suspect errors are not claimed, so the loop backs off.
    expect(bundle.failureDelayMs?.(tagBleFailure(new Error('gatt'), 'wedge-suspect'))).toBe(
      undefined,
    );
    expect(bundle.failureDelayMs?.(new Error('export failed'))).toBe(undefined);
  });

  // #417. 'idle' promises the full discovery timeout elapsed, which is what
  // makes even a zero idle_rescan_delay safe; a skipped connect makes no such
  // promise, so it backs off, and it does not say "No scale found" either.
  it('poll plan: a blocked failure takes the backoff and its own log prefix', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const ctx = makeCtx({
      bleHandler: 'auto',
      config: {
        users: [{}],
        scale: {},
        runtime: { scan_cooldown: 5, idle_rescan_delay: 0 },
      } as never,
    });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);
    const blocked = tagBleFailure(new Error('LE privacy is not active'), 'blocked');

    expect(bundle.failureDelayMs?.(blocked)).toBe(undefined);
    expect(bundle.failureLogPrefixFor?.(blocked)).toBe('Scale found but not connected');
    expect(bundle.failureLogPrefixFor?.(tagBleFailure(new Error('x'), 'idle'))).toBe(undefined);
    expect(bundle.failureLogPrefixFor?.(new Error('untagged'))).toBe(undefined);
    bundle.onFailure?.(blocked);
    expect(h.watchdogInstances[0].recordFailure).not.toHaveBeenCalled();
  });

  // #460: the scale was found, connected and subscribed, then the session ran
  // out of time without a reading. "No scale found" sent people looking for a
  // pairing or range problem that was not there.
  it('poll plan: a session timeout says the scale connected, and keeps the backoff', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const bundle = await buildReadingSource(makeCtx(), ADAPTERS, 7, 30);
    const timedOut = tagBleFailure(
      new SessionTimeoutError('Timed out waiting for a complete scale reading', 'idle'),
      'wedge-suspect',
    );

    expect(bundle.failureLogPrefixFor?.(timedOut)).toBe('Scale connected but sent no reading');
    expect(
      bundle.failureLogPrefixFor?.(new SessionTimeoutError('GATT session cap exceeded', 'cap')),
    ).toBe('Scale connected but sent no reading');
    expect(bundle.failureDelayMs?.(timedOut)).toBe(undefined);
    // Any other GATT failure keeps the old prefix.
    expect(bundle.failureLogPrefixFor?.(tagBleFailure(new Error('x'), 'wedge-suspect'))).toBe(
      undefined,
    );
  });

  // #472: BlueZ still listed the scale as connected and never finished the
  // Disconnect, so the scale was found; "No scale found" would point at range.
  it('poll plan: a stale BlueZ link says the scale was found, and still counts', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const bundle = await buildReadingSource(makeCtx(), ADAPTERS, 7, 30);
    const stale = tagBleFailure(new StaleLinkError('AA:BB:CC:DD:EE:FF'), 'wedge-suspect');

    expect(bundle.failureLogPrefixFor?.(stale)).toBe('Scale found but not connected');
    expect(bundle.failureDelayMs?.(stale)).toBe(undefined);
    bundle.onFailure?.(stale);
    expect(h.watchdogInstances[0].recordFailure).toHaveBeenCalledTimes(1);
  });

  // #471, D063: the scale was found and listened to, not connected, because
  // nobody confirmed its last pairing. Idle when the radio heard the room.
  it('poll plan: a deferred pairing gets the idle delay, its own prefix, and is not counted', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const ctx = makeCtx({
      config: {
        users: [{}],
        scale: {},
        runtime: { scan_cooldown: 5, idle_rescan_delay: 4 },
      } as never,
    });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);
    const deferred = tagBleFailure(new PairingDeferredError('AA:BB:CC:DD:EE:FF', 120_000), 'idle');

    expect(bundle.failureLogPrefixFor?.(deferred)).toBe('Scale found, waiting to pair');
    expect(bundle.failureDelayMs?.(deferred)).toBe(4_000);
    bundle.onFailure?.(deferred);
    expect(h.watchdogInstances[0].recordFailure).not.toHaveBeenCalled();
  });

  it('poll plan: a deferred pairing on a deaf radio is counted and backs off', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const bundle = await buildReadingSource(makeCtx(), ADAPTERS, 7, 30);
    const deaf = tagBleFailure(
      new PairingDeferredError('AA:BB:CC:DD:EE:FF', 120_000),
      'wedge-suspect',
    );

    expect(bundle.failureLogPrefixFor?.(deaf)).toBe('Scale found, waiting to pair');
    expect(bundle.failureDelayMs?.(deaf)).toBe(undefined);
    bundle.onFailure?.(deaf);
    expect(h.watchdogInstances[0].recordFailure).toHaveBeenCalledTimes(1);
  });

  // #460, D041: neutral like idle and blocked, but it keeps the backoff, since
  // every such cycle was a real connect to the scale.
  it('poll plan: a session that heard the scale is not counted, and keeps the backoff', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const bundle = await buildReadingSource(makeCtx(), ADAPTERS, 7, 30);
    const heard = tagBleFailure(
      new SessionTimeoutError('Timed out waiting for a complete scale reading', 'idle'),
      'no-reading',
    );

    bundle.onFailure?.(heard);
    expect(h.watchdogInstances[0].recordFailure).not.toHaveBeenCalled();
    expect(bundle.failureDelayMs?.(heard)).toBe(undefined);
    expect(bundle.failureLogPrefixFor?.(heard)).toBe('Scale connected but sent no reading');
  });

  it('poll plan: the idle delay is re-read from config on every call', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const runtime: { scan_cooldown: number; idle_rescan_delay?: number } = {
      scan_cooldown: 5,
      idle_rescan_delay: 2,
    };
    const ctx = makeCtx({
      bleHandler: 'auto',
      config: { users: [{}], scale: {}, runtime } as never,
    });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);
    const idle = tagBleFailure(new Error('Device not found'), 'idle');

    expect(bundle.failureDelayMs?.(idle)).toBe(2_000);
    // 0 is a real setting, not "unset": it must survive the ?? fallback.
    runtime.idle_rescan_delay = 0;
    expect(bundle.failureDelayMs?.(idle)).toBe(0);
    runtime.idle_rescan_delay = 30;
    expect(bundle.failureDelayMs?.(idle)).toBe(30_000);
    // Whole key gone (an older config.yaml) falls back to the schema default.
    delete runtime.idle_rescan_delay;
    expect(bundle.failureDelayMs?.(idle)).toBe(5_000);
  });

  // #475, D064: only a session that heard the scale and then went quiet until
  // its idle timeout gets the floor. Everything else keeps the backoff as it
  // was, including the #471 hold cycle and the #472 stale link.
  it('poll plan: an idle no-reading timeout gets the configured floor; a cap, a silent session, a disconnect and the other kinds do not (#475)', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const ctx = makeCtx({
      config: {
        users: [{}],
        scale: {},
        runtime: { scan_cooldown: 5, idle_rescan_delay: 5, no_reading_rescan_delay: 900 },
      } as never,
    });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);
    const timedOut = (reason: 'idle' | 'cap') =>
      new SessionTimeoutError(
        reason === 'idle'
          ? 'Timed out waiting for a complete scale reading'
          : 'GATT session cap exceeded',
        reason,
      );

    const heardThenQuiet = tagBleFailure(timedOut('idle'), 'no-reading');
    expect(bundle.failureDelayFloor?.(heardThenQuiet)).toEqual({
      ms: 900_000,
      label: 'runtime.no_reading_rescan_delay',
    });
    // The floor is a minimum on the backoff path, not a claim.
    expect(bundle.failureDelayMs?.(heardThenQuiet)).toBe(undefined);

    const notFloored: Array<[string, unknown]> = [
      ['no-reading after the session cap', tagBleFailure(timedOut('cap'), 'no-reading')],
      ['a session that heard nothing', tagBleFailure(timedOut('idle'), 'wedge-suspect')],
      ['an untagged session timeout', timedOut('idle')],
      [
        'a scale that disconnected after a frame',
        tagBleFailure(new Error('Scale disconnected before reading completed'), 'wedge-suspect'),
      ],
      ['a no-reading tag on something else', tagBleFailure(new Error('x'), 'no-reading')],
      ['an idle cycle', tagBleFailure(new Error('Device not found'), 'idle')],
      ['a blocked connect', tagBleFailure(new Error('LE privacy is not active'), 'blocked')],
      [
        'a stale BlueZ link (#472)',
        tagBleFailure(new StaleLinkError('AA:BB:CC:DD:EE:FF'), 'wedge-suspect'),
      ],
      [
        'a held pairing (#471)',
        tagBleFailure(new PairingDeferredError('AA:BB:CC:DD:EE:FF', 120_000), 'idle'),
      ],
      [
        'a held pairing on a deaf radio (#471)',
        tagBleFailure(new PairingDeferredError('AA:BB:CC:DD:EE:FF', 120_000), 'wedge-suspect'),
      ],
      ['an untagged error', new Error('export failed')],
    ];
    for (const [what, err] of notFloored) {
      expect(bundle.failureDelayFloor?.(err), what).toBe(undefined);
    }
  });

  it('poll plan: the floor is re-read from config on every call; 0 and an absent key mean none', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const runtime: { scan_cooldown: number; no_reading_rescan_delay?: number } = {
      scan_cooldown: 5,
      no_reading_rescan_delay: 60,
    };
    const ctx = makeCtx({ config: { users: [{}], scale: {}, runtime } as never });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);
    const heard = tagBleFailure(
      new SessionTimeoutError('Timed out waiting for a complete scale reading', 'idle'),
      'no-reading',
    );

    expect(bundle.failureDelayFloor?.(heard)).toEqual({
      ms: 60_000,
      label: 'runtime.no_reading_rescan_delay',
    });
    runtime.no_reading_rescan_delay = 900;
    expect(bundle.failureDelayFloor?.(heard)?.ms).toBe(900_000);
    runtime.no_reading_rescan_delay = 0;
    expect(bundle.failureDelayFloor?.(heard)).toBe(undefined);
    delete runtime.no_reading_rescan_delay;
    expect(bundle.failureDelayFloor?.(heard)).toBe(undefined);
  });

  it('watcher plan: leaves failureDelayFloor unset', async () => {
    h.createReadingSource.mockResolvedValue(watcherPlan('Error processing ESPHome reading'));
    const ctx = makeCtx({ bleHandler: 'esphome-proxy', esphomeProxy: { host: 'h' } as never });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 10, 30);
    expect(bundle.failureDelayFloor).toBeUndefined();
  });

  it('watcher plan: leaves failureDelayMs unset, so a wedged proxy still backs off', async () => {
    h.createReadingSource.mockResolvedValue(watcherPlan('Error processing ESPHome reading'));
    const ctx = makeCtx({ bleHandler: 'esphome-proxy', esphomeProxy: { host: 'h' } as never });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 10, 30);
    expect(bundle.failureDelayMs).toBeUndefined();
  });

  // #407: buildReadingSource runs once, before the loop, so a captured limit
  // made this option neither hot-swappable nor restart-warned. The reload
  // contract promises one of the two.
  it('watcher plan: the liveness limit is re-read from config on every call', async () => {
    const plan = watcherPlan('Error processing ESPHome reading');
    plan.watcher.nextReading.mockImplementation(() => new Promise(() => {}) as Promise<never>);
    h.createReadingSource.mockResolvedValue(plan);

    const ble: { esphome_proxy: unknown; proxy_liveness_timeout_min?: number } = {
      esphome_proxy: { host: 'h' },
      proxy_liveness_timeout_min: 30,
    };
    const ctx = makeCtx({
      bleHandler: 'esphome-proxy',
      esphomeProxy: ble.esphome_proxy as never,
      config: { users: [{}], scale: {}, runtime: {}, ble } as never,
    });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 10, 30);

    const signal = new AbortController().signal;
    void bundle.source.nextReading(signal).catch(() => {});
    expect(h.raceWithLiveness).toHaveBeenLastCalledWith(plan.watcher, 30 * 60_000, signal);

    ble.proxy_liveness_timeout_min = 5;
    void bundle.source.nextReading(signal).catch(() => {});
    expect(h.raceWithLiveness).toHaveBeenLastCalledWith(plan.watcher, 5 * 60_000, signal);
  });

  it('watchdog trip: sets exit code 1 and aborts the app', async () => {
    h.createReadingSource.mockResolvedValue({ kind: 'poll', appliesGraceFloor: false });
    const ctx = makeCtx({ bleHandler: 'auto' });
    await buildReadingSource(ctx, ADAPTERS, 3, 30);

    const wd = h.watchdogInstances[0];
    wd.onTrip({ consecutiveFailures: 3 });

    expect(process.exitCode).toBe(1);
    expect(ctx.abortApp).toHaveBeenCalledOnce();
  });
});
