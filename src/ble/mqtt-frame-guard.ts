/** The two methods of a socket the guard uses; a Duplex and an EventEmitter both fit. */
export interface FrameGuardSocket {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

export interface MqttFrameLimits {
  /** Largest remaining length of the first packet on a connection (a CONNECT). */
  firstPacketMax: number;
  /** Largest remaining length of every later packet. */
  packetMax: number;
}

export interface MqttFrameViolation {
  /** Zero-based index of the packet on this connection that broke the limit. */
  packetIndex: number;
  /** Remaining length read so far; a lower bound of what the packet announced. */
  declared: number;
}

/**
 * Close a connection that announces an MQTT packet larger than the limit.
 *
 * aedes and mqtt-packet have no packet size option: the parser waits until
 * `remaining length` bytes have arrived, and that field is a 4 byte varint of
 * up to 268,435,455. One unauthenticated socket can therefore make the broker
 * buffer hundreds of megabytes (ADR D112).
 *
 * The guard is a passive `'data'` tap that walks the fixed headers and skips
 * the bodies arithmetically, so it copies nothing. It fires as soon as the
 * length bytes arrive, before any body byte is buffered. The limit applies to
 * the MQTT "remaining length" (the fixed header is not counted): `value ===
 * limit` passes, `limit + 1` is a violation.
 *
 * Attach it AFTER `aedes.handle(socket)`. aedes reads with `read()` and keeps a
 * `'readable'` listener; a `'data'` listener added later does not switch the
 * stream to flowing mode, and Node emits `'data'` for every chunk `read()`
 * returns. A tap added first would start flowing mode and starve aedes.
 *
 * The guard does not own the socket: `onViolation` decides what to do. It does
 * not check that the first packet is a CONNECT, aedes does that.
 */
export function attachMqttFrameGuard(
  socket: FrameGuardSocket,
  limits: MqttFrameLimits,
  onViolation: (violation: MqttFrameViolation) => void,
): void {
  type State = 'type' | 'len' | 'body';
  let state: State = 'type';
  let index = 0;
  let remaining = 0;
  let value = 0;
  let mul = 1;
  let lenBytes = 0;
  let dead = false;

  const feed = (chunk: Buffer): void => {
    let i = 0;
    while (i < chunk.length && !dead) {
      if (state === 'body') {
        const k = Math.min(remaining, chunk.length - i);
        remaining -= k;
        i += k;
        if (remaining === 0) {
          state = 'type';
          index++;
        }
      } else if (state === 'type') {
        i++;
        state = 'len';
        mul = 1;
        value = 0;
        lenBytes = 0;
      } else {
        const b = chunk[i++];
        value += (b & 0x7f) * mul;
        mul *= 128;
        lenBytes++;
        const max = index === 0 ? limits.firstPacketMax : limits.packetMax;
        // The partial value is a lower bound of the final one, so a violation
        // is certain as soon as it exceeds the limit. A fifth length byte is
        // malformed whatever the limit is.
        if (value > max || (lenBytes === 4 && (b & 0x80) !== 0)) {
          dead = true;
          socket.off('data', feed);
          onViolation({ packetIndex: index, declared: value });
          return;
        }
        if ((b & 0x80) === 0) {
          remaining = value;
          if (remaining === 0) {
            state = 'type';
            index++;
          } else {
            state = 'body';
          }
        }
      }
    }
  };

  socket.on('data', feed);
}
