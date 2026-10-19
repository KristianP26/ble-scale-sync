import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

/**
 * `ble.preemptive_adapter_reset` (#417). teardownSession power-cycles the HCI
 * controller after every GATT session to clear the Broadcom zombie-discovery
 * state (#80). A BF915 owner measured that power-cycle as the only host-side
 * event between a bonded session that works and a next connect whose stored
 * key is rejected, so it has to be possible to switch off, and switching it off
 * must not take anything else with it.
 */

const calls: string[] = [];

const h = vi.hoisted(() => ({
  resetAdapterBtmgmt: vi.fn(),
  resetConnection: vi.fn(),
  removeDevice: vi.fn(),
  callMethod: vi.fn(),
  getAdapter: vi.fn(),
  getDevice: vi.fn(),
  /** Runs inside the 500 ms settle, which is otherwise skipped. */
  onSleep: undefined as (() => void) | undefined,
}));

vi.mock('../../../src/ble/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/types.js')>();
  return {
    ...actual,
    // The 500 ms settle before the D-Bus reset is not the subject here.
    sleep: async () => {
      h.onSleep?.();
    },
    resetAdapterBtmgmt: h.resetAdapterBtmgmt,
  };
});
vi.mock('../../../src/ble/handler-node-ble/connection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/connection.js')>();
  // parseHciIndex stays real, so a wrong adapter index is caught too.
  return { ...actual, resetConnection: h.resetConnection, getAdapter: h.getAdapter };
});
vi.mock('../../../src/ble/handler-node-ble/discovery.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/discovery.js')>();
  return { ...actual, removeDevice: h.removeDevice, notifyDiscoveryStopped: () => {} };
});

const { teardownSession, _resetPreemptiveSkipNotice } =
  await import('../../../src/ble/handler-node-ble/scan-stages.js');
const { bleLog } = await import('../../../src/ble/types.js');
const { _resetStaleLinkStateForTests } =
  await import('../../../src/ble/handler-node-ble/stale-link.js');

/** A BlueZ adapter stub whose only reachable surface is helper.callMethod. */
const btAdapter = { helper: { callMethod: h.callMethod } } as never;

type TeardownOpts = Parameters<typeof teardownSession>[0];

function gattCycle(overrides: Partial<TeardownOpts> = {}): TeardownOpts {
  return {
    device: null,
    btAdapter,
    deviceMac: 'AA:BB:CC:DD:EE:FF',
    bleAdapter: 'hci1',
    gattAttempted: true,
    gattSucceeded: true,
    ...overrides,
  };
}

describe('teardownSession preemptive power-cycle (#417)', () => {
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    h.resetConnection.mockImplementation(() => calls.push('resetConnection'));
    h.resetAdapterBtmgmt.mockImplementation(async () => {
      calls.push('resetAdapterBtmgmt');
      return true;
    });
    h.callMethod.mockImplementation(async (name: string) => {
      calls.push(name);
    });
    h.removeDevice.mockImplementation(async () => {
      calls.push('removeDevice');
    });
    debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
  });

  it('power-cycles the configured adapter when the option is unset', async () => {
    await teardownSession(gattCycle());
    expect(calls).toEqual(['resetConnection', 'resetAdapterBtmgmt']);
    expect(h.resetAdapterBtmgmt).toHaveBeenCalledWith(1);
  });

  it('power-cycles when the option is true', async () => {
    await teardownSession(gattCycle({ preemptiveAdapterReset: true }));
    expect(calls).toEqual(['resetConnection', 'resetAdapterBtmgmt']);
  });

  it('skips only the power-cycle when the option is false, and says so', async () => {
    await teardownSession(gattCycle({ preemptiveAdapterReset: false }));
    expect(calls).toEqual(['resetConnection']);
    expect(h.resetAdapterBtmgmt).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('ble.preemptive_adapter_reset: false'),
    );
  });

  it('says once at info that the power-cycle is off, so it shows without DEBUG', async () => {
    _resetPreemptiveSkipNotice();
    const info = vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    await teardownSession(gattCycle({ preemptiveAdapterReset: false }));
    await teardownSession(gattCycle({ preemptiveAdapterReset: false }));
    const lines = info.mock.calls.filter(([m]) => String(m).includes('preemptive_adapter_reset'));
    expect(lines).toHaveLength(1);
    info.mockRestore();
  });

  it('keeps the failed-GATT cleanup when the option is false', async () => {
    await teardownSession(gattCycle({ preemptiveAdapterReset: false, gattSucceeded: false }));
    expect(calls).toEqual(['StopDiscovery', 'removeDevice', 'resetConnection']);
  });

  it('never power-cycles during a shutdown, even when the option is true', async () => {
    const ac = new AbortController();
    ac.abort();
    await teardownSession(gattCycle({ preemptiveAdapterReset: true, abortSignal: ac.signal }));
    expect(calls).toEqual(['resetConnection']);
  });

  it('touches neither the D-Bus connection nor the adapter after an idle cycle', async () => {
    await teardownSession(gattCycle({ gattAttempted: false, gattSucceeded: false }));
    expect(calls).toEqual([]);
  });
});

/** Settles to the state of `p` without ever throwing out of the test. */
function track(p: Promise<unknown>): { state: () => 'pending' | 'resolved' | 'rejected' } {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  p.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  );
  return { state: () => state };
}

/**
 * #472. BlueZ answers a Disconnect for a device it lists as connected only once
 * that connection is gone. When it never is, the teardown used to park on its
 * very first await, so it never released the proxy, never reset the D-Bus
 * connection and never reached the power-cycle that would have cleared the
 * state, and every later cycle parked on the same Disconnect.
 */
describe('teardownSession and a Disconnect BlueZ never answers (#472)', () => {
  const hung = () => ({
    disconnect: vi.fn(() => new Promise<void>(() => {})),
    helper: { removeListeners: vi.fn() },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetStaleLinkStateForTests();
    h.onSleep = undefined;
    calls.length = 0;
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    h.resetConnection.mockImplementation(() => calls.push('resetConnection'));
    h.resetAdapterBtmgmt.mockImplementation(async () => {
      calls.push('resetAdapterBtmgmt');
      return true;
    });
    h.callMethod.mockImplementation(async (name: string) => {
      calls.push(name);
    });
    h.removeDevice.mockImplementation(async () => {
      calls.push('removeDevice');
      return 'removed';
    });
    // The check after the power-cycle: BlueZ no longer lists the scale as
    // connected.
    h.getDevice.mockImplementation(async () => ({
      helper: {
        prop: async (name: string) => (name === 'Connected' ? false : undefined),
        removeListeners: () => {},
      },
    }));
    h.getAdapter.mockImplementation(async () => ({ getDevice: h.getDevice }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('finishes, releases the proxy, resets the connection and power-cycles once', async () => {
    const device = hung();
    const result = track(
      teardownSession(gattCycle({ device: device as never, gattSucceeded: false })),
    );

    await vi.advanceTimersByTimeAsync(15_000);

    expect(result.state()).toBe('resolved');
    expect(device.helper.removeListeners).toHaveBeenCalled();
    expect(h.resetConnection).toHaveBeenCalled();
    // The recovery's power-cycle replaces the preemptive one, never both.
    expect(h.resetAdapterBtmgmt).toHaveBeenCalledTimes(1);
    expect(h.resetAdapterBtmgmt).toHaveBeenCalledWith(1);
  });

  it('still power-cycles once with preemptive_adapter_reset false when the Disconnect timed out', async () => {
    const device = hung();
    const result = track(
      teardownSession(gattCycle({ device: device as never, preemptiveAdapterReset: false })),
    );

    await vi.advanceTimersByTimeAsync(15_000);

    expect(result.state()).toBe('resolved');
    expect(h.resetAdapterBtmgmt).toHaveBeenCalledTimes(1);
    // And checked afterwards that BlueZ let go of the scale.
    expect(h.getDevice).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF');
  });

  it('sends the Disconnect and returns at once on an aborted cycle', async () => {
    // A shutdown during a connect leaves the pending Connect to this
    // Disconnect, which cancels it in BlueZ, so it has to go out even though
    // nobody waits for its answer.
    const ac = new AbortController();
    ac.abort();
    const device = hung();
    const result = track(
      teardownSession(gattCycle({ device: device as never, abortSignal: ac.signal })),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(result.state()).toBe('resolved');
    expect(device.disconnect).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['resetConnection']);
    expect(h.resetAdapterBtmgmt).not.toHaveBeenCalled();
  });

  it('stands down before the recovery when a newer cycle starts during the settle (A-04)', async () => {
    // The newer cycle owns the D-Bus connection and the controller by then; a
    // power-cycle here would land in the middle of its scan.
    let superseded = false;
    h.onSleep = () => (superseded = true);
    const device = hung();
    const result = track(
      teardownSession(gattCycle({ device: device as never, isSuperseded: () => superseded })),
    );

    await vi.advanceTimersByTimeAsync(15_000);

    expect(result.state()).toBe('resolved');
    expect(device.helper.removeListeners).toHaveBeenCalled();
    expect(h.resetConnection).not.toHaveBeenCalled();
    expect(h.resetAdapterBtmgmt).not.toHaveBeenCalled();
    expect(h.getAdapter).not.toHaveBeenCalled();
  });

  it('skips the RemoveDevice when the cycle already knows the link is stale', async () => {
    // BlueZ would queue it behind the same unanswered Disconnect.
    const device = hung();
    const result = track(
      teardownSession(
        gattCycle({ device: device as never, gattSucceeded: false, staleLink: true }),
      ),
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(result.state()).toBe('resolved');
    expect(device.disconnect).not.toHaveBeenCalled();
    expect(calls).toEqual(['StopDiscovery', 'resetConnection', 'resetAdapterBtmgmt']);
  });

  it('drops the D-Bus connection on an idle cycle while the brake holds the recovery back', async () => {
    // A first recovery that did not clear the link arms the brake.
    h.getDevice.mockImplementation(async () => ({
      helper: { prop: async () => true, removeListeners: () => {} },
    }));
    vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
    const first = track(
      teardownSession(gattCycle({ device: hung() as never, gattAttempted: false })),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first.state()).toBe('resolved');
    expect(h.resetAdapterBtmgmt).toHaveBeenCalledTimes(1);

    calls.length = 0;
    const second = track(
      teardownSession(
        gattCycle({ device: hung() as never, gattAttempted: false, gattSucceeded: false }),
      ),
    );
    await vi.advanceTimersByTimeAsync(15_000);

    expect(second.state()).toBe('resolved');
    expect(calls).toEqual(['resetConnection']);
  });

  it.each([
    [true, ['StopDiscovery', 'resetConnection', 'resetAdapterBtmgmt']],
    [false, ['StopDiscovery', 'resetConnection']],
  ])(
    'ends a GATT cycle the brake holds back as before (preemptive_adapter_reset %s)',
    async (preemptiveAdapterReset, expected) => {
      // The brake holds back only the recovery: a GATT session still gets the
      // settle, the D-Bus reset and, with the option on, the preemptive
      // power-cycle, as the docs promise.
      h.getDevice.mockImplementation(async () => ({
        helper: { prop: async () => true, removeListeners: () => {} },
      }));
      vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const first = track(
        teardownSession(gattCycle({ device: hung() as never, gattAttempted: false })),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(first.state()).toBe('resolved');

      calls.length = 0;
      let settled = false;
      h.onSleep = () => (settled = true);
      const second = track(
        teardownSession(
          gattCycle({ device: hung() as never, gattSucceeded: false, preemptiveAdapterReset }),
        ),
      );
      await vi.advanceTimersByTimeAsync(15_000);

      expect(second.state()).toBe('resolved');
      expect(settled).toBe(true);
      // RemoveDevice is skipped: the cycle knows the link is stale.
      expect(calls).toEqual(expected);
    },
  );

  it('recovers a stale link found by a cycle without a GATT attempt', async () => {
    // A broadcast or idle cycle that found the scale disconnects it too, and
    // the same stuck Disconnect parks it there.
    const device = hung();
    const result = track(
      teardownSession(
        gattCycle({ device: device as never, gattAttempted: false, gattSucceeded: false }),
      ),
    );

    await vi.advanceTimersByTimeAsync(15_000);

    expect(result.state()).toBe('resolved');
    expect(device.helper.removeListeners).toHaveBeenCalled();
    expect(h.resetConnection).toHaveBeenCalled();
    expect(h.resetAdapterBtmgmt).toHaveBeenCalledTimes(1);
  });
});

describe('teardownSession and a RemoveDevice BlueZ never answers (#472)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetStaleLinkStateForTests();
    h.onSleep = undefined;
    calls.length = 0;
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    h.resetConnection.mockImplementation(() => calls.push('resetConnection'));
    h.resetAdapterBtmgmt.mockImplementation(async () => {
      calls.push('resetAdapterBtmgmt');
      return true;
    });
    h.callMethod.mockImplementation(async (name: string) => {
      calls.push(name);
    });
    h.getDevice.mockImplementation(async () => {
      throw new Error('Device not found');
    });
    h.getAdapter.mockImplementation(async () => ({ getDevice: h.getDevice }));
  });

  it('takes it as the same evidence as an unanswered Disconnect', async () => {
    // BlueZ queues a RemoveDevice for a connected device behind the same
    // disconnect, so a timeout here is the stuck link seen from another call.
    h.removeDevice.mockImplementation(async () => {
      calls.push('removeDevice');
      return 'timeout';
    });
    const device = { disconnect: vi.fn(async () => {}), helper: { removeListeners: vi.fn() } };
    await teardownSession(
      gattCycle({ device: device as never, gattSucceeded: false, preemptiveAdapterReset: false }),
    );
    expect(calls).toEqual([
      'StopDiscovery',
      'removeDevice',
      'resetConnection',
      'resetAdapterBtmgmt',
    ]);
    expect(h.getDevice).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF');
  });
});

/**
 * #472, the other direction: the recovery power-cycles the adapter even with
 * `ble.preemptive_adapter_reset: false` and on cycles that never ran GATT, so
 * it must take an unanswered call as its only evidence. A Disconnect BlueZ
 * answers, with success or with an error such as NotConnected, has to leave
 * every teardown exactly as it was before #472.
 */
describe('teardownSession and a Disconnect BlueZ answers (#472)', () => {
  const answering = {
    ok: () => ({
      disconnect: vi.fn(async () => {}),
      helper: { removeListeners: vi.fn() },
    }),
    'NotConnected error': () => ({
      disconnect: vi.fn(async () => {
        throw new Error('org.bluez.Error.NotConnected');
      }),
      helper: { removeListeners: vi.fn() },
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStaleLinkStateForTests();
    h.onSleep = undefined;
    calls.length = 0;
    vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
    vi.spyOn(bleLog, 'info').mockImplementation(() => {});
    h.resetConnection.mockImplementation(() => calls.push('resetConnection'));
    h.resetAdapterBtmgmt.mockImplementation(async () => {
      calls.push('resetAdapterBtmgmt');
      return true;
    });
    h.callMethod.mockImplementation(async (name: string) => {
      calls.push(name);
    });
    h.getAdapter.mockImplementation(async () => {
      calls.push('getAdapter');
      return { getDevice: h.getDevice };
    });
  });

  describe.each(Object.entries(answering))('answered: %s', (_label, make) => {
    it('a GATT session keeps the preemptive power-cycle, once', async () => {
      const device = make();
      await teardownSession(gattCycle({ device: device as never }));
      expect(device.disconnect).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(['resetConnection', 'resetAdapterBtmgmt']);
    });

    it('a GATT session with preemptive_adapter_reset false is not power-cycled', async () => {
      const device = make();
      await teardownSession(gattCycle({ device: device as never, preemptiveAdapterReset: false }));
      expect(calls).toEqual(['resetConnection']);
    });

    it('an idle or broadcast cycle touches neither the connection nor the adapter', async () => {
      const device = make();
      await teardownSession(
        gattCycle({ device: device as never, gattAttempted: false, gattSucceeded: false }),
      );
      expect(calls).toEqual([]);
      expect(device.helper.removeListeners).toHaveBeenCalled();
    });

    it.each(['removed', 'skipped'])(
      'a failed GATT session whose RemoveDevice was %s keeps the usual cleanup',
      async (outcome) => {
        h.removeDevice.mockImplementation(async () => {
          calls.push('removeDevice');
          return outcome;
        });
        const device = make();
        await teardownSession(
          gattCycle({
            device: device as never,
            gattSucceeded: false,
            preemptiveAdapterReset: false,
          }),
        );
        expect(calls).toEqual(['StopDiscovery', 'removeDevice', 'resetConnection']);
      },
    );
  });
});
