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
    resolveUserProfile: vi.fn(() => ({ __profile: 'sentinel' })),
    abortableSleep: vi.fn(async () => undefined),
  };
});

vi.mock('../../src/ble/index.js', () => ({ createReadingSource: h.createReadingSource }));
vi.mock('../../src/runtime/poll-source.js', () => ({ PollReadingSource: h.FakePollSource }));
vi.mock('../../src/ble/watchdog.js', () => ({ ConsecutiveFailureWatchdog: h.FakeWatchdog }));
vi.mock('../../src/config/resolve.js', () => ({ resolveUserProfile: h.resolveUserProfile }));
vi.mock('../../src/ble/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ble/types.js')>();
  return { ...actual, abortableSleep: h.abortableSleep };
});

const { buildReadingSource } = await import('../../src/runtime/sources.js');
const { POST_DISCONNECT_GRACE_MS } = await import('../../src/ble/types.js');
import type { AppContext } from '../../src/runtime/context.js';
import type { ScaleAdapter } from '../../src/interfaces/scale-adapter.js';

const ADAPTERS = [{ name: 'A' }] as unknown as ScaleAdapter[];

function makeCtx(overrides: Partial<AppContext> = {}): AppContext {
  return {
    bleHandler: 'auto',
    mqttProxy: undefined,
    esphomeProxy: undefined,
    scaleMac: 'AA:BB:CC:DD:EE:FF',
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
      profile: { __profile: 'sentinel' },
      scaleAuth: { pin: 1234, userIndex: 2 },
    });
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
      profile: { __profile: 'sentinel' },
      scaleAuth: { pin: 1234, userIndex: 2 },
    });
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
