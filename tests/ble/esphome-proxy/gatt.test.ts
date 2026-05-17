import { describe, it, expect, vi } from 'vitest';
import { openGattSession } from '../../../src/ble/handler-esphome-proxy/gatt.js';
import { normalizeUuid } from '../../../src/ble/types.js';

// macToInt('00:00:00:00:00:01') === 1
const ADDR = 1;

function fakeConnection() {
  const listeners: Record<string, Array<(a: unknown) => void>> = {};
  return {
    connected: true,
    authorized: true,
    on(ev: string, fn: (a: unknown) => void) {
      (listeners[ev] ??= []).push(fn);
    },
    off(ev: string, fn: (a: unknown) => void) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
    },
    removeListener(ev: string, fn: (a: unknown) => void) {
      this.off(ev, fn);
    },
    emit(ev: string, a: unknown) {
      (listeners[ev] ?? []).forEach((f) => f(a));
    },
    connectBluetoothDeviceService: vi.fn(async () => ({ address: ADDR, connected: true, mtu: 23 })),
    disconnectBluetoothDeviceService: vi.fn(async () => ({ address: ADDR, connected: false })),
    listBluetoothGATTServicesService: vi.fn(async () => ({
      address: ADDR,
      servicesList: [
        {
          uuidList: ['0000181d-0000-1000-8000-00805f9b34fb'],
          handle: 1,
          characteristicsList: [
            {
              uuidList: ['00002a9d-0000-1000-8000-00805f9b34fb'],
              handle: 7,
              properties: 0x10,
            },
          ],
        },
      ],
    })),
    readBluetoothGATTCharacteristicService: vi.fn(async () => ({ dataList: [1, 2, 3] })),
    writeBluetoothGATTCharacteristicService: vi.fn(async () => ({})),
    notifyBluetoothGATTCharacteristicService: vi.fn(async () => ({})),
  };
}

describe('openGattSession', () => {
  it('connects, discovers, and exposes a UUID-keyed charMap', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const uuid = normalizeUuid('2a9d');
    expect(session.charMap.has(uuid)).toBe(true);
    expect(conn.connectBluetoothDeviceService).toHaveBeenCalled();

    const char = session.charMap.get(uuid)!;
    expect(await char.read()).toEqual(Buffer.from([1, 2, 3]));
    await char.write(Buffer.from([9]), true);
    expect(conn.writeBluetoothGATTCharacteristicService).toHaveBeenCalledWith(
      ADDR,
      7,
      expect.any(Uint8Array),
      true,
    );
    await session.close();
    expect(conn.disconnectBluetoothDeviceService).toHaveBeenCalledWith(ADDR);
  });

  it('routes notify-data for the right handle to the subscriber', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9d'))!;
    const got: Buffer[] = [];
    const unsub = await char.subscribe((d) => got.push(d));
    conn.emit('message.BluetoothGATTNotifyDataResponse', {
      address: ADDR,
      handle: 7,
      dataList: [0xaa],
    });
    conn.emit('message.BluetoothGATTNotifyDataResponse', {
      address: ADDR,
      handle: 99,
      dataList: [0xbb],
    });
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(Buffer.from([0xaa]));
    unsub();
    conn.emit('message.BluetoothGATTNotifyDataResponse', {
      address: ADDR,
      handle: 7,
      dataList: [0xcc],
    });
    expect(got).toHaveLength(1);
    await session.close();
  });

  it('fires BleDevice.onDisconnect when the peer reports disconnected', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const onDis = vi.fn();
    session.device.onDisconnect(onDis);
    conn.emit('message.BluetoothDeviceConnectionResponse', { address: ADDR, connected: false });
    expect(onDis).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it('throws when the peer fails to connect', async () => {
    const conn = fakeConnection();
    conn.connectBluetoothDeviceService = vi.fn(async () => ({ address: ADDR, connected: false }));
    await expect(
      openGattSession({ connection: conn } as never, '00:00:00:00:00:01'),
    ).rejects.toThrow(/could not connect/i);
  });
});
