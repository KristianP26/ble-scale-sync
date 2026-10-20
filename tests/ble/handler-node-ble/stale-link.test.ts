import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const h = vi.hoisted(() => ({
  resetAdapterBtmgmt: vi.fn(),
  getAdapter: vi.fn(),
  powerCycleViaDbus: vi.fn(),
}));

vi.mock('../../../src/ble/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/types.js')>();
  return { ...actual, resetAdapterBtmgmt: h.resetAdapterBtmgmt };
});
vi.mock('../../../src/ble/handler-node-ble/connection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/connection.js')>();
  // parseHciIndex stays real, so a wrong adapter index is caught too.
  return { ...actual, getAdapter: h.getAdapter };
});
vi.mock('../../../src/ble/handler-node-ble/discovery.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/discovery.js')>();
  return { ...actual, powerCycleViaDbus: h.powerCycleViaDbus };
});

const {
  disconnectBounded,
  recoverStaleLink,
  staleLinkRecoveryDue,
  noteReadingForStaleLink,
  _resetStaleLinkStateForTests,
} = await import('../../../src/ble/handler-node-ble/stale-link.js');
const { bleLog } = await import('../../../src/ble/types.js');

const MAC = 'AA:BB:CC:DD:EE:FF';
const MIN = 60_000;

/** BlueZ answers the check after the power-cycle with this `Connected`. */
function bluezReports(connected: boolean) {
  const removeListeners = vi.fn();
  const getDevice = vi.fn(async () => ({
    helper: {
      prop: async (name: string) => (name === 'Connected' ? connected : undefined),
      removeListeners,
    },
  }));
  h.getAdapter.mockImplementation(async () => ({ getDevice }));
  return { getDevice, removeListeners };
}

const recover = (abortSignal?: AbortSignal) =>
  recoverStaleLink({ mac: MAC, bleAdapter: 'hci1', abortSignal });

describe('recoverStaleLink (#472)', () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetStaleLinkStateForTests();
    h.resetAdapterBtmgmt.mockResolvedValue(true);
    h.powerCycleViaDbus.mockResolvedValue(true);
    info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('power-cycles the configured adapter and says so once the scale is no longer connected', async () => {
    const { getDevice, removeListeners } = bluezReports(false);
    await recover();
    expect(h.resetAdapterBtmgmt).toHaveBeenCalledWith(1);
    expect(h.powerCycleViaDbus).not.toHaveBeenCalled();
    expect(getDevice).toHaveBeenCalledWith(MAC);
    expect(removeListeners).toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      `Cleared a stale BlueZ connection to ${MAC} by power-cycling hci1`,
    );
    expect(staleLinkRecoveryDue(MAC)).toBe(true);
  });

  it('falls back to Powered off/on through BlueZ when btmgmt cannot run', async () => {
    h.resetAdapterBtmgmt.mockResolvedValue(false);
    bluezReports(false);
    await recover();
    expect(h.powerCycleViaDbus).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      `Cleared a stale BlueZ connection to ${MAC} through BlueZ (Powered off/on)`,
    );
  });

  it('warns once per process when BlueZ still lists the scale as connected, and backs off', async () => {
    bluezReports(true);
    await recover();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('sudo systemctl restart bluetooth');
    expect(staleLinkRecoveryDue(MAC)).toBe(false);

    vi.advanceTimersByTime(10 * MIN);
    expect(staleLinkRecoveryDue(MAC)).toBe(true);
    await recover();
    // The second time at debug only.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining(`BlueZ still reports ${MAC}`));
  });

  it('backs off 10, 20, 40 and then 60 minutes at most', async () => {
    bluezReports(true);
    for (const minutes of [10, 20, 40, 60, 60]) {
      await recover();
      vi.advanceTimersByTime(minutes * MIN - 1);
      expect(staleLinkRecoveryDue(MAC), `${minutes} min`).toBe(false);
      vi.advanceTimersByTime(1);
      expect(staleLinkRecoveryDue(MAC), `${minutes} min`).toBe(true);
    }
    expect(debug).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Stale BlueZ link recovery for AA:BB:CC:DD:EE:FF skipped: the last attempt \d+ min ago/,
      ),
    );
  });

  it('lifts the brake on a reading or on a check that comes back clean', async () => {
    bluezReports(true);
    await recover();
    expect(staleLinkRecoveryDue(MAC)).toBe(false);
    noteReadingForStaleLink(MAC);
    expect(staleLinkRecoveryDue(MAC)).toBe(true);

    await recover();
    await recover();
    vi.advanceTimersByTime(20 * MIN);
    bluezReports(false);
    await recover();
    // Back to the start: one more failure holds it 10 minutes, not 40.
    bluezReports(true);
    await recover();
    vi.advanceTimersByTime(10 * MIN);
    expect(staleLinkRecoveryDue(MAC)).toBe(true);
  });

  it('keeps a brake per scale, lifted only by a reading from that scale', async () => {
    // Two scales in auto-discovery: a reading from the one that works must not
    // let the stuck one power-cycle the adapter on every cycle again.
    const OTHER = '11:22:33:44:55:66';
    bluezReports(true);
    await recover();
    expect(staleLinkRecoveryDue(MAC)).toBe(false);
    expect(staleLinkRecoveryDue(OTHER)).toBe(true);

    noteReadingForStaleLink(OTHER);
    expect(staleLinkRecoveryDue(MAC)).toBe(false);

    // Any spelling of the same address.
    noteReadingForStaleLink('aa-bb-cc-dd-ee-ff');
    expect(staleLinkRecoveryDue(MAC)).toBe(true);
  });

  it('bounds the whole check, and releases a proxy that comes back late', async () => {
    const removeListeners = vi.fn();
    // Never answers: only the release of an abandoned proxy can hand it back,
    // not the finally of a read that completed.
    const prop = vi.fn(() => new Promise(() => {}));
    const late = { helper: { prop, removeListeners } };
    // getAdapter answers only after the deadline.
    h.getAdapter.mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ getDevice: async () => late }), 15_000)),
    );
    let done = false;
    void recover().then(() => (done = true));

    await vi.advanceTimersByTimeAsync(10_001);
    expect(done).toBe(true);
    expect(debug).toHaveBeenCalledWith(
      `Could not check ${MAC} after the adapter power-cycle: no answer within 10s`,
    );
    // Not knowing counts as not cleared.
    expect(staleLinkRecoveryDue(MAC)).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(removeListeners).toHaveBeenCalled();
    // Nobody waits for the answer any more, so it is not even asked.
    expect(prop).not.toHaveBeenCalled();
  });

  it('releases the proxy whose Connected read is still out at the deadline', async () => {
    const removeListeners = vi.fn();
    h.getAdapter.mockImplementation(async () => ({
      getDevice: async () => ({
        helper: { prop: () => new Promise(() => {}), removeListeners },
      }),
    }));
    let done = false;
    void recover().then(() => (done = true));

    await vi.advanceTimersByTimeAsync(10_001);

    expect(done).toBe(true);
    expect(removeListeners).toHaveBeenCalled();
  });

  it('stops the check when a shutdown arrives during it, and leaves the brake alone', async () => {
    // bluetoothd's main loop hangs: the check would otherwise take its whole
    // 10 s, twice the 5 s grace a shutdown has.
    const ac = new AbortController();
    const removeListeners = vi.fn();
    h.getAdapter.mockImplementation(async () => ({
      getDevice: async () => ({
        helper: { prop: () => new Promise(() => {}), removeListeners },
      }),
    }));
    let done = false;
    void recover(ac.signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);

    ac.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(done).toBe(true);
    expect(removeListeners).toHaveBeenCalled();
    expect(staleLinkRecoveryDue(MAC)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips the check when a shutdown arrives during the power-cycle', async () => {
    const ac = new AbortController();
    h.resetAdapterBtmgmt.mockImplementation(async () => {
      ac.abort();
      return true;
    });
    bluezReports(false);
    await recover(ac.signal);
    expect(h.resetAdapterBtmgmt).toHaveBeenCalledTimes(1);
    expect(h.getAdapter).not.toHaveBeenCalled();
  });

  it('bounds the adapter lookup for the BlueZ power-cycle too', async () => {
    h.resetAdapterBtmgmt.mockResolvedValue(false);
    h.getAdapter.mockImplementation(() => new Promise(() => {}));
    let done = false;
    void recover().then(() => (done = true));

    await vi.advanceTimersByTimeAsync(10_001);

    expect(done).toBe(true);
    expect(h.powerCycleViaDbus).not.toHaveBeenCalled();
    expect(staleLinkRecoveryDue(MAC)).toBe(false);
  });

  it('does nothing on an aborted cycle', async () => {
    const ac = new AbortController();
    ac.abort();
    bluezReports(false);
    await recover(ac.signal);
    expect(h.resetAdapterBtmgmt).not.toHaveBeenCalled();
    expect(h.getAdapter).not.toHaveBeenCalled();
  });

  it('backs off without a check when the adapter could not be power-cycled', async () => {
    h.resetAdapterBtmgmt.mockResolvedValue(false);
    h.powerCycleViaDbus.mockResolvedValue(false);
    const { getDevice } = bluezReports(false);
    await recover();
    expect(getDevice).not.toHaveBeenCalled();
    expect(staleLinkRecoveryDue(MAC)).toBe(false);
  });
});

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

  it('does not log a call failed by a closing D-Bus connection as an answer from BlueZ', async () => {
    // The stale-link recovery leaves its unanswered Disconnect on the connection
    // it resets, and connection.ts fails it once that connection closes. Logged
    // as "answered", the reset time would pass for how long BlueZ took.
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    let fail!: (err: Error) => void;
    const parked = {
      disconnect: vi.fn(() => new Promise<void>((_r, reject) => (fail = reject))),
    };
    void disconnectBounded(parked as never, { mac: MAC, label: 'teardown' });
    await vi.advanceTimersByTimeAsync(12_000);
    fail(
      Object.assign(new Error('D-Bus connection closed'), {
        type: 'org.freedesktop.DBus.Error.Disconnected',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const lines = debug.mock.calls.map(([m]) => String(m));
    expect(lines.some((l) => l.startsWith('Disconnect (teardown) got no answer before'))).toBe(
      true,
    );
    expect(lines.some((l) => l.startsWith('Disconnect (teardown) answered'))).toBe(false);
  });

  it('does not log a write refused by a closed stream as an answer from BlueZ', async () => {
    // After our own resetConnection() ends the stream and before the daemon
    // closes its side, dbus-next refuses the write at once, with no D-Bus name.
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const refused = {
      disconnect: vi.fn(async () => {
        throw new Error('Cannot send message, stream is closed');
      }),
    };
    await expect(
      disconnectBounded(refused as never, { mac: MAC, label: 'teardown' }),
    ).resolves.toBe('done');
    const lines = debug.mock.calls.map(([m]) => String(m));
    expect(lines).toContain(
      'Disconnect (teardown) was not sent: the D-Bus connection was already closed',
    );
    expect(lines.some((l) => l.startsWith('Disconnect (teardown) answered'))).toBe(false);
  });

  it('logs a Disconnect written after the daemon closed the connection as not sent', async () => {
    // dbus-next turns a write after the `end` into an `error`, and connection.ts
    // fails the call it parked with its own not-sent text. "got no answer
    // before the D-Bus connection closed, after 0 ms" would be wrong twice.
    const { CALL_NOT_SENT_TEXT } = await import('../../../src/ble/handler-node-ble/connection.js');
    const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    const late = {
      disconnect: vi.fn(async () => {
        throw Object.assign(new Error(CALL_NOT_SENT_TEXT), {
          type: 'org.freedesktop.DBus.Error.Disconnected',
        });
      }),
    };
    await expect(disconnectBounded(late as never, { mac: MAC, label: 'teardown' })).resolves.toBe(
      'done',
    );
    const lines = debug.mock.calls.map(([m]) => String(m));
    expect(lines).toContain(
      'Disconnect (teardown) was not sent: the D-Bus connection was already closed',
    );
    expect(lines.some((l) => l.includes('got no answer'))).toBe(false);
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

  it('takes its abort listener off again when BlueZ answers or the deadline passes', async () => {
    for (const disconnect of [async () => undefined, () => new Promise<void>(() => {})]) {
      const ac = new AbortController();
      const added = vi.spyOn(ac.signal, 'addEventListener');
      const removed = vi.spyOn(ac.signal, 'removeEventListener');
      const outcome = disconnectBounded({ disconnect: vi.fn(disconnect) } as never, {
        mac: MAC,
        label: 't',
        abortSignal: ac.signal,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(['done', 'timeout']).toContain(await outcome);
      expect(added).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0][1]);
    }
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
