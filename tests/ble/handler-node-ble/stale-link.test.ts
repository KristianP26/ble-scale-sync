import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { disconnectBounded, _resetStaleLinkStateForTests } =
  await import('../../../src/ble/handler-node-ble/stale-link.js');
const { bleLog } = await import('../../../src/ble/types.js');

const MAC = 'AA:BB:CC:DD:EE:FF';

describe('disconnectBounded (#472)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetStaleLinkStateForTests();
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports an answered Disconnect, an error answer included, and leaves no timer behind', async () => {
    const answered = { disconnect: vi.fn(async () => undefined) };
    await expect(disconnectBounded(answered as never, { mac: MAC, label: 't' })).resolves.toBe(
      'done',
    );
    const refused = {
      disconnect: vi.fn(async () => {
        throw new Error('org.bluez.Error.NotConnected');
      }),
    };
    await expect(disconnectBounded(refused as never, { mac: MAC, label: 't' })).resolves.toBe(
      'done',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after 10 s on a timer that does not hold the process open', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const timers: { hasRef(): boolean }[] = [];
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const t = realSetTimeout(...args);
      timers.push(t as unknown as { hasRef(): boolean });
      return t;
    }) as typeof setTimeout);
    let late!: (err: Error) => void;
    const hung = {
      disconnect: vi.fn(() => new Promise<void>((_r, reject) => (late = reject))),
    };
    let outcome: string | undefined;
    void disconnectBounded(hung as never, { mac: MAC, label: 't' }).then((o) => (outcome = o));
    spy.mockRestore();

    expect(timers).toHaveLength(1);
    expect(timers[0].hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('timeout');
    // A late error is handled, not an unhandled rejection.
    late(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('sends the Disconnect on an already aborted signal and returns at once', async () => {
    const ac = new AbortController();
    ac.abort();
    const hung = { disconnect: vi.fn(() => new Promise<void>(() => {})) };
    await expect(
      disconnectBounded(hung as never, { mac: MAC, label: 't', abortSignal: ac.signal }),
    ).resolves.toBe('aborted');
    expect(hung.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops waiting when the signal aborts during the wait', async () => {
    const ac = new AbortController();
    const hung = { disconnect: vi.fn(() => new Promise<void>(() => {})) };
    let outcome: string | undefined;
    void disconnectBounded(hung as never, { mac: MAC, label: 't', abortSignal: ac.signal }).then(
      (o) => (outcome = o),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
  });
});
