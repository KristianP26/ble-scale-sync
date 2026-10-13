import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Device } from '../../../src/ble/handler-node-ble/dbus.js';
import type { ScaleAdapter } from '../../../src/interfaces/scale-adapter.js';

/**
 * #408: a scale that keeps a single Just Works bond (A&D UC-352BLE). Only for
 * such an adapter does ensureBonded take the BlueZ default-agent role without a
 * PIN and check that the pairing was stored as a bond. Every other adapter
 * must see exactly the calls it saw before.
 *
 * The real agent module runs against a fake bus, so what is asserted is the
 * D-Bus traffic itself: RequestDefaultAgent, Pair, and the Bonded read.
 */

const wire: string[] = [];

const manager = {
  RegisterAgent: vi.fn(async () => {
    wire.push('RegisterAgent');
  }),
  RequestDefaultAgent: vi.fn(async () => {
    wire.push('RequestDefaultAgent');
  }),
};
const bus = {
  export: vi.fn(),
  unexport: vi.fn(),
  getProxyObject: vi.fn(async () => ({ getInterface: () => manager })),
};

vi.mock('../../../src/ble/handler-node-ble/connection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/connection.js')>();
  return { ...actual, getBus: () => bus };
});

const { ensureBonded, acquireGattServer, _resetNotBondedWarningForTests } =
  await import('../../../src/ble/handler-node-ble/scan.js');
const { forgetPairingAgent, setPairingTarget } =
  await import('../../../src/ble/handler-node-ble/agent.js');
const { bleLog } = await import('../../../src/ble/types.js');

const MAC = '5C:31:3E:01:16:6D';

function fakeDevice(opts: { paired: boolean; bonded?: boolean | 'missing' }) {
  const props: string[] = [];
  const device = {
    isPaired: async () => opts.paired,
    pair: vi.fn(async () => {
      wire.push('Pair');
    }),
    helper: {
      prop: vi.fn(async (name: string) => {
        props.push(name);
        if (opts.bonded === 'missing') {
          throw new Error('org.freedesktop.DBus.Error.InvalidArgs: No such property');
        }
        return opts.bonded;
      }),
      set: vi.fn(async () => {}),
      callMethod: vi.fn(async () => {}),
    },
  } as unknown as Device & { pair: ReturnType<typeof vi.fn> };
  return { device, props };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  wire.length = 0;
  vi.clearAllMocks();
  forgetPairingAgent();
  _resetNotBondedWarningForTests();
  // No PIN: the A&D pairs Just Works, and a Beurer SIG scale may run without one.
  setPairingTarget(() => ({ mac: MAC }));
  warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
  vi.spyOn(bleLog, 'info').mockImplementation(() => {});
  vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
});

const bondedWarnings = (): string[] =>
  warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('did not store'));

describe('ensureBonded for a single-bond scale (#408)', () => {
  it('takes the default-agent role before Pair() when the scale is not paired', async () => {
    const { device } = fakeDevice({ paired: false, bonded: true });
    await ensureBonded(device, undefined, undefined, { forPairing: true });
    expect(wire).toEqual(['RegisterAgent', 'RequestDefaultAgent', 'Pair']);
  });

  // Guard: a Beurer SIG scale without beurer_pin sees today's traffic.
  it('leaves the role alone and reads no Bonded without the option', async () => {
    const { device, props } = fakeDevice({ paired: false, bonded: false });
    await ensureBonded(device, undefined, undefined);
    expect(wire).toEqual(['RegisterAgent', 'Pair']);
    expect(props).toEqual([]);
    expect(bondedWarnings()).toEqual([]);
  });

  it('warns once when the kernel paired it without a bond (already paired on entry)', async () => {
    const { device, props } = fakeDevice({ paired: true, bonded: false });
    await ensureBonded(device, undefined, undefined, { forPairing: true });
    await ensureBonded(device, undefined, undefined, { forPairing: true });
    expect(props).toContain('Bonded');
    expect(bondedWarnings()).toHaveLength(1);
    expect(bondedWarnings()[0]).toContain('bluetoothctl');
    // Already paired: no agent role taken, no Pair().
    expect(wire).toEqual([]);
  });

  it('warns when Pair() went through without a bond', async () => {
    const { device } = fakeDevice({ paired: false, bonded: false });
    await ensureBonded(device, undefined, undefined, { forPairing: true });
    expect(wire).toContain('Pair');
    expect(bondedWarnings()).toHaveLength(1);
  });

  it('says nothing when BlueZ has no Bonded property (older than 5.65)', async () => {
    const { device } = fakeDevice({ paired: true, bonded: 'missing' });
    await ensureBonded(device, undefined, undefined, { forPairing: true });
    expect(bondedWarnings()).toEqual([]);
  });

  it('says nothing for a stored bond', async () => {
    const { device } = fakeDevice({ paired: true, bonded: true });
    await ensureBonded(device, undefined, undefined, { forPairing: true });
    expect(bondedWarnings()).toEqual([]);
  });
});

describe('acquireGattServer passes the option only for a single-bond adapter (#408)', () => {
  const gattFailsOnce = () => {
    let call = 0;
    return {
      gatt: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('gatt failed');
        return { id: 'server' };
      }),
      isPaired: vi.fn(async () => false),
    } as unknown as Device;
  };

  it('hands { forPairing: true } to the bond for a singleBond adapter', async () => {
    const device = gattFailsOnce();
    const bond = vi.fn(async () => {});
    const ac = new AbortController();
    const adapter = { requiresBonding: true, singleBond: true } as unknown as ScaleAdapter;
    await acquireGattServer(device, adapter, undefined, bond, ac.signal);
    expect(bond).toHaveBeenCalledWith(device, undefined, ac.signal, { forPairing: true });
  });

  // A Beurer SIG scale without beurer_pin: requiresBonding and no PIN, which is
  // exactly the case a gate on "bonding without a PIN" would wrongly catch.
  it('calls the bond with exactly three arguments for every other adapter', async () => {
    const device = gattFailsOnce();
    const bond = vi.fn(async () => {});
    const ac = new AbortController();
    const adapter = { requiresBonding: true } as unknown as ScaleAdapter;
    await acquireGattServer(device, adapter, undefined, bond, ac.signal);
    expect(bond.mock.calls[0]).toEqual([device, undefined, ac.signal]);
    expect(bond.mock.calls[0]).toHaveLength(3);
  });
});
