import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { attachMqttFrameGuard, type MqttFrameViolation } from '../../src/ble/mqtt-frame-guard.js';

const LIMITS = { firstPacketMax: 100, packetMax: 1000 };

function setup(limits = LIMITS) {
  const socket = new EventEmitter();
  const violations: MqttFrameViolation[] = [];
  attachMqttFrameGuard(socket, limits, (v) => violations.push(v));
  const send = (...chunks: Buffer[]): void => {
    for (const c of chunks) socket.emit('data', c);
  };
  return { socket, violations, send };
}

/** Remaining length as an MQTT varint. */
function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

/** A packet of `type` whose body is `n` filler bytes. */
function packet(type: number, n: number): Buffer {
  return Buffer.concat([Buffer.from([type]), varint(n), Buffer.alloc(n, 0x61)]);
}

const CONNECT = (n = 10): Buffer => packet(0x10, n);
const PUBLISH = (n: number): Buffer => packet(0x30, n);
const PINGREQ = Buffer.from([0xc0, 0x00]);

describe('attachMqttFrameGuard', () => {
  it('lets packets within the limits pass', () => {
    const { violations, send } = setup();
    send(CONNECT(), PUBLISH(500), PINGREQ);
    expect(violations).toEqual([]);
  });

  it('passes a packet of exactly the limit and cuts one byte more', () => {
    const exact = setup();
    exact.send(CONNECT(), PUBLISH(1000));
    expect(exact.violations).toEqual([]);

    const over = setup();
    over.send(CONNECT(), PUBLISH(1001));
    expect(over.violations).toHaveLength(1);
  });

  it('uses the smaller limit for the first packet and the larger one after', () => {
    const exact = setup();
    exact.send(CONNECT(100));
    expect(exact.violations).toEqual([]);

    const over = setup();
    over.send(CONNECT(101));
    expect(over.violations).toEqual([{ packetIndex: 0, declared: 101 }]);

    // 500 bytes is fine for a later packet, over the limit for a first one.
    const later = setup();
    later.send(CONNECT(), PUBLISH(500));
    expect(later.violations).toEqual([]);
    const first = setup();
    first.send(PUBLISH(500));
    expect(first.violations).toHaveLength(1);
  });

  it('reports the index of the packet that broke the limit', () => {
    const { violations, send } = setup();
    send(CONNECT(), PINGREQ, PUBLISH(2000));
    expect(violations).toHaveLength(1);
    expect(violations[0].packetIndex).toBe(2);
  });

  it('fires from the length bytes alone, before any body byte arrives', () => {
    const { violations, send } = setup();
    send(CONNECT(), Buffer.concat([Buffer.from([0x30]), varint(5_000_000)]));
    expect(violations).toHaveLength(1);
    expect(violations[0].declared).toBeGreaterThan(1000);
  });

  it('handles a fixed header split from its length byte', () => {
    const { violations, send } = setup();
    send(CONNECT(), Buffer.from([0xc0]));
    send(Buffer.from([0x00]));
    send(PUBLISH(10));
    expect(violations).toEqual([]);
  });

  it('handles a length varint split across chunks', () => {
    const { violations, send } = setup();
    const big = PUBLISH(1000); // two length bytes
    send(CONNECT(), big.subarray(0, 1), big.subarray(1, 2), big.subarray(2, 3), big.subarray(3));
    expect(violations).toEqual([]);

    const over = setup();
    const wire = Buffer.concat([CONNECT(), Buffer.from([0x30]), varint(1001)]);
    for (const byte of wire) over.send(Buffer.from([byte]));
    expect(over.violations).toHaveLength(1);
  });

  it('handles zero-length packets and several packets in one chunk', () => {
    const { violations, send } = setup();
    send(Buffer.concat([CONNECT(), PINGREQ, PINGREQ, PUBLISH(5), PINGREQ, PUBLISH(1000)]));
    expect(violations).toEqual([]);
  });

  it('follows a body that spans chunks', () => {
    const { violations, send } = setup();
    const body = PUBLISH(900);
    send(CONNECT(), body.subarray(0, 100), body.subarray(100, 500), body.subarray(500), PINGREQ);
    expect(violations).toEqual([]);
  });

  it('counts the packets after a body that ends exactly at a chunk boundary', () => {
    const { violations, send } = setup();
    send(CONNECT(), PUBLISH(10));
    send(PUBLISH(1001));
    expect(violations).toEqual([{ packetIndex: 2, declared: 1001 }]);
  });

  it('cuts a length with a fifth continuation byte, whatever the limit', () => {
    const { violations, send } = setup({ firstPacketMax: 2 ** 28, packetMax: 2 ** 28 });
    send(Buffer.from([0x10, 0x80, 0x80, 0x80, 0x80, 0x01]));
    expect(violations).toHaveLength(1);
  });

  it('calls back once and stops listening after the first violation', () => {
    const { socket, violations, send } = setup();
    send(CONNECT(), PUBLISH(2000), PUBLISH(2000));
    expect(violations).toHaveLength(1);
    expect(socket.listenerCount('data')).toBe(0);
  });
});
