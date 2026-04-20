import { createHash, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { computeBiaFat, buildPayload, uuid16, xorChecksum } from './body-comp-helpers.js';
import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapter,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { bleLog, normalizeUuid } from '../ble/types.js';

/**
 * Eufy Smart Scale P2 (T9148) and P2 Pro (T9149).
 *
 * Ported from bdr99/eufylife-ble-client (MIT). The P2/P2 Pro use FFF0 service
 * with three characteristics: FFF1 write (commands + auth), FFF2 notify (weight
 * data), FFF4 notify (auth responses). Before the scale streams weight data on
 * FFF2, the client must complete a C0/C1/C2/C3 handshake over FFF1 -> FFF4.
 *
 * Handshake:
 *   key = MD5(MAC without separators, uppercase ASCII)
 *   iv  = "0000000000000000"  (16 ASCII '0' bytes, NOT 16 zero bytes)
 *
 *   1. client -> scale on FFF1:   C0 <segs> <seg_idx> <total_len> <payload> <XOR>
 *      payload = hex of ASCII-base64(AES-128-CBC(random 15-char UUID))
 *      15 chars of base64 per segment; total_len = total bytes of base64 string
 *
 *   2. scale  -> client on FFF4:  C1 <segs> <seg_idx> <total_len> <payload> <XOR>
 *      reassemble, base64-decode, AES-decrypt -> device UUID (arbitrary text)
 *
 *   3. client -> scale on FFF1:   C2 ... = AES-CBC(f"{clientUuid}_{deviceUuid}")
 *
 *   4. scale  -> client on FFF4:  C3 01 00 01 <status> <XOR>
 *      status == 0 means auth successful. From then on FFF2 yields weight frames.
 *
 * Weight frame (FFF2, 16 bytes):
 *   [0]    0xCF signature
 *   [2]    0x00
 *   [6..7] weight LE  / 100 = kg
 *   [8..10] impedance LE24
 *   [12]   0x00 when final (stable) reading
 *
 * Advertisement frame (19 bytes of vendor data, company ID 0xFF48):
 *   [0..5] scale MAC
 *   [6]    0xCF signature
 *   [7]    heart rate (valid only when (byte[8] >> 6) == 0b11)
 *   [8]    flags
 *   [9..10] weight LE / 100 = kg
 *   [15]   0x00 when final (stable) reading
 *
 * Advertisement mode works without authentication (passive broadcast), so
 * devices that refuse connection still yield weight (no BIA/impedance).
 */

const CHR_WRITE = uuid16(0xfff1);
const CHR_DATA = uuid16(0xfff2);
const CHR_AUTH = uuid16(0xfff4);
const SVC_UUID = uuid16(0xfff0);

const AES_IV = Buffer.from('0000000000000000', 'ascii');
const MIN_WEIGHT_KG = 2;
const MAX_WEIGHT_KG = 200;

/** Company ID used in Eufy P2/P2 Pro advertisement manufacturer data. */
const EUFY_COMPANY_ID = 0xff48;

/**
 * Delay between successive sub-contract writes during the C0 and C2 handshake.
 * Matches the bdr99/eufylife-ble-client Python reference (1s `asyncio.sleep`),
 * which is what the EufyLife app effectively uses. Shorter delays (200 ms)
 * were observed to trigger disconnects on some T9149 units.
 */
const EUFY_WRITE_DELAY_MS = 1000;

/** XOR checksum over every byte of a frame (matches Python util.compute_checksum). */
function xor(bytes: Buffer): number {
  return xorChecksum(bytes, 0, bytes.length);
}

/**
 * Split encrypted payload (already hex of ASCII-base64) into sub-contract frames.
 *
 * Each segment carries up to 15 base64 ASCII chars (30 hex chars). Frame layout
 * matches Python `get_sub_contract_bytes`:
 *   <prefix 1B> <num_segments 1B> <seg_idx 1B> <base64_total_bytes 1B> <payload...> <XOR 1B>
 */
export function buildSubContract(dataHex: string, prefix: number): Buffer[] {
  const origLen = dataHex.length;
  const numSegments = Math.ceil(origLen / 30) || 1;
  const base64Bytes = origLen / 2; // dataHex encodes a base64 ASCII string
  const frames: Buffer[] = [];

  for (let i = 0; i < numSegments; i++) {
    const slice = dataHex.slice(i * 30, (i + 1) * 30);
    const header = Buffer.from([prefix, numSegments, i, base64Bytes]);
    const payload = Buffer.from(slice, 'hex');
    const body = Buffer.concat([header, payload]);
    const frame = Buffer.concat([body, Buffer.from([xor(body)])]);
    frames.push(frame);
  }
  return frames;
}

/** Reassemble segmented payload across multiple notifications keyed by prefix. */
class SegmentReassembler {
  private readonly prefix: number;
  private buffer: Buffer = Buffer.alloc(0);
  private expectedSegments = 0;
  private nextSegment = 0;

  constructor(prefix: number) {
    this.prefix = prefix;
  }

  /** Feed a single notification frame. Returns the full payload once last segment arrives. */
  feed(frame: Buffer): Buffer | null {
    if (frame.length < 5 || frame[0] !== this.prefix) return null;
    const numSegments = frame[1];
    const segIdx = frame[2];

    if (segIdx === 0) {
      this.buffer = Buffer.alloc(0);
      this.expectedSegments = numSegments;
      this.nextSegment = 0;
    }

    if (segIdx !== this.nextSegment) {
      bleLog.debug(`Eufy: out-of-order segment (expected ${this.nextSegment}, got ${segIdx})`);
      return null;
    }

    // Payload is between header (4 bytes) and trailing checksum (1 byte)
    const payload = frame.subarray(4, frame.length - 1);
    this.buffer = Buffer.concat([this.buffer, payload]);
    this.nextSegment += 1;

    if (segIdx === numSegments - 1) {
      const out = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.expectedSegments = 0;
      this.nextSegment = 0;
      return out;
    }
    return null;
  }
}

/**
 * Authentication helper. Encapsulates key generation and C0/C1/C2/C3 handling.
 * Exported so tests can verify frame assembly independently.
 */
export class EufyAuthHandler {
  readonly key: Buffer;
  readonly clientUuid: string;
  private readonly c1Reassembler = new SegmentReassembler(0xc1);
  private deviceUuid: string | null = null;
  private authSuccess = false;

  constructor(mac: string, clientUuid?: string) {
    const macClean = mac.replace(/[:-]/g, '').toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(macClean)) {
      throw new Error(`Eufy: invalid MAC "${mac}" (need 6 hex octets)`);
    }
    this.key = createHash('md5').update(macClean, 'utf8').digest();
    this.clientUuid = clientUuid ?? randomUUID().slice(0, 15);
  }

  get deviceUuidOrNull(): string | null {
    return this.deviceUuid;
  }

  get isAuthenticated(): boolean {
    return this.authSuccess;
  }

  /** Encrypt + base64 + hex + sub-contract to C0 frames. */
  buildC0(): Buffer[] {
    return buildSubContract(this.encryptToHex(this.clientUuid), 0xc0);
  }

  /** Feed a C1 notification. Returns true once the full device UUID is assembled. */
  handleC1(frame: Buffer): boolean {
    const payload = this.c1Reassembler.feed(frame);
    if (!payload) return false;
    // Payload is ASCII base64 of encrypted device UUID
    const encrypted = Buffer.from(payload.toString('ascii'), 'base64');
    this.deviceUuid = this.decrypt(encrypted);
    return true;
  }

  /** Encrypt combined `{clientUuid}_{deviceUuid}` + base64 + hex + sub-contract to C2 frames. */
  buildC2(): Buffer[] {
    if (!this.deviceUuid) throw new Error('Eufy: buildC2 called before C1 received');
    const combined = `${this.clientUuid}_${this.deviceUuid}`;
    return buildSubContract(this.encryptToHex(combined), 0xc2);
  }

  /** Feed a C3 notification. Returns true when result byte is present. */
  handleC3(frame: Buffer): boolean {
    if (frame.length < 5 || frame[0] !== 0xc3) return false;
    this.authSuccess = frame[4] === 0;
    return true;
  }

  private encryptToHex(plaintext: string): string {
    const cipher = createCipheriv('aes-128-cbc', this.key, AES_IV);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.from(encrypted.toString('base64'), 'ascii').toString('hex');
  }

  private decrypt(encrypted: Buffer): string {
    const decipher = createDecipheriv('aes-128-cbc', this.key, AES_IV);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plaintext.toString('utf8');
  }
}

/** Parse a 16-byte weight notification frame from FFF2. Returns null if malformed. */
export function parseWeightNotification(data: Buffer): ScaleReading | null {
  if (data.length !== 16 || data[0] !== 0xcf || data[2] !== 0x00) return null;

  const weight = ((data[7] << 8) | data[6]) / 100;
  if (!Number.isFinite(weight) || weight < MIN_WEIGHT_KG || weight > MAX_WEIGHT_KG) return null;

  const isFinal = data[12] === 0x00;
  if (!isFinal) return null;

  const impedance = (data[10] << 16) | (data[9] << 8) | data[8];
  return { weight, impedance };
}

/** Parse 19-byte advertisement vendor payload. Returns null if not a final reading. */
export function parseEufyAdvertisement(vendor: Buffer): ScaleReading | null {
  if (vendor.length < 19 || vendor[6] !== 0xcf) return null;

  // Final flag is at byte[15] in full 19-byte vendor payload (offset 9 after 6-byte header)
  const isFinal = vendor[15] === 0x00;
  if (!isFinal) return null;

  const weight = ((vendor[10] << 8) | vendor[9]) / 100;
  if (!Number.isFinite(weight) || weight < MIN_WEIGHT_KG || weight > MAX_WEIGHT_KG) return null;

  return { weight, impedance: 0 };
}

export class EufyP2Adapter implements ScaleAdapter {
  readonly name = 'Eufy Smart Scale P2/P2 Pro';
  readonly charNotifyUuid = CHR_DATA;
  readonly charWriteUuid = CHR_WRITE;
  readonly unlockCommand: number[] = [];
  readonly unlockIntervalMs = 0;
  readonly normalizesWeight = true;

  readonly characteristics: CharacteristicBinding[] = [
    { service: SVC_UUID, uuid: CHR_WRITE, type: 'write' },
    { service: SVC_UUID, uuid: CHR_DATA, type: 'notify' },
    { service: SVC_UUID, uuid: CHR_AUTH, type: 'notify' },
  ];

  private auth: EufyAuthHandler | null = null;
  private ctx: ConnectionContext | null = null;
  private readonly c3Seen = { done: false };

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name.startsWith('eufy t9148') || name.startsWith('eufy t9149')) return true;
    if (name === 'eufy t9148' || name === 'eufy t9149') return true;

    // Passive (broadcast) identification via manufacturer data: company 0xFF48
    // + 0xCF signature at offset 6 of the 19-byte vendor payload.
    if (device.manufacturerData) {
      const { id, data } = device.manufacturerData;
      if (id === EUFY_COMPANY_ID && data.length >= 19 && data[6] === 0xcf) {
        return true;
      }
    }
    return false;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.ctx = ctx;
    this.c3Seen.done = false;
    if (!ctx.deviceAddress) {
      bleLog.warn('Eufy: no device address available — auth will fail without MAC');
      return;
    }
    this.auth = new EufyAuthHandler(ctx.deviceAddress);
    bleLog.debug('Eufy: sending C0 handshake');
    for (const frame of this.auth.buildC0()) {
      await ctx.write(CHR_WRITE, frame, true);
      await new Promise<void>((r) => setTimeout(r, EUFY_WRITE_DELAY_MS));
    }
  }

  /** Multi-char dispatch: route FFF4 to auth handler, FFF2 to weight parser. */
  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    const uuid = normalizeUuid(charUuid);
    if (uuid === normalizeUuid(CHR_AUTH)) {
      this.handleAuthFrame(data);
      return null;
    }
    if (uuid === normalizeUuid(CHR_DATA)) {
      if (!this.auth?.isAuthenticated) {
        bleLog.debug('Eufy: FFF2 frame received before auth complete — ignoring');
        return null;
      }
      return parseWeightNotification(data);
    }
    return null;
  }

  /** Fallback single-char path (not used when parseCharNotification is defined). */
  parseNotification(data: Buffer): ScaleReading | null {
    return parseWeightNotification(data);
  }

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    return parseEufyAdvertisement(manufacturerData);
  }

  isComplete(reading: ScaleReading): boolean {
    // Broadcast readings have impedance=0 (passive mode, no BIA).
    // Authenticated GATT readings have non-zero impedance from the scale.
    if (reading.impedance === 0) return reading.weight > 0;
    return reading.weight > MIN_WEIGHT_KG && reading.impedance > 200;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }

  private handleAuthFrame(data: Buffer): void {
    if (!this.auth || !this.ctx) return;
    if (data.length === 0) return;

    if (data[0] === 0xc1) {
      if (!this.auth.handleC1(data)) return;
      bleLog.debug(`Eufy: C1 complete, device uuid received, sending C2`);
      void this.sendC2();
      return;
    }

    if (data[0] === 0xc3) {
      if (this.c3Seen.done) return;
      this.c3Seen.done = true;
      this.auth.handleC3(data);
      if (this.auth.isAuthenticated) {
        bleLog.info('Eufy: authentication successful, waiting for weight on FFF2');
      } else {
        bleLog.warn('Eufy: authentication failed (scale rejected credentials)');
      }
    }
  }

  private async sendC2(): Promise<void> {
    if (!this.auth || !this.ctx) return;
    for (const frame of this.auth.buildC2()) {
      await this.ctx.write(CHR_WRITE, frame, true);
      await new Promise<void>((r) => setTimeout(r, EUFY_WRITE_DELAY_MS));
    }
  }
}
