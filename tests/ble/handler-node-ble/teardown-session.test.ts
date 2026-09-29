import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

vi.mock('../../../src/ble/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/types.js')>();
  return {
    ...actual,
    // The 500 ms settle before the D-Bus reset is not the subject here.
    sleep: async () => {},
    resetAdapterBtmgmt: h.resetAdapterBtmgmt,
  };
});
vi.mock('../../../src/ble/handler-node-ble/connection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/connection.js')>();
  // parseHciIndex stays real, so a wrong adapter index is caught too.
  return { ...actual, resetConnection: h.resetConnection };
});
vi.mock('../../../src/ble/handler-node-ble/discovery.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/discovery.js')>();
  return { ...actual, removeDevice: h.removeDevice, notifyDiscoveryStopped: () => {} };
});

const { teardownSession, _resetPreemptiveSkipNotice } =
  await import('../../../src/ble/handler-node-ble/scan-stages.js');
const { bleLog } = await import('../../../src/ble/types.js');

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
