import { describe, it, expect, vi } from 'vitest';
import type { Device } from '../../../src/ble/handler-node-ble/dbus.js';

// getBus() would open a real D-Bus connection, and registerPairingAgent would
// export an object on it. Neither is what these tests are about: the subject is
// what ensureBonded does with an AbortSignal while Pair() is outstanding.
vi.mock('../../../src/ble/handler-node-ble/connection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/ble/handler-node-ble/connection.js')>();
  return { ...actual, getBus: () => ({}) };
});
vi.mock('../../../src/ble/handler-node-ble/agent.js', () => ({
  registerPairingAgent: async () => {},
  setPairingTarget: () => {},
}));

const { ensureBonded } = await import('../../../src/ble/handler-node-ble/scan.js');

/**
 * A device whose Pair() never settles on its own, which is what BlueZ actually
 * does while it waits for someone to press the button on the scale.
 *
 * `helper.callMethod` is the real seam: `helperOf(device).callMethod(name)` is
 * how this file talks to BlueZ, so the fake records the method NAME rather than
 * exposing a convenience wrapper. That is deliberate. node-ble's own
 * `Device.cancelPair()` sends `CancelPair`, the org.bluez.Device1 interface
 * defines `CancelPairing`, and a fake with a `cancelPair` spy on it would have
 * happily asserted that a call which cancels nothing had been made.
 */
function fakeDevice(opts: { paired?: boolean } = {}) {
  let rejectPair: ((err: Error) => void) | undefined;
  const callMethod = vi.fn(async (name: string) => {
    if (name === 'CancelPairing') {
      // BlueZ answers a cancelled Pair() with an error, as node-ble surfaces it.
      rejectPair?.(new Error('org.bluez.Error.AuthenticationCanceled'));
    }
  });
  const device = {
    isPaired: async () => opts.paired ?? false,
    pair: () =>
      new Promise<void>((_resolve, reject) => {
        rejectPair = reject;
      }),
    helper: { callMethod },
  } as unknown as Device & { helper: { callMethod: ReturnType<typeof vi.fn> } };
  return device;
}

/** Let isPaired and the agent registration settle so Pair() is really in flight. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('ensureBonded under shutdown (#335)', () => {
  it('cancels an outstanding pairing with the method BlueZ actually has', async () => {
    const device = fakeDevice();
    const ac = new AbortController();
    const bonding = ensureBonded(device, 1234, ac.signal);
    await settle();
    ac.abort();
    await expect(bonding).rejects.toThrow();
    expect(device.helper.callMethod).toHaveBeenCalledWith('CancelPairing');
  });

  it('settles on the abort itself, not only on BlueZ answering the cancel', async () => {
    // The case this exists for is a wedged D-Bus, where the cancel may go
    // nowhere. If the abort did not settle the await by itself, a stop would
    // still wait out the 15 s bonding timeout, three times the force-exit
    // grace window.
    const device = {
      isPaired: async () => false,
      pair: () => new Promise<void>(() => {}),
      helper: { callMethod: async () => {} },
    } as unknown as Device;
    const ac = new AbortController();
    const bonding = ensureBonded(device, 1234, ac.signal);
    await settle();
    ac.abort();
    await expect(bonding).rejects.toThrow(/Shutting down|abort/i);
  });

  it('rethrows on abort instead of continuing unbonded', async () => {
    // The failure this guards against is silent: swallowing the error let the
    // caller walk into a two-minute wait for a reading nobody was going to
    // produce, so cancelling the pairing bought nothing.
    const device = fakeDevice();
    const ac = new AbortController();
    const bonding = ensureBonded(device, undefined, ac.signal);
    await settle();
    ac.abort();
    await expect(bonding).rejects.toThrow();
  });

  it('does not start a pairing at all when the stop already happened', async () => {
    const device = fakeDevice();
    const ac = new AbortController();
    ac.abort();
    await expect(ensureBonded(device, 1234, ac.signal)).rejects.toThrow(/Shutting down/);
    expect(device.helper.callMethod).not.toHaveBeenCalled();
  });

  it('keeps swallowing an ordinary pairing failure', async () => {
    // Only an abort is fatal. A scale that simply refuses to pair must still
    // fall through and be read unbonded, which is what #168 established.
    const device = {
      isPaired: async () => false,
      pair: async () => {
        throw new Error('Authentication Failed');
      },
      helper: { callMethod: async () => {} },
    } as unknown as Device;
    await expect(ensureBonded(device, 1234, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('stands the listener down once the pairing is through', async () => {
    // Two awaits follow a successful pair(), and continuous mode reuses one
    // signal for every cycle. A stop during those awaits must not send
    // CancelPairing against a bond that already completed, and a listener per
    // session must not accumulate for the life of the process.
    const callMethod = vi.fn(async () => {});
    const device = {
      isPaired: async () => false,
      pair: async () => {},
      helper: { callMethod },
      // The Trusted write goes through the same helper; give it a `set` so the
      // happy path completes.
    } as unknown as Device;
    (device as unknown as { helper: { set: unknown } }).helper.set = async () => {};
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, 'addEventListener');
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    await ensureBonded(device, undefined, ac.signal);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);

    ac.abort();
    expect(callMethod).not.toHaveBeenCalledWith('CancelPairing');
  });
});

describe('ensureBonded sees a stop that lands during its preparation', () => {
  /**
   * The abort was checked once, on entry, and the listener that reacts to it
   * was attached only after pair() had already been called. Between those two
   * points sit an isPaired() round trip and an agent registration - both D-Bus
   * calls. A stop arriving in that window was seen by nothing: pairing started
   * anyway, lit the passkey prompt on a scale nobody was standing at, and the
   * shutdown waited out the 15 s bonding timeout.
   */
  function deviceWithSlowIsPaired(release: { fn?: () => void }) {
    const pair = vi.fn(() => new Promise<void>(() => {}));
    return {
      isPaired: () =>
        new Promise<boolean>((resolve) => {
          release.fn = () => resolve(false);
        }),
      pair,
      helper: { callMethod: vi.fn(async () => {}) },
    } as unknown as Device & { pair: ReturnType<typeof vi.fn> };
  }

  it('does not start pairing when the stop arrives during isPaired()', async () => {
    const release: { fn?: () => void } = {};
    const device = deviceWithSlowIsPaired(release);
    const ac = new AbortController();

    const bonding = ensureBonded(device, 1234, ac.signal);
    await settle();
    ac.abort();
    release.fn!();

    await expect(bonding).rejects.toThrow(/Shutting down/);
    expect(device.pair).not.toHaveBeenCalled();
  });

  it('does not start pairing when the stop arrives during agent registration', async () => {
    // Same window, one await later. registerPairingAgent is mocked to resolve
    // immediately at module scope, so the abort is placed between the two
    // checks by aborting from a microtask the agent registration yields to.
    const pair = vi.fn(() => new Promise<void>(() => {}));
    const ac = new AbortController();
    const device = {
      isPaired: async () => {
        queueMicrotask(() => ac.abort());
        return false;
      },
      pair,
      helper: { callMethod: vi.fn(async () => {}) },
    } as unknown as Device;

    await expect(ensureBonded(device, 1234, ac.signal)).rejects.toThrow(/Shutting down/);
    expect(pair).not.toHaveBeenCalled();
  });

  it('still pairs when no stop happened', async () => {
    // Guards against a fix that simply refuses to pair.
    const pair = vi.fn(async () => {});
    const device = {
      isPaired: async () => false,
      pair,
      helper: { callMethod: vi.fn(async () => {}), set: async () => {} },
    } as unknown as Device;

    await ensureBonded(device, 1234, new AbortController().signal);
    expect(pair).toHaveBeenCalledTimes(1);
  });
});
