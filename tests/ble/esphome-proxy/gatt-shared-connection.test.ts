import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { openGattSession } from '../../../src/ble/handler-esphome-proxy/gatt.js';
import { normalizeUuid } from '../../../src/ble/types.js';

/**
 * Regression guard for B-04: two GATT sessions on ONE ESPHome proxy connection.
 *
 * This deliberately runs the real library Connection. Its
 * sendMessageAwaitResponse() waits with `once('message.<Type>')` and never
 * looks at the address or handle, so the first response of a type settles
 * every request of that type still waiting. A fake connection that hands each
 * call its own reply (as gatt.test.ts does) cannot show that. Only the socket
 * is replaced: sendMessage() goes to a scripted proxy that answers each request
 * for its own address, with the scale behind address 1 answering slower.
 */
const nodeRequire = createRequire(import.meta.url);
const Connection = nodeRequire('@2colors/esphome-native-api/lib/connection.js');

const SVC = '0000181d-0000-1000-8000-00805f9b34fb';
const CHAR = '00002a9d-0000-1000-8000-00805f9b34fb';
const HANDLE = 7;
const LATENCY_MS: Record<number, number> = { 1: 30, 2: 5 };
const PAYLOAD: Record<number, string> = {
  1: Buffer.from([0xaa]).toString('base64'),
  2: Buffer.from([0xbb]).toString('base64'),
};

interface ProtoMsg {
  constructor: { type: string };
  getAddress(): number;
}

const open: Array<{ frameHelper: { socket: { destroy(): void } } }> = [];

function proxyConnection() {
  const conn = new Connection({ host: 'proxy.invalid', reconnect: false });
  // Skip the socket handshake; everything above it is the library's own code.
  conn._connected = true;
  conn._authorized = true;
  const answer = (address: number, type: string, payload: object): void => {
    setTimeout(() => conn.emit(`message.${type}`, { address, ...payload }), LATENCY_MS[address]);
  };
  conn.sendMessage = (msg: ProtoMsg): void => {
    const address = msg.getAddress();
    switch (msg.constructor.type) {
      case 'BluetoothDeviceRequest':
        answer(address, 'BluetoothDeviceConnectionResponse', { connected: true, mtu: 23 });
        break;
      case 'BluetoothGATTGetServicesRequest':
        setTimeout(() => {
          conn.emit('message.BluetoothGATTGetServicesResponse', {
            address,
            servicesList: [
              {
                uuid: SVC,
                handle: 1,
                characteristicsList: [
                  { uuid: CHAR, handle: HANDLE, properties: 0x02, descriptorsList: [] },
                ],
              },
            ],
          });
          conn.emit('message.BluetoothGATTGetServicesDoneResponse', { address });
        }, LATENCY_MS[address]);
        break;
      case 'BluetoothGATTReadRequest':
        answer(address, 'BluetoothGATTReadResponse', { handle: HANDLE, data: PAYLOAD[address] });
        break;
      default:
        break;
    }
  };
  open.push(conn);
  return conn;
}

describe('openGattSession on a shared ESPHome connection (B-04)', () => {
  afterEach(() => {
    for (const conn of open.splice(0)) conn.frameHelper.socket.destroy();
  });

  it('does not hand one scale the reply meant for another', async () => {
    const conn = proxyConnection();
    const client = { connection: conn } as never;
    const a = await openGattSession(client, '00:00:00:00:00:01', 0);
    const b = await openGattSession(client, '00:00:00:00:00:02', 0);

    // Both scales read at once: the faster reply (scale 2) must not settle
    // scale 1's request.
    const [fromA, fromB] = await Promise.all([
      a.charMap.get(normalizeUuid(CHAR))!.read(),
      b.charMap.get(normalizeUuid(CHAR))!.read(),
    ]);
    expect(fromA).toEqual(Buffer.from([0xaa]));
    expect(fromB).toEqual(Buffer.from([0xbb]));

    await Promise.all([a.close(), b.close()]);
  });

  it('keeps discovery of one scale from ending on the other one finishing', async () => {
    const conn = proxyConnection();
    const client = { connection: conn } as never;
    // Concurrent opens: scale 2's GetServicesDone arrives first and, without
    // serialization, would settle scale 1's discovery too.
    const [a, b] = await Promise.all([
      openGattSession(client, '00:00:00:00:00:01', 0),
      openGattSession(client, '00:00:00:00:00:02', 0),
    ]);
    expect([...a.charMap.keys()]).toEqual([normalizeUuid(CHAR)]);
    expect([...b.charMap.keys()]).toEqual([normalizeUuid(CHAR)]);
    await Promise.all([a.close(), b.close()]);
  });
});
