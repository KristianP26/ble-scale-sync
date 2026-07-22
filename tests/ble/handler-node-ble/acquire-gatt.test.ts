import { describe, it, expect, vi } from 'vitest';
import { acquireGattServer } from '../../../src/ble/handler-node-ble/scan.js';
import type { ScaleAdapter } from '../../../src/interfaces/scale-adapter.js';
import type { Device } from '../../../src/ble/handler-node-ble/dbus.js';

// A stand-in GATT server; acquireGattServer only passes it through.
const SERVER = { id: 'fake-gatt-server' };

/**
 * Build a fake node-ble Device whose gatt() follows a scripted sequence of
 * 'ok' | 'fail' outcomes (the last entry repeats), so the branch logic runs
 * without a live D-Bus and without waiting on the real 30s timeout. A failing
 * gatt() rejects immediately, which is what acquireGattServer's catch reacts to.
 */
function fakeDevice(opts: {
  gatt: Array<'ok' | 'fail'>;
  paired?: boolean;
  pairedThrows?: boolean;
}) {
  let call = 0;
  const gatt = vi.fn(async () => {
    const outcome = opts.gatt[Math.min(call, opts.gatt.length - 1)];
    call += 1;
    if (outcome === 'fail') throw new Error('gatt failed');
    return SERVER;
  });
  const isPaired = vi.fn(async () => {
    if (opts.pairedThrows) throw new Error('dbus unavailable');
    return opts.paired ?? false;
  });
  return { gatt, isPaired } as unknown as Device & {
    gatt: ReturnType<typeof vi.fn>;
    isPaired: ReturnType<typeof vi.fn>;
  };
}

const bonding = { requiresBonding: true } as unknown as ScaleAdapter;

describe('acquireGattServer (#290 bond-on-timeout retry)', () => {
  it('returns the server on first success without bonding', async () => {
    const device = fakeDevice({ gatt: ['ok'] });
    const bond = vi.fn(async () => {});
    await expect(acquireGattServer(device, bonding, 1234, bond)).resolves.toBe(SERVER);
    expect(device.gatt).toHaveBeenCalledTimes(1);
    expect(bond).not.toHaveBeenCalled();
  });

  it('rethrows without bonding when the adapter does not require bonding', async () => {
    const device = fakeDevice({ gatt: ['fail'] });
    const bond = vi.fn(async () => {});
    await expect(acquireGattServer(device, undefined, undefined, bond)).rejects.toThrow(
      'gatt failed',
    );
    expect(bond).not.toHaveBeenCalled();
    expect(device.gatt).toHaveBeenCalledTimes(1);
  });

  it('rethrows without re-pairing when the device is already bonded', async () => {
    const device = fakeDevice({ gatt: ['fail'], paired: true });
    const bond = vi.fn(async () => {});
    await expect(acquireGattServer(device, bonding, 1234, bond)).rejects.toThrow('gatt failed');
    expect(bond).not.toHaveBeenCalled();
    expect(device.isPaired).toHaveBeenCalledTimes(1);
    expect(device.gatt).toHaveBeenCalledTimes(1);
  });

  it('bonds then retries once and returns the server', async () => {
    const device = fakeDevice({ gatt: ['fail', 'ok'], paired: false });
    const bond = vi.fn(async () => {});
    await expect(acquireGattServer(device, bonding, 1234, bond)).resolves.toBe(SERVER);
    expect(bond).toHaveBeenCalledTimes(1);
    expect(bond).toHaveBeenCalledWith(device, 1234);
    expect(device.gatt).toHaveBeenCalledTimes(2);
  });

  it('rethrows if the post-bond retry also fails (no infinite retry)', async () => {
    const device = fakeDevice({ gatt: ['fail', 'fail'], paired: false });
    const bond = vi.fn(async () => {});
    await expect(acquireGattServer(device, bonding, 1234, bond)).rejects.toThrow('gatt failed');
    expect(bond).toHaveBeenCalledTimes(1);
    expect(device.gatt).toHaveBeenCalledTimes(2);
  });

  it('treats an isPaired() failure as not-bonded and still attempts the bond retry', async () => {
    const device = fakeDevice({ gatt: ['fail', 'ok'], pairedThrows: true });
    const bond = vi.fn(async () => {});
    await expect(acquireGattServer(device, bonding, undefined, bond)).resolves.toBe(SERVER);
    expect(bond).toHaveBeenCalledTimes(1);
    expect(device.gatt).toHaveBeenCalledTimes(2);
  });
});
