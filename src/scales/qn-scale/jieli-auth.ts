/**
 * JieLi RCSP authentication for QN-protocol scales that gate measurement data
 * behind the AE00 service (#235, #75).
 *
 * Some QN / Qingniu firmware (GE CS 10 G, Renpho Elis 1 and relatives) exposes
 * a second vendor service, AE00, alongside the FFF0 data service. The scale
 * sends a 17-byte frame `0x00 || challenge[16]` on AE02 and streams no weight
 * frames on FFF1 until the host writes `0x01 || response[16]` back to AE01.
 * The whole QN protocol still runs on FFF1/FFF2; AE00 is only a gate.
 *
 * The transform is JieLi's `RcspAuth` (`libjl_ota_auth.so`), which runs the
 * Bluetooth Classic E1 function (a keyed MAC built on SAFER+) over the
 * challenge with two constants baked into the vendor library:
 *
 *   response = E1(key = LINK_KEY, rand = challenge, addr = ADDR_CONSTANT)
 *
 * Credit: the constants, the mechanism and ten verified challenge/response
 * pairs come from @hedoric's HCI capture and native-code analysis in #235. This
 * implementation was written from the Bluetooth Core specification (Vol 2 Part
 * H, section 6) rather than from the vendor binary, and is checked against both
 * the specification's own E1 sample vectors and all ten captured pairs in
 * `tests/scales/jieli-auth.test.ts`.
 *
 * The constants are interoperability data, not a secret we generate: without
 * them the scale simply refuses to report a weight it has already measured.
 */

/** SAFER+ 45^n mod 257 exponentiation table (index 128 maps 256 to 0). */
const EXP45 = ((): number[] => {
  const exp = new Array<number>(256);
  let v = 1;
  for (let i = 0; i < 256; i++) {
    exp[i] = v === 256 ? 0 : v;
    v = (45 * v) % 257;
  }
  return exp;
})();

/** Inverse of EXP45. */
const LOG45 = ((): number[] => {
  const log = new Array<number>(256).fill(0);
  for (let i = 0; i < 256; i++) log[EXP45[i]] = i;
  return log;
})();

/** Byte positions that XOR in the odd key-addition layer and add in the even one. */
const XOR_POS = [0, 3, 4, 7, 8, 11, 12, 15];
/** Byte positions that add in the odd key-addition layer and XOR in the even one. */
const ADD_POS = [1, 2, 5, 6, 9, 10, 13, 14];

/** Armenian shuffle: the byte permutation applied between PHT layers. */
const PERM = [8, 11, 12, 15, 2, 1, 6, 5, 10, 9, 14, 13, 0, 7, 4, 3];

/**
 * Key-offset function Ẽ from the spec. The add/XOR pattern deliberately flips
 * at byte 8; that asymmetry is part of the definition, not a typo.
 */
const OFFSET_OPS: Array<[op: '+' | '^', value: number]> = [
  ['+', 233],
  ['^', 229],
  ['+', 223],
  ['^', 193],
  ['+', 179],
  ['^', 167],
  ['+', 149],
  ['^', 131],
  ['^', 233],
  ['+', 229],
  ['^', 223],
  ['+', 193],
  ['^', 179],
  ['+', 167],
  ['^', 149],
  ['+', 131],
];

function keyAddOdd(d: Buffer, k: Buffer): void {
  for (const i of XOR_POS) d[i] = (d[i] ^ k[i]) & 0xff;
  for (const i of ADD_POS) d[i] = (d[i] + k[i]) & 0xff;
}

function keyAddEven(d: Buffer, k: Buffer): void {
  for (const i of XOR_POS) d[i] = (d[i] + k[i]) & 0xff;
  for (const i of ADD_POS) d[i] = (d[i] ^ k[i]) & 0xff;
}

function nonlinear(d: Buffer): void {
  for (const i of XOR_POS) d[i] = EXP45[d[i]];
  for (const i of ADD_POS) d[i] = LOG45[d[i]];
}

/** Pseudo-Hadamard transform over the eight byte pairs. */
function pht(d: Buffer): void {
  for (let i = 0; i < 8; i++) {
    const x = d[2 * i];
    const y = d[2 * i + 1];
    d[2 * i] = (2 * x + y) & 0xff;
    d[2 * i + 1] = (x + y) & 0xff;
  }
}

/** The linear layer: one PHT, then three rounds of permute + PHT. */
function linear(d: Buffer): void {
  pht(d);
  for (let s = 0; s < 3; s++) {
    const t = Buffer.from(d);
    for (let i = 0; i < 16; i++) d[i] = t[PERM[i]];
    pht(d);
  }
}

/** SAFER+ key schedule: 17 subkeys of 16 bytes from a 128-bit key. */
function roundKeys(key: Buffer): Buffer[] {
  const reg = new Array<number>(17);
  for (let i = 0; i < 16; i++) reg[i] = key[i];
  let parity = 0;
  for (let i = 0; i < 16; i++) parity ^= key[i];
  reg[16] = parity & 0xff;

  const keys: Buffer[] = [];
  for (let ki = 1; ki <= 17; ki++) {
    if (ki === 1) {
      keys.push(Buffer.from(reg.slice(0, 16)));
    } else {
      const t = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) {
        const bias = EXP45[EXP45[(17 * ki + i + 1) & 0xff]];
        let idx = ki - 1 + i;
        if (idx >= 17) idx -= 17;
        t[i] = (reg[idx] + bias) & 0xff;
      }
      keys.push(t);
    }
    // Rotate every register byte left by 3 before deriving the next subkey.
    for (let i = 0; i < 17; i++) reg[i] = (((reg[i] << 3) & 0xff) | (reg[i] >> 5)) & 0xff;
  }
  return keys;
}

/**
 * SAFER+ encryption, 8 rounds.
 *
 * `feedPlaintextAtRound3` selects Ar' rather than Ar: the Bluetooth variant
 * re-adds the original plaintext at the input of round 3, which is what stops
 * the construction from being an invertible permutation of the key.
 */
function ar(key: Buffer, plain: Buffer, feedPlaintextAtRound3: boolean): Buffer {
  const k = roundKeys(key);
  const d = Buffer.from(plain);
  for (let round = 1; round <= 8; round++) {
    if (feedPlaintextAtRound3 && round === 3) keyAddOdd(d, plain);
    keyAddOdd(d, k[2 * round - 2]);
    nonlinear(d);
    keyAddEven(d, k[2 * round - 1]);
    linear(d);
  }
  keyAddOdd(d, k[16]);
  return d;
}

function offsetKey(key: Buffer): Buffer {
  const o = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    const [op, value] = OFFSET_OPS[i];
    o[i] = op === '+' ? (key[i] + value) & 0xff : (key[i] ^ value) & 0xff;
  }
  return o;
}

/** Repeat an L-byte value to 16 bytes. */
function expand(x: Buffer, l: number): Buffer {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = x[i % l];
  return out;
}

/** Hash(K, I1, I2, L) from the specification. Returns 16 bytes. */
function hash(key: Buffer, i1: Buffer, i2: Buffer, l: number): Buffer {
  const t = ar(key, i1, false);
  for (let i = 0; i < 16; i++) t[i] = (t[i] ^ i1[i]) & 0xff;
  const e = expand(i2, l);
  for (let i = 0; i < 16; i++) t[i] = (t[i] + e[i]) & 0xff;
  return ar(offsetKey(key), t, true);
}

/**
 * Bluetooth E1: 16 bytes, of which the spec calls the first four SRES and the
 * remaining twelve ACO. JieLi uses the whole block as the response.
 */
export function e1(key: Buffer, rand: Buffer, addr: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`E1 key must be 16 bytes, got ${key.length}`);
  if (rand.length !== 16) throw new Error(`E1 rand must be 16 bytes, got ${rand.length}`);
  if (addr.length !== 6) throw new Error(`E1 addr must be 6 bytes, got ${addr.length}`);
  return hash(key, rand, addr, 6);
}

/** Static link key from the vendor's `libjl_ota_auth.so` (#235). */
const LINK_KEY = Buffer.from('06775f87918dd423005df1d8cf0c142b', 'hex');

/**
 * Static address constant from the same binary. It is a byte palindrome, so
 * the usual "is this reversed?" question does not arise.
 */
const ADDR_CONSTANT = Buffer.from('112233332211', 'hex');

/** Frame header the scale uses for a challenge on AE02. */
export const JIELI_CHALLENGE_HEADER = 0x00;
/** Frame header the host must use for its response on AE01. */
export const JIELI_RESPONSE_HEADER = 0x01;
/** Total length of a challenge frame: header + 16-byte body. */
export const JIELI_CHALLENGE_FRAME_LEN = 17;

/**
 * Build the full AE01 response frame for a challenge frame received on AE02.
 * Accepts either the 17-byte frame including its `0x00` header or the bare
 * 16-byte body. Returns `0x01 || response[16]`.
 */
export function jieliAuthResponseFrame(challenge: Buffer): Buffer {
  if (challenge.length !== JIELI_CHALLENGE_FRAME_LEN && challenge.length !== 16) {
    throw new Error(
      `JieLi challenge must be 16 bytes, or 17 with its header, got ${challenge.length}`,
    );
  }
  const body = challenge.length === JIELI_CHALLENGE_FRAME_LEN ? challenge.subarray(1) : challenge;
  const response = e1(LINK_KEY, body, ADDR_CONSTANT);
  return Buffer.concat([Buffer.from([JIELI_RESPONSE_HEADER]), response]);
}
