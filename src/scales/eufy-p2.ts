import { createHash, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { computeBiaFat, buildPayload, uuid16, xorChecksum } from './body-comp-helpers.js';
import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  MultiCharNotify,
  BroadcastSource,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { bleLog, normalizeUuid } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';

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
 * Weight frame (FFF2, exactly 16 bytes). Layout verified byte for byte against
 * three real P2 Pro frames with app-reported ground truth (#289):
 *   [0]      0xCF signature
 *   [1]      0x0E payload length, i.e. the bytes after the 2-byte header
 *   [2]      0x00
 *   [3]      0xCF frame type
 *   [4..5]   impedance, LE, / 10 = ohm; zero when the scale ran no BIA
 *   [6..7]   weight LE / 100 = kg
 *   [8..10]  BIA-gated, meaning unknown (see below)
 *   [12]     0x00 when final (stable) reading
 *   [15]     XOR of bytes [2..14]
 *
 * Impedance decode (#289, second pass). The first pass shipped weight-only and
 * recorded [4..5] as "actively disfavoured", on three samples from one person
 * whose body fat spanned 0.6 pp. That was too little signal, and the later
 * samples settle it:
 *
 *   socks on,   88.00 kg, app reports no body fat -> [4..5] = 0,    [8..10] = 0
 *   socks off,  88.00 kg, app reports 30.4 %      -> [4..5] = 4700, [8..10] = 11 13 f1
 *   20 kg dumbbell,       app reports no body fat -> [4..5] = 0,    [8..10] = 0
 *   person 2,   68.45 kg, app reports 42.4 %      -> [4..5] = 6770, [8..10] = 06 05 62
 *   person 2 shod, 68.70 kg, no body fat          -> [4..5] = 0,    [8..10] = 0
 *
 * Both fields are zero exactly when the vendor app reports no body fat, so the
 * BIA payload is in one of them. What separates them is the direction between
 * the two people: impedance must be LOWER for the leaner, larger person, and
 * [4..5] is (470 vs 677 ohm) while every reading of [8..10] makes person 1
 * between 2.4x and 3.8x LARGER than person 2, which is the wrong sign for
 * impedance and for every other body-composition quantity (fat, lean, muscle,
 * water, bone were all checked). So [4..5] is the resistance and [8..10] stays
 * undecoded.
 *
 * Scale is /10: raw ohms would be 4700, an order of magnitude above anything
 * this project has seen from any scale, and /100 an order below.
 *
 * Accuracy caveat, worth knowing before comparing against the vendor app: our
 * generic BIA coefficients are not Eufy's, so the derived body fat runs roughly
 * 3-5 pp above what the app shows (33.8 % vs 30.4 % for the sample above). It
 * is still closer than the weight-only Deurenberg estimate it replaces, whose
 * error on the same samples is 2-8 pp in the other direction.
 *
 * The broadcast path stays weight-only: no advertisement sample carries these
 * bytes.
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
/**
 * Impedance band accepted from bytes [4..5] (#289). The floor is the same 200
 * ohm isComplete() requires, so a value inside the band can never produce a
 * reading the completeness gate then refuses; the ceiling is above every
 * impedance this project has observed (330-600 ohm) with room to spare.
 */
const MIN_IMPEDANCE_OHM = 200;
const MAX_IMPEDANCE_OHM = 1000;

/**
 * How far the weight may move (hundredths of kg) before a latched impedance is
 * treated as belonging to somebody else. 2 kg is far wider than the drift of one
 * person settling on the platform and far narrower than the gap between two
 * people in a household.
 */
const LATCH_WEIGHT_TOLERANCE_RAW = 200;
const MAX_WEIGHT_KG = 200;

/**
 * Hold window (ms) for the weight-stability gate. The scale flags a frame as
 * final (byte[12] == 0) while the weight can still be settling, so resolving on
 * the first final frame occasionally exported a drifting value (#284). Instead
 * we hold the link open after the first final frame and resolve as soon as two
 * consecutive final frames report the same weight (isFinal). If the weight never
 * settles to two equal frames within this window, shared.ts resolves the last
 * held reading, so the gate can never lose a reading it would previously have
 * returned.
 */
const WEIGHT_STABLE_HOLD_MS = 3000;

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
  private expectedTotalBytes = 0;
  private nextSegment = 0;

  constructor(prefix: number) {
    this.prefix = prefix;
  }

  private reset(): void {
    this.buffer = Buffer.alloc(0);
    this.expectedSegments = 0;
    this.expectedTotalBytes = 0;
    this.nextSegment = 0;
  }

  /** Feed a single notification frame. Returns the full payload once last segment arrives. */
  feed(frame: Buffer): Buffer | null {
    if (frame.length < 5 || frame[0] !== this.prefix) return null;

    // Validate trailing XOR checksum over header + payload.
    const body = frame.subarray(0, frame.length - 1);
    const expectedXor = frame[frame.length - 1];
    if (xor(body) !== expectedXor) {
      bleLog.debug(
        `Eufy: dropping segment with bad XOR (got 0x${expectedXor.toString(16)}, expected 0x${xor(body).toString(16)})`,
      );
      return null;
    }

    const numSegments = frame[1];
    const segIdx = frame[2];
    const totalBytes = frame[3];

    if (segIdx === 0) {
      this.reset();
      this.expectedSegments = numSegments;
      this.expectedTotalBytes = totalBytes;
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
      const expected = this.expectedTotalBytes;
      this.reset();
      if (out.length !== expected) {
        bleLog.debug(
          `Eufy: reassembled payload length ${out.length} differs from advertised ${expected}; dropping frame`,
        );
        return null;
      }
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

/**
 * Observed FFF2 invariants, reported and never enforced.
 *
 * All three real P2 Pro frames in #289 satisfy both:
 *   data[1] === data.length - 2             (0x0E payload length)
 *   data[15] === xorChecksum(data, 2, 15)   (XOR over bytes 2..14)
 *
 * Returns the list of violations, empty when the frame is clean or is not a
 * 16-byte 0xCF frame at all. Callers only log. Three frames from one unit on
 * one firmware, with nothing from a T9148, is not enough evidence to gate a
 * widely deployed adapter: a wrong gate would silently drop every reading on
 * all three transports. Promote to a hard reject once frames from a second
 * unit confirm both invariants.
 */
export function frameIntegrityProblems(data: Buffer): string[] {
  if (data.length !== 16 || data[0] !== 0xcf || data[2] !== 0x00) return [];
  const problems: string[] = [];
  const expectedLen = data.length - 2;
  if (data[1] !== expectedLen) {
    problems.push(`length byte 0x${data[1].toString(16)} != ${expectedLen}`);
  }
  const expectedXor = xorChecksum(data, 2, 15);
  if (data[15] !== expectedXor) {
    problems.push(`xor 0x${data[15].toString(16)} != expected 0x${expectedXor.toString(16)}`);
  }
  return problems;
}

/** Parse a 16-byte weight notification frame from FFF2. Returns null if malformed. */
export function parseWeightNotification(data: Buffer): ScaleReading | null {
  if (data.length !== 16 || data[0] !== 0xcf || data[2] !== 0x00) return null;

  const weight = ((data[7] << 8) | data[6]) / 100;
  if (!Number.isFinite(weight) || weight < MIN_WEIGHT_KG || weight > MAX_WEIGHT_KG) return null;

  const isFinal = data[12] === 0x00;
  if (!isFinal) return null;

  return { weight, impedance: parseImpedance(data) };
}

/**
 * Impedance in ohm from bytes [4..5], or 0 when the frame carries no usable BIA.
 *
 * Three gates, each earning its place:
 *   - the frame must pass its own length and XOR checks, because a corrupted
 *     frame that still yields a plausible weight must not also inject a
 *     resistance that silently rewrites the whole body composition;
 *   - zero means the scale ran no BIA (bare feet missing, shoes on) and is the
 *     normal case, not an error;
 *   - anything outside the plausible band is dropped rather than published. A
 *     bad resistance is worse than none: computeBiaFat clamps at 60 %, which is
 *     exactly the nonsense the original #289 report showed. The band matches
 *     both the 200 ohm floor isComplete() already enforces and the 330-600 ohm
 *     range observed across every other adapter in this project.
 */
function parseImpedance(data: Buffer): number {
  if (frameIntegrityProblems(data).length > 0) return 0;
  const raw = (data[5] << 8) | data[4];
  if (raw === 0) return 0;
  const ohm = raw / 10;
  if (ohm <= MIN_IMPEDANCE_OHM || ohm > MAX_IMPEDANCE_OHM) {
    bleLog.debug(`Eufy: ignoring out-of-range impedance ${ohm} ohm (raw ${raw})`);
    return 0;
  }
  return ohm;
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

export class EufyP2Adapter
  implements ScaleAdapterCore, GattWiring, MultiCharNotify, BroadcastSource
{
  readonly name = 'Eufy Smart Scale P2/P2 Pro';
  readonly match: MatchDescriptor = {
    priority: 270,
    custom: true,
    names: { startsWith: ['eufy t9148', 'eufy t9149'], exact: ['eufy t9148', 'eufy t9149'] },
    manufacturerId: 0xff48,
  };
  readonly charNotifyUuid = CHR_DATA;
  readonly charWriteUuid = CHR_WRITE;
  readonly normalizesWeight = true;

  readonly characteristics: CharacteristicBinding[] = [
    { service: SVC_UUID, uuid: CHR_WRITE, type: 'write' },
    { service: SVC_UUID, uuid: CHR_DATA, type: 'notify' },
    { service: SVC_UUID, uuid: CHR_AUTH, type: 'notify' },
  ];

  /** Highest-confidence impedance seen this session (see latchImpedance). */
  private sessionImpedance = 0;
  /** Raw weight (hundredths of kg) the latched impedance was measured at. */
  private sessionImpedanceRawWeight = 0;

  private auth: EufyAuthHandler | null = null;
  private ctx: ConnectionContext | null = null;
  private readonly c3Seen = { done: false };

  /** Raw weight (hundredths of kg) of the previous final GATT frame this session. */
  private previousFinalRawWeight: number | null = null;
  /** True once two consecutive final GATT frames reported the same weight. */
  private weightStable = false;

  /** Whether an FFF2 frame-integrity mismatch has already been reported this session. */
  private frameIntegrityLogged = false;

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

  /**
   * Clear the previous weigh-in before anything is subscribed (#394).
   *
   * This used to live in `onConnected`, which is too late for a multi-char
   * adapter: `subscribeAndInit` enables EVERY notify binding and only then
   * awaits `startInit()`. A stale `weightStable` plus a stale authenticated
   * `auth` made `isFinal()` return true on the first FFF2 frame of the next
   * session, resolving it on the previous person's weight.
   */
  onSessionStart(): void {
    this.auth = null;
    this.c3Seen.done = false;
    this.previousFinalRawWeight = null;
    this.weightStable = false;
    this.frameIntegrityLogged = false;
    this.sessionImpedance = 0;
    this.sessionImpedanceRawWeight = 0;
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.ctx = ctx;
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
      this.noteFrameIntegrity(data);
      return this.trackStability(parseWeightNotification(data));
    }
    return null;
  }

  /** Fallback single-char path (not used when parseCharNotification is defined). */
  parseNotification(data: Buffer): ScaleReading | null {
    this.noteFrameIntegrity(data);
    return this.trackStability(parseWeightNotification(data));
  }

  /**
   * Report an FFF2 frame that violates a #289 invariant, at most once per
   * session. Diagnostic only: the frame is parsed exactly as before either way.
   * Once per session rather than once per frame, because this runs for every
   * streaming frame and an unconditional line would flood exactly the log you
   * want to read.
   */
  private noteFrameIntegrity(data: Buffer): void {
    if (this.frameIntegrityLogged) return;
    const problems = frameIntegrityProblems(data);
    if (problems.length === 0) return;
    this.frameIntegrityLogged = true;
    bleLog.debug(
      `Eufy: FFF2 frame integrity mismatch (${problems.join('; ')}), parsed anyway (#289)`,
    );
  }

  /**
   * Record whether this final frame's weight matches the previous one, so
   * isFinal() can report the reading as settled. parseWeightNotification only
   * returns non-null for final frames, so consecutive calls compare final
   * frames to each other.
   */
  private trackStability(reading: ScaleReading | null): ScaleReading | null {
    if (!reading) return reading;
    const rawWeight = Math.round(reading.weight * 100);
    this.weightStable = this.previousFinalRawWeight === rawWeight;
    this.previousFinalRawWeight = rawWeight;
    return this.latchImpedance(reading, rawWeight);
  }

  /**
   * Carry a measured impedance forward across the rest of the session.
   *
   * The BIA result and the settled weight do not have to arrive in the same
   * frame, and the #284 stability gate resolves on two consecutive equal-weight
   * final frames. Without the latch, a final frame that repeats the weight with
   * [4..5] back at zero would resolve the session as weight-only and throw away
   * a resistance the scale had already reported.
   */
  private latchImpedance(reading: ScaleReading, rawWeight: number): ScaleReading {
    if (reading.impedance > 0) {
      this.sessionImpedance = reading.impedance;
      this.sessionImpedanceRawWeight = rawWeight;
      return reading;
    }
    if (this.sessionImpedance === 0) return reading;
    // Only carry it to the same body. One connection can outlive the person who
    // opened it: the session resolves on two consecutive equal-weight final
    // frames, so if someone steps off before that happens and someone else steps
    // on, an unlatched carry-forward would export person A's resistance against
    // person B's weight, and body composition is computed from exactly that
    // pair.
    if (Math.abs(rawWeight - this.sessionImpedanceRawWeight) > LATCH_WEIGHT_TOLERANCE_RAW) {
      bleLog.debug(
        `Eufy: not carrying impedance ${this.sessionImpedance} ohm across a ` +
          `${(Math.abs(rawWeight - this.sessionImpedanceRawWeight) / 100).toFixed(2)} kg change`,
      );
      return reading;
    }
    return { ...reading, impedance: this.sessionImpedance };
  }

  parseBroadcast(manufacturerData: Buffer): ScaleReading | null {
    return parseEufyAdvertisement(manufacturerData);
  }

  /**
   * Drop the connection context when the session ends (#394, same class as
   * #138).
   *
   * Everything else this adapter holds is reset in onSessionStart; this is the
   * one field that must be released rather than reset, because it is
   * dereferenced for writes after the link is gone.
   */
  onSessionEnd(): void {
    this.ctx = null;
  }

  isComplete(reading: ScaleReading): boolean {
    // Impedance 0 is normal, not a failure: the broadcast advertisement carries
    // no BIA at all, and over GATT the scale reports 0 whenever it could not
    // measure a resistance (shoes, socks, a dumbbell). Those readings still
    // complete on weight alone and fall back to the profile estimate.
    if (reading.impedance === 0) return reading.weight > 0;
    return reading.weight > MIN_WEIGHT_KG && reading.impedance > 200;
  }

  /**
   * Hold the link open after the first final frame so the weight can settle,
   * rather than exporting the first (possibly still-drifting) final value.
   * Only the GATT path (shared.ts) consults this; the broadcast path resolves
   * on isComplete() alone, so passive reads are unaffected.
   */
  readonly completionHoldMs = WEIGHT_STABLE_HOLD_MS;

  /** Resolve immediately once the weight has stabilized across two final frames. */
  isFinal(_reading: ScaleReading): boolean {
    return this.weightStable;
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
      void this.sendC2().catch((error: unknown) => {
        bleLog.warn(
          `Eufy: failed to send C2 authentication frame (${error instanceof Error ? error.message : String(error)})`,
        );
      });
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
    // Snapshot ctx into a local. onSessionEnd() nulls the field, and TypeScript
    // does not invalidate a `this.ctx` narrowing across an await, so reading it
    // per iteration compiled fine and threw a TypeError at runtime on a normal
    // mid-handshake disconnect - surfaced as a misleading "failed to send C2
    // authentication frame (Cannot read properties of null)". Mirrors
    // renpho-es26bb.sendOfflineAck.
    const auth = this.auth;
    const ctx = this.ctx;
    if (!auth || !ctx) return;
    for (const frame of auth.buildC2()) {
      await ctx.write(CHR_WRITE, frame, true);
      await new Promise<void>((r) => setTimeout(r, EUFY_WRITE_DELAY_MS));
    }
  }
}
