/**
 * 55AA framing of the Renpho 0x1A10 family (ES-CS20M, R-MSC04, ES-26BB):
 * `55 AA cmd length(u16 BE) payload sum8`, the sum8 covering every byte before
 * it. One copy, so the writers and the write guards cannot drift apart (A-05).
 */

/** Low byte of the sum of the bytes. */
export function sum8(bytes: Uint8Array): number {
  let sum = 0;
  for (const b of bytes) sum += b;
  return sum & 0xff;
}

export function build55aaFrame(cmd: number, payload: number[]): Buffer {
  const body = [0x55, 0xaa, cmd, (payload.length >> 8) & 0xff, payload.length & 0xff, ...payload];
  return Buffer.from([...body, sum8(Uint8Array.from(body))]);
}

/** Why a whole frame is malformed (header, length field, checksum), or null. */
export function frameFault(frame: Buffer): string | null {
  if (frame.length < 6 || frame[0] !== 0x55 || frame[1] !== 0xaa) {
    return 'a frame without the 55AA header';
  }
  if (frame.length !== frame.readUInt16BE(3) + 6)
    return 'a frame whose length field does not match';
  if (sum8(frame.subarray(0, -1)) !== frame[frame.length - 1]) return 'a frame with a bad checksum';
  return null;
}
