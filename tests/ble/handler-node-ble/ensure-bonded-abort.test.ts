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
 * A device whose pair() never settles on its own, which is what BlueZ actually
 * does while it waits for someone to press the button on the scale.
 */
function fakeDevice(opts: { paired?: boolean } = {}) {
  let rejectPair: ((err: Error) => void) | undefined;
  const cancelPair = vi.fn(async () => {
    // BlueZ answers a cancelled Pair() with an error, as node-ble surfaces it.
    rejectPair?.(new Error('org.bluez.Error.AuthenticationCanceled'));
  });
  const device = {
    isPaired: async () => opts.paired ?? false,
    pair: () =>
      new Promise<void>((_resolve, reject) => {
        rejectPair = reject;
      }),
    cancelPair,
  } as unknown as Device & { cancelPair: ReturnType<typeof vi.fn> };
  return device;
}

describe('ensureBonded under shutdown (#335)', () => {
  it('cancels an outstanding pairing when the app is asked to stop', async () => {
    const device = fakeDevice();
    const ac = new AbortController();
    const bonding = ensureBonded(device, 1234, ac.signal);
    // Let isPaired and the agent registration settle so Pair() is genuinely
    // in flight before the stop arrives.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    await expect(bonding).rejects.toThrow(/AuthenticationCanceled/);
    expect(device.cancelPair).toHaveBeenCalledTimes(1);
  });

  it('rethrows on abort instead of continuing unbonded', async () => {
    // The failure this guards against is silent: swallowing the error let the
    // caller walk into a two-minute wait for a reading nobody was going to
    // produce, so cancelling the pairing bought nothing.
    const device = fakeDevice();
    const ac = new AbortController();
    const bonding = ensureBonded(device, undefined, ac.signal);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    await expect(bonding).rejects.toThrow();
  });

  it('does not start a pairing at all when the stop already happened', async () => {
    const device = fakeDevice();
    const ac = new AbortController();
    ac.abort();
    await expect(ensureBonded(device, 1234, ac.signal)).rejects.toThrow(/Shutting down/);
    expect(device.cancelPair).not.toHaveBeenCalled();
  });

  it('keeps swallowing an ordinary pairing failure', async () => {
    // Only an abort is fatal. A scale that simply refuses to pair must still
    // fall through and be read unbonded, which is what #168 established.
    const device = {
      isPaired: async () => false,
      pair: async () => {
        throw new Error('Authentication Failed');
      },
      cancelPair: async () => {},
    } as unknown as Device;
    await expect(ensureBonded(device, 1234, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('leaves no abort listener behind after a successful pairing', async () => {
    // Continuous mode reuses one long-lived signal across every cycle, so a
    // listener per session would accumulate for the life of the process.
    const device = {
      isPaired: async () => false,
      pair: async () => {},
      cancelPair: async () => {},
    } as unknown as Device;
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, 'addEventListener');
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    await ensureBonded(device, undefined, ac.signal);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
