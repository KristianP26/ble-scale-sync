import { describe, it, expect } from 'vitest';
import { probeLiveness, type LivenessAdapter } from '../../src/ble/handler-node-ble/liveness.js';

const noSleep = async () => {};

/** Fake adapter that returns a scripted sequence of (addresses, rssi-map) snapshots. */
function fakeAdapter(
  snapshots: Array<{ addrs: string[]; rssi: Record<string, number | undefined> }>,
): LivenessAdapter {
  let call = -1;
  return {
    listAddresses: async () => {
      call++;
      return snapshots[Math.min(call, snapshots.length - 1)].addrs;
    },
    rssiOf: async (addr) => snapshots[Math.min(call, snapshots.length - 1)].rssi[addr],
  };
}

describe('probeLiveness', () => {
  it('reports alive when a new device address appears between samples', async () => {
    const la = fakeAdapter([
      { addrs: ['AA'], rssi: { AA: -50 } },
      { addrs: ['AA', 'BB'], rssi: { AA: -50, BB: -60 } },
    ]);
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(true);
  });

  it('reports alive when a known device RSSI moves between samples', async () => {
    const la = fakeAdapter([
      { addrs: ['AA'], rssi: { AA: -50 } },
      { addrs: ['AA'], rssi: { AA: -55 } },
    ]);
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(true);
  });

  it('reports not-alive when nothing changes (wedged radio)', async () => {
    const la = fakeAdapter([
      { addrs: ['AA', 'BB'], rssi: { AA: -50, BB: -60 } },
      { addrs: ['AA', 'BB'], rssi: { AA: -50, BB: -60 } },
    ]);
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(false);
  });

  it('reports not-alive when the cache is empty both samples', async () => {
    const la = fakeAdapter([
      { addrs: [], rssi: {} },
      { addrs: [], rssi: {} },
    ]);
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(false);
  });

  it('does not treat undefined->number or number->undefined RSSI as movement', async () => {
    const la = fakeAdapter([
      { addrs: ['AA'], rssi: { AA: undefined } },
      { addrs: ['AA'], rssi: { AA: -50 } },
    ]);
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(false);
  });

  it('returns not-alive when enumeration throws', async () => {
    const la: LivenessAdapter = {
      listAddresses: async () => {
        throw new Error('dbus down');
      },
      rssiOf: async () => undefined,
    };
    expect(await probeLiveness(la, { sleep: noSleep })).toBe(false);
  });
});
