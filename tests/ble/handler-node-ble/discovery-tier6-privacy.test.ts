import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The bluetoothd restart tier of startDiscoverySafe and `ble.adapter_privacy`
 * (#417). bluetoothd applies main.conf's Privacy when it starts, which can
 * clear ours, so that tier has to put it back before the fresh adapter is
 * taken. The other tiers power-cycle without touching it on purpose: the flag
 * and the IRK survive a btmgmt or rfkill cycle.
 */

const calls: string[] = [];

vi.mock('../../../src/ble/handler-node-ble/dbus.js', () => ({
  // Every StartDiscovery fails, so the cascade runs down to tier 6.
  helperOf: () => ({
    callMethod: async (name: string) => {
      if (name === 'StartDiscovery') throw new Error('org.bluez.Error.InProgress');
    },
    set: async () => {
      throw new Error('power cycle refused');
    },
  }),
  releaseDeviceProxy: vi.fn(),
  getDbusNext: async () => ({ Variant: class {} }),
}));

const freshAdapter = { isDiscovering: async () => false };

vi.mock('../../../src/ble/handler-node-ble/connection.js', () => ({
  getAdapter: async () => {
    calls.push('getAdapter');
    return freshAdapter;
  },
  resetConnection: () => calls.push('resetConnection'),
  parseHciIndex: () => 0,
  currentConnectionGeneration: () => 0,
}));

vi.mock('../../../src/ble/handler-node-ble/device-object.js', () => ({
  logAdvertisementSnapshot: vi.fn(),
}));

vi.mock('../../../src/ble/handler-node-ble/privacy.js', () => ({
  reensureAdapterPrivacy: async () => {
    calls.push('reensureAdapterPrivacy');
  },
}));

vi.mock('../../../src/ble/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ble/types.js')>();
  return {
    ...actual,
    sleep: async () => {},
    resetAdapterBtmgmt: async () => {
      calls.push('resetAdapterBtmgmt');
      return false;
    },
    resetAdapterRfkill: async () => {
      calls.push('resetAdapterRfkill');
      return false;
    },
    restartBluetoothd: async () => {
      calls.push('restartBluetoothd');
      return true;
    },
  };
});

const { startDiscoverySafe } = await import('../../../src/ble/handler-node-ble/discovery.js');

describe('startDiscoverySafe tier 6 and ble.adapter_privacy (#417)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('re-ensures privacy after restarting bluetoothd, before taking the fresh adapter', async () => {
    await startDiscoverySafe({ isDiscovering: async () => false } as never);
    const restart = calls.indexOf('restartBluetoothd');
    const reensure = calls.indexOf('reensureAdapterPrivacy');
    expect(restart, `no tier 6 in [${calls.join(', ')}]`).toBeGreaterThan(-1);
    expect(reensure).toBeGreaterThan(calls.indexOf('resetConnection', restart));
    expect(calls.indexOf('getAdapter', restart)).toBeGreaterThan(reensure);
  });
});
