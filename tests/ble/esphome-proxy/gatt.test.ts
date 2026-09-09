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
    // Shape as emitted by @2colors/esphome-native-api 1.3.6: mapMessageByType()
    // pre-decodes the GATT uuid uint64 pair into a `uuid` string and DROPS
    // `uuidList`. The bridge must read `uuid`, not the (now absent) `uuidList`.
    listBluetoothGATTServicesService: vi.fn(async () => ({
      address: ADDR,
      servicesList: [
        {
          uuid: '0000181d-0000-1000-8000-00805f9b34fb',
          handle: 1,
          characteristicsList: [
            {
              uuid: '00002a9d-0000-1000-8000-00805f9b34fb',
              handle: 7,
              properties: 0x10,
              descriptorsList: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb', handle: 8 }],
            },
            // Indicate-only, with a CCCD (Robi S9 FFB3 / R-MSC04 0x2A12 shape).
            {
              uuid: '00002a9c-0000-1000-8000-00805f9b34fb',
              handle: 9,
              properties: 0x20,
              descriptorsList: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb', handle: 10 }],
            },
            // Notify-capable but the proxy reports no descriptors at all.
            {
              uuid: '00002a9e-0000-1000-8000-00805f9b34fb',
              handle: 11,
              properties: 0x10,
              descriptorsList: [],
            },
            // Read-only: must never get a CCCD write even though one exists.
            {
              uuid: '00002a9b-0000-1000-8000-00805f9b34fb',
              handle: 13,
              properties: 0x02,
              descriptorsList: [{ uuid: '00002902-0000-1000-8000-00805f9b34fb', handle: 14 }],
            },
          ],
        },
      ],
    })),
    // Real library shape: protobuf-JS renders `bytes data` as base64 (#291).
    readBluetoothGATTCharacteristicService: vi.fn(async () => ({ data: 'AQID' })),
    writeBluetoothGATTCharacteristicService: vi.fn(async () => ({})),
    notifyBluetoothGATTCharacteristicService: vi.fn(async () => ({})),
    writeBluetoothGATTDescriptorService: vi.fn(async () => ({})),
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

  it('skips a malformed characteristic (no uuid/uuidList) without crashing', async () => {
    const conn = fakeConnection();
    conn.listBluetoothGATTServicesService = vi.fn(async () => ({
      address: ADDR,
      servicesList: [
        {
          uuid: '0000181d-0000-1000-8000-00805f9b34fb',
          handle: 1,
          characteristicsList: [
            { handle: 5, properties: 0x10, descriptorsList: [] }, // no uuid -> skip
            {
              uuid: '00002a9d-0000-1000-8000-00805f9b34fb',
              handle: 7,
              properties: 0x10,
              descriptorsList: [],
            },
          ],
        },
      ],
    }));
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    expect(session.charMap.has(normalizeUuid('2a9d'))).toBe(true);
    expect(session.charMap.size).toBe(1);
    await session.close();
  });

  it('writes the full payload in a single call (no MTU chunking)', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9d'))!;
    const payload = Buffer.alloc(25, 0xab); // > mtu(23) - 3 = 20
    await char.write(payload, true);
    expect(conn.writeBluetoothGATTCharacteristicService).toHaveBeenCalledTimes(1);
    const call = conn.writeBluetoothGATTCharacteristicService.mock.calls[0];
    expect(Buffer.from(call[2] as Uint8Array)).toEqual(payload);
    await session.close();
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
      data: 'qg==', // 0xaa
    });
    conn.emit('message.BluetoothGATTNotifyDataResponse', {
      address: ADDR,
      handle: 99,
      data: 'uw==', // 0xbb
    });
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(Buffer.from([0xaa]));
    unsub();
    conn.emit('message.BluetoothGATTNotifyDataResponse', {
      address: ADDR,
      handle: 7,
      data: 'zA==', // 0xcc
    });
    expect(got).toHaveLength(1);
    await session.close();
  });

  it('still decodes a legacy dataList notification shape', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9d'))!;
    const got: Buffer[] = [];
    await char.subscribe((d) => got.push(d));
    conn.emit('message.BluetoothGATTNotifyDataResponse', {
      address: ADDR,
      handle: 7,
      dataList: [0xaa, 0xbb],
    });
    expect(got[0]).toEqual(Buffer.from([0xaa, 0xbb]));
    await session.close();
  });

  it('writes the CCCD after registering notifications, registration first (#252)', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9d'))!;
    await char.subscribe(() => {});
    expect(conn.notifyBluetoothGATTCharacteristicService).toHaveBeenCalledWith(ADDR, 7);
    expect(conn.writeBluetoothGATTDescriptorService).toHaveBeenCalledTimes(1);
    expect(conn.writeBluetoothGATTDescriptorService).toHaveBeenCalledWith(
      ADDR,
      8,
      Uint8Array.from([0x01, 0x00]),
    );
    const notifyOrder =
      conn.notifyBluetoothGATTCharacteristicService.mock.invocationCallOrder[0] ?? 0;
    const cccdOrder = conn.writeBluetoothGATTDescriptorService.mock.invocationCallOrder[0] ?? 0;
    expect(notifyOrder).toBeLessThan(cccdOrder);
    await session.close();
  });

  it('writes 0x0002 to the CCCD for an indicate-only characteristic (#252)', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9c'))!;
    await char.subscribe(() => {});
    expect(conn.writeBluetoothGATTDescriptorService).toHaveBeenCalledWith(
      ADDR,
      10,
      Uint8Array.from([0x02, 0x00]),
    );
    await session.close();
  });

  it('skips the CCCD write when the proxy reports no descriptors (#252)', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9e'))!;
    const got: Buffer[] = [];
    await char.subscribe((d) => got.push(d));
    expect(conn.writeBluetoothGATTDescriptorService).not.toHaveBeenCalled();
    conn.emit('message.BluetoothGATTNotifyDataResponse', {
      address: ADDR,
      handle: 11,
      data: 'qg==',
    });
    expect(got[0]).toEqual(Buffer.from([0xaa]));
    await session.close();
  });

  it('does not write a CCCD for a characteristic with neither notify nor indicate (#252)', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9b'))!;
    await char.subscribe(() => {});
    expect(conn.writeBluetoothGATTDescriptorService).not.toHaveBeenCalled();
    await session.close();
  });

  it('keeps the subscription when the CCCD write fails (#252)', async () => {
    const conn = fakeConnection();
    conn.writeBluetoothGATTDescriptorService = vi.fn(async () => {
      throw new Error('gatt error status=5');
    });
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9d'))!;
    const got: Buffer[] = [];
    await expect(char.subscribe((d) => got.push(d))).resolves.toBeTypeOf('function');
    conn.emit('message.BluetoothGATTNotifyDataResponse', {
      address: ADDR,
      handle: 7,
      data: 'qg==',
    });
    expect(got[0]).toEqual(Buffer.from([0xaa]));
    await session.close();
  });

  it('serializes GATT requests so replies cannot be swapped (#252)', async () => {
    const conn = fakeConnection();
    const order: string[] = [];
    let releaseWrite: (() => void) | undefined;
    conn.writeBluetoothGATTCharacteristicService = vi.fn(async () => {
      order.push('write:start');
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      order.push('write:end');
      return {};
    });
    conn.writeBluetoothGATTDescriptorService = vi.fn(async () => {
      order.push('cccd');
      return {};
    });
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9d'))!;
    const writing = char.write(Buffer.from([1]), true);
    const subscribing = char.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 5));
    // The subscribe path must not have issued anything while the write is open.
    expect(order).toEqual(['write:start']);
    releaseWrite?.();
    await writing;
    await subscribing;
    expect(order).toEqual(['write:start', 'write:end', 'cccd']);
    await session.close();
  });

  it('routes a notification emitted during the CCCD write round trip (#252)', async () => {
    const conn = fakeConnection();
    // The peer answers the CCCD write and notifies in the same drain: the
    // library emits both synchronously, so a listener registered after the
    // write would never see the first frame (QN 0x12, Robi S9, R-MSC04).
    conn.writeBluetoothGATTDescriptorService = vi.fn(async () => {
      conn.emit('message.BluetoothGATTNotifyDataResponse', {
        address: ADDR,
        handle: 7,
        data: 'Eg==', // 0x12
      });
      return {};
    });
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9d'))!;
    const got: Buffer[] = [];
    await char.subscribe((d) => got.push(d));
    expect(got).toEqual([Buffer.from([0x12])]);
    await session.close();
  });

  it('fails a rejected CCCD write immediately on the GATT error response (#252)', async () => {
    const conn = fakeConnection();
    // The library never resolves a descriptor write on an error response, so
    // without the correlation it would only settle on its own 5s timeout.
    conn.writeBluetoothGATTDescriptorService = vi.fn(() => {
      setTimeout(
        () =>
          conn.emit('message.BluetoothGATTErrorResponse', { address: ADDR, handle: 8, error: 5 }),
        0,
      );
      return new Promise(() => {});
    });
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9d'))!;
    const started = Date.now();
    await expect(char.subscribe(() => {})).resolves.toBeTypeOf('function');
    expect(Date.now() - started).toBeLessThan(1000);
    await session.close();
  });

  it('does not issue queued requests after the session closed (#252)', async () => {
    const conn = fakeConnection();
    let release: (() => void) | undefined;
    conn.writeBluetoothGATTCharacteristicService = vi.fn(async () => {
      if (!release) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return {};
    });
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const char = session.charMap.get(normalizeUuid('2a9d'))!;
    const first = char.write(Buffer.from([1]), true);
    const queued = [2, 3, 4].map((b) => char.write(Buffer.from([b]), true).catch(() => 'rejected'));
    await new Promise((r) => setTimeout(r, 5));
    await session.close();
    release?.();
    await first.catch(() => undefined);
    await Promise.all(queued);
    // Only the in-flight write reached the connection; the backlog rejected
    // instead of being issued against a disconnected handle.
    expect(conn.writeBluetoothGATTCharacteristicService).toHaveBeenCalledTimes(1);
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

  // fireDisconnect() is what lets a caller that gave up on a timeout tell the
  // abandoned waitForRawReading to tear itself down. Without it the wait keeps
  // its notify unsubscribers and its unlock interval forever and never calls
  // the adapter's onSessionEnd, because on this transport the disconnect
  // callback is driven purely by the proxy's connection frames - and a proxy
  // that dropped off Wi-Fi sends none.
  it('fireDisconnect() invokes the disconnect callback without a peer frame', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const onDis = vi.fn();
    session.device.onDisconnect(onDis);

    session.device.fireDisconnect();
    expect(onDis).toHaveBeenCalledTimes(1);

    // A real frame arriving afterwards must not double-fire it.
    conn.emit('message.BluetoothDeviceConnectionResponse', { address: ADDR, connected: false });
    expect(onDis).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it('fireDisconnect() is idempotent and survives the reverse order', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    const onDis = vi.fn();
    session.device.onDisconnect(onDis);

    conn.emit('message.BluetoothDeviceConnectionResponse', { address: ADDR, connected: false });
    session.device.fireDisconnect();
    session.device.fireDisconnect();
    expect(onDis).toHaveBeenCalledTimes(1);
    await session.close();
  });

  // The latch must not close over an empty slot: a fireDisconnect() before any
  // onDisconnect() would otherwise swallow the REAL disconnect frame for the
  // callback registered afterwards.
  it('fireDisconnect() before onDisconnect() does not swallow the real frame', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');

    session.device.fireDisconnect();

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
    // Both address-type candidates are tried before giving up (#215).
    expect(conn.connectBluetoothDeviceService).toHaveBeenCalledTimes(2);
  });

  it('passes the known address type to the connect request (#215)', async () => {
    const conn = fakeConnection();
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01', 1);
    expect(conn.connectBluetoothDeviceService).toHaveBeenCalledTimes(1);
    expect(conn.connectBluetoothDeviceService).toHaveBeenCalledWith(ADDR, 1);
    await session.close();
  });

  it('falls back to the other address type when the first fails (#215)', async () => {
    const conn = fakeConnection();
    conn.connectBluetoothDeviceService = vi
      .fn()
      .mockResolvedValueOnce({ address: ADDR, connected: false })
      .mockResolvedValueOnce({ address: ADDR, connected: true, mtu: 23 });
    // Unknown type -> candidates [0, 1]; first (public) fails, second (random) works.
    const session = await openGattSession({ connection: conn } as never, '00:00:00:00:00:01');
    expect(conn.connectBluetoothDeviceService).toHaveBeenCalledTimes(2);
    expect(conn.connectBluetoothDeviceService).toHaveBeenNthCalledWith(1, ADDR, 0);
    expect(conn.connectBluetoothDeviceService).toHaveBeenNthCalledWith(2, ADDR, 1);
    expect(session.charMap.has(normalizeUuid('2a9d'))).toBe(true);
    await session.close();
  });
});
