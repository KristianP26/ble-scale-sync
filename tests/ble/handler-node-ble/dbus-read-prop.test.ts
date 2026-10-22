import { describe, it, expect, vi } from 'vitest';
import { readDeviceProp } from '../../../src/ble/handler-node-ble/dbus.js';
import type { Device } from '../../../src/ble/handler-node-ble/dbus.js';

function deviceWithHelper(helper: Record<string, unknown>): Device {
  return { helper } as unknown as Device;
}

describe('readDeviceProp', () => {
  it('reads Device1 properties with a raw Properties.Get', async () => {
    const value = new Map([['0000181b-0000-1000-8000-00805f9b34fb', Buffer.from([2, 166])]]);
    const call = vi.fn(async (_msg: unknown) => ({ body: [{ value }] }));
    const device = deviceWithHelper({
      dbus: { call },
      object: '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF',
      prop: vi.fn(),
    });

    await expect(readDeviceProp(device, 'ServiceData')).resolves.toBe(value);

    const msg = call.mock.calls[0]![0] as Record<string, unknown>;
    expect(msg.destination).toBe('org.bluez');
    expect(msg.path).toBe('/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF');
    expect(msg.interface).toBe('org.freedesktop.DBus.Properties');
    expect(msg.member).toBe('Get');
    expect(msg.signature).toBe('ss');
    expect(msg.body).toEqual(['org.bluez.Device1', 'ServiceData']);
  });

  it('falls back to helper.prop when the transport has no raw bus', async () => {
    const prop = vi.fn(async () => 42);
    const device = deviceWithHelper({ object: '/x', prop });

    await expect(readDeviceProp(device, 'RSSI')).resolves.toBe(42);
    expect(prop).toHaveBeenCalledWith('RSSI');
  });

  it('rejects a reply that is not a Variant', async () => {
    const device = deviceWithHelper({
      dbus: { call: vi.fn(async () => ({ body: [{}] })) },
      object: '/x',
      prop: vi.fn(),
    });

    await expect(readDeviceProp(device, 'ServiceData')).rejects.toThrow(
      /Unexpected Properties.Get reply/,
    );
  });
});
