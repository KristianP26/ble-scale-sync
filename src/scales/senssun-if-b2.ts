import type {
  AdapterRuntimeConfig,
  BleDeviceInfo,
  BodyComposition,
  ConnectionContext,
  HoldForComposition,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { buildPayload, uuid16 } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog, errMsg } from '../ble/types.js';

const CLOUD_HEADER = Buffer.from('100000c5', 'hex');
const LIVE_WEIGHT_FRAME = 0x80;
const PROFILE_ACK_FRAME = 0x81;
const HEALTH_RECORD_FRAME = 0x82;
const MAX_BUFFER = 4096;
const PROFILE_RETRY_MS = 200;
const PROFILE_TIMEOUT_MS = 5_000;
const SELECTION_QUIET_MS = 2_000;
/**
 * At most this many profile writes per weigh-in. On mqtt-proxy a write only
 * publishes, so nothing in flight slows the 200 ms retry; this caps it at 3 s
 * of writes. The logs show no writes; timed by the 2 s quiet rule, the slowest
 * ack came about 1.8 s after the first one.
 */
export const IF_B2_MAX_PROFILE_WRITES = 15;
/**
 * How long the weight from the profile ack waits for the record. The barefoot
 * record came 5.8 s after the ack; the socks session got no record and the
 * scale dropped the link 12.2 s after it. A drop during the hold hands the
 * weight on anyway (D047), so a longer wait would lose nothing.
 */
export const IF_B2_RECORD_WAIT_MS = 9_000;

export interface IfB2LiveWeight {
  frameType: 'live_weight';
  weightKg: number;
  weightLb: number;
  unitCode: number;
  control: number;
  stable: boolean;
  raw: string;
}
export interface IfB2HealthRecord {
  frameType: 'health_record';
  recordSlot: number;
  weightKg: number;
  impedanceOhms: number;
  fatPercent: number;
  waterPercent: number;
  musclePercent: number;
  boneKg: number;
  bmr: number;
  bodyAge?: number;
  elapsedSeconds: number;
  profilePin: string;
  raw: string;
  compositionSource?: string;
  derivedFatSource?: 'derived' | 'transmitted';
}
export interface IfB2ProfileAck {
  frameType: 'profile_ack';
  /** Byte 7. Every ack in the logs has 0x00; what other values mean is unproven. */
  status: number;
  /** Bytes 8-9 as hex, the profile slot the ack is for. */
  profilePin: string;
  raw: string;
}
export type IfB2Frame = IfB2LiveWeight | IfB2ProfileAck | IfB2HealthRecord;

/** The decoded record a reading came from, carried on the reading (D077). */
type IfB2Composition = { record: IfB2HealthRecord; transmittedFatTenths: number };

function f32(value: number): number {
  return Math.fround(value);
}
function roundOne(value: number): number {
  return Math.floor(value * 10 + 0.5) / 10;
}
function u16(frame: Buffer, at: number): number {
  return frame.readUInt16BE(at);
}

export class IfB2Reassembler {
  private pending = Buffer.alloc(0);

  push(data: Buffer): Buffer[] {
    if (data.length) this.pending = Buffer.concat([this.pending, data]);
    if (this.pending.length > MAX_BUFFER)
      this.pending = this.pending.subarray(this.pending.length - MAX_BUFFER);
    const frames: Buffer[] = [];
    while (this.pending.length >= 4) {
      const start = this.pending.indexOf(CLOUD_HEADER);
      if (start < 0) {
        this.pending = this.pending.subarray(Math.max(0, this.pending.length - 3));
        break;
      }
      if (start) this.pending = this.pending.subarray(start);
      if (this.pending.length < 5) break;
      const length = this.pending[4];
      if (length !== 11 && length !== 14 && length !== 29) {
        const nextHeader = this.pending.indexOf(CLOUD_HEADER, 4);
        this.pending =
          nextHeader >= 0
            ? this.pending.subarray(nextHeader)
            : this.pending.subarray(Math.max(0, this.pending.length - 3));
        continue;
      }
      const opcode =
        length === 11 ? PROFILE_ACK_FRAME : length === 14 ? LIVE_WEIGHT_FRAME : HEALTH_RECORD_FRAME;
      if (
        (this.pending.length >= 6 && this.pending[5] !== 0x03) ||
        (this.pending.length >= 7 && this.pending[6] !== opcode)
      ) {
        this.pending = this.pending.subarray(4);
        continue;
      }
      // A plausible fragmented frame can contain a complete header in its payload.
      if (this.pending.length < length) break;
      const candidate = this.pending.subarray(0, length);
      const nextHeader = this.pending.indexOf(CLOUD_HEADER, 4);
      if (nextHeader > 0 && nextHeader < length) {
        const checksum = candidate.subarray(4, -1).reduce((sum, value) => (sum + value) & 0xff, 0);
        if (candidate[5] !== 0x03 || candidate.at(-1) !== checksum) {
          this.pending = this.pending.subarray(nextHeader);
          continue;
        }
      }
      frames.push(Buffer.from(candidate));
      this.pending = this.pending.subarray(length);
    }
    return frames;
  }
}

/**
 * One reassembled frame, or null for anything this decoder does not accept:
 * a bad header, length, namespace or checksum, an unknown type, a record
 * whose fields are out of range. Never throws.
 */
export function decodeIfB2Frame(frame: Buffer, profile?: UserProfile): IfB2Frame | null {
  if (frame.length < 8 || !frame.subarray(0, 4).equals(CLOUD_HEADER)) return null;
  if (frame[4] !== frame.length) return null;
  if (frame[5] !== 0x03) return null;
  const checksum = frame.subarray(4, -1).reduce((sum, value) => (sum + value) & 0xff, 0);
  if (frame.at(-1) !== checksum) return null;
  if (frame[6] === PROFILE_ACK_FRAME) {
    if (frame.length !== 11) return null;
    return {
      frameType: 'profile_ack',
      status: frame[7],
      profilePin: frame.subarray(8, 10).toString('hex'),
      raw: frame.toString('hex'),
    };
  }
  if (frame[6] === LIVE_WEIGHT_FRAME) {
    if (frame.length !== 14) return null;
    const result: IfB2LiveWeight = {
      frameType: 'live_weight',
      weightKg: u16(frame, 7) / 10,
      weightLb: u16(frame, 9) / 10,
      unitCode: frame[11],
      control: frame[12],
      stable: frame[12] === 0xaa,
      raw: frame.toString('hex'),
    };
    return result;
  }
  if (frame[6] !== HEALTH_RECORD_FRAME || frame.length !== 29) return null;
  if (frame[7] === 0xff) return null;
  const weightKg = u16(frame, 10) / 10;
  const result: IfB2HealthRecord = {
    frameType: 'health_record',
    recordSlot: frame[7],
    profilePin: frame.subarray(8, 10).toString('hex'),
    weightKg,
    fatPercent: u16(frame, 12) / 10,
    impedanceOhms: u16(frame, 14),
    waterPercent: u16(frame, 16) / 10,
    musclePercent: u16(frame, 18) / 10,
    boneKg: u16(frame, 20) / 10,
    bmr: u16(frame, 22),
    elapsedSeconds: frame.readUInt32BE(24),
    raw: frame.toString('hex'),
  };
  if (
    result.weightKg <= 0 ||
    result.impedanceOhms <= 0 ||
    (!profile &&
      (result.fatPercent <= 0 ||
        result.fatPercent > 100 ||
        result.waterPercent < 0 ||
        result.waterPercent > 100 ||
        result.musclePercent < 0 ||
        result.musclePercent > 100 ||
        result.boneKg <= 0 ||
        result.boneKg > result.weightKg))
  )
    return null;
  if (profile) {
    if (profile.gender !== 'male' && profile.gender !== 'female') return null;
    if (!(profile.height > 0) || !(profile.age >= 1)) return null;
    const derived = deriveComposition(
      result.weightKg,
      result.impedanceOhms,
      profile,
      u16(frame, 12),
    );
    result.bodyAge = derived.bodyAge;
    result.bmr = derived.bmr;
    result.fatPercent = derived.fat;
    result.waterPercent = derived.water;
    result.musclePercent = derived.muscle;
    result.boneKg = derived.bone;
    result.compositionSource = 'derived_from_impedance';
    result.derivedFatSource = derived.fatSource;
  }
  return result;
}

function deriveComposition(
  weightKg: number,
  impedanceOhms: number,
  profile: UserProfile,
  transmittedFatTenths: number,
) {
  const weight = f32(weightKg),
    height = f32(profile.height),
    impedance = f32(impedanceOhms);
  let fat: number;
  if (impedance < 50) fat = f32(3.9);
  else if (impedance > 3000) fat = f32(75.1);
  else {
    const z = Math.min(impedance, f32(375));
    let adjusted = weight;
    if (profile.gender === 'male' && adjusted > 64)
      adjusted = f32(f32(f32(adjusted - f32(64)) / f32(2)) + f32(64));
    const term = f32(f32(z + f32(4750)) + f32(Math.abs(30 - profile.age)));
    const numerator = profile.gender === 'male' ? 6.37e7 : 6.45e7;
    const denominator = 11554 - (term * 8.4 * adjusted * 10) / f32(height * height);
    fat = f32(roundOne((numerator / denominator - 5800) / 10));
    fat = Math.min(Math.max(fat, f32(4)), f32(75));
  }
  const reportedFat =
    Math.abs(transmittedFatTenths - f32(fat * f32(10))) <= 3
      ? f32(transmittedFatTenths / f32(10))
      : fat;
  const water = f32(roundOne(f32(f32(f32(100) - fat) * f32(11)) / f32(16)));
  const muscleFactor =
    profile.gender === 'male'
      ? 0.85 - (profile.age * 0.0578) / weight - height * 0.00038
      : 0.78 - (profile.age * 0.0578) / weight - height * 0.00025;
  const muscle = f32(roundOne(water * muscleFactor));
  const bone = f32(roundOne(f32(100 - reportedFat) * (profile.gender === 'male' ? 0.052 : 0.061)));
  // Preserve BodyMonitor's Java float rounding after each BMR operation.
  const isMale = profile.gender === 'male';
  const weightTerm = f32(weight * f32(isMale ? 13.9 : 9.6));
  const heightTerm = f32(height * f32(isMale ? 5.1 : 1.9));
  const base = f32(f32(weightTerm + f32(isMale ? 66 : 665)) + heightTerm);
  const ageTerm = f32(profile.age * f32(isMale ? 6.8 : 4.7));
  const bmr = Math.trunc(f32(base - ageTerm));
  const bmi = weight / f32(f32(height / f32(100)) * f32(height / f32(100)));
  const bodyAge = Math.min(
    Math.max(Math.trunc(profile.age * (0.00313 * profile.age * (bmi - 21.5) + 1)), profile.age - 5),
    profile.age + 5,
  );
  return {
    fat: roundOne(reportedFat),
    water: roundOne(water),
    muscle: roundOne(muscle),
    bone: roundOne(bone),
    bmr,
    bodyAge,
    fatSource: reportedFat === fat ? ('derived' as const) : ('transmitted' as const),
  };
}

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/**
 * The 19-byte profile command for PIN 0001. Height, age and weight are clamped
 * into the byte ranges (50-250 cm, 1-120 years, whole kg) instead of refused:
 * without a write there is no ack, and so no weight to hold for the record.
 */
export function buildCloudProfileCommand(profile: UserProfile, weightKg: number): Buffer {
  const bytes = Buffer.from('100000c5130301000000010000000000000000', 'hex');
  bytes[11] = profile.gender === 'male' ? 1 : 0;
  bytes[12] = Math.round(clamp(profile.height, 50, 250, 170));
  bytes[13] = Math.round(clamp(profile.age, 1, 120, 30));
  bytes[14] = profile.isAthlete ? 5 : 0;
  bytes[15] = 0;
  bytes.writeUInt16BE(Math.trunc(clamp(weightKg, 0, 0xffff, 0)), 16);
  bytes[18] = bytes.subarray(4, 18).reduce((sum, value) => (sum + value) & 0xff, 0);
  return bytes;
}

/**
 * One weigh-in's state, replaced whole in onSessionStart and onSessionEnd:
 * every session shares the one adapter object, so nothing here may reach the
 * next weigh-in. Its timers are its own: dispose() stops them, and every
 * callback checks that its session is still the adapter's.
 */
class IfB2Session {
  ctx: ConnectionContext | undefined;
  reassembler = new IfB2Reassembler();
  candidateWeight: number | undefined;
  stableWeight: number | undefined;
  selected: UserProfile | undefined;
  selectionAttempted = false;
  acked = false;
  completed = false;
  writing = false;
  writeInFlight = false;
  writes = 0;
  firstWriteAt = 0;
  /** "Log once per session" flags, one per kind of frame or failure. */
  logged = new Set<'record' | 'ack' | 'write'>();
  selectionTimer: NodeJS.Timeout | undefined;
  commandTimer: NodeJS.Timeout | undefined;
  commandWindowTimer: NodeJS.Timeout | undefined;

  clearSelectionCandidate(): void {
    clearTimeout(this.selectionTimer);
    this.selectionTimer = undefined;
    this.candidateWeight = undefined;
  }

  clearTimers(): void {
    clearTimeout(this.selectionTimer);
    clearInterval(this.commandTimer);
    clearTimeout(this.commandWindowTimer);
    this.selectionTimer = undefined;
    this.commandTimer = undefined;
    this.commandWindowTimer = undefined;
  }

  dispose(): void {
    this.writing = false;
    this.clearTimers();
  }

  /** A debug line the first time `key` comes up in this session. */
  debugOnce(key: 'record' | 'ack' | 'write', msg: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    bleLog.debug(msg);
  }
}

export class SenssunIfB2Adapter implements ScaleAdapterCore, HoldForComposition {
  readonly name = 'Senssun IF_B2';
  readonly match: MatchDescriptor = { priority: 300, names: { exact: ['if_b2'] } };
  readonly serviceUuid = uuid16(0xfff0);
  readonly charNotifyUuid = uuid16(0xfff1);
  readonly charWriteUuid = uuid16(0xfff2);
  /** From configure(): process lifetime, replaced on every config reload. */
  private profileForWeight: AdapterRuntimeConfig['profileForWeight'];
  private s = new IfB2Session();
  /** The weight held from the ack until the record replaces it (process lifetime, per object). */
  private readonly heldReadings = new WeakSet<ScaleReading>();
  /** Readings built from a record: they end the session. */
  private readonly recordReadings = new WeakSet<ScaleReading>();
  /**
   * Armed by the reading the ack returns. The record ends the session at once;
   * without one, as in socks, the weight goes out after this hold.
   */
  readonly completionHoldMs = IF_B2_RECORD_WAIT_MS;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  configure(opts: AdapterRuntimeConfig): void {
    this.profileForWeight = opts.profileForWeight;
  }

  onSessionStart(): void {
    // The old session's timers would otherwise still fire, so stop them first
    // (the same deliberate step as QN's dispose()).
    this.s.dispose();
    this.s = new IfB2Session();
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    const s = this.s;
    s.ctx = undefined;
    const missing = [this.charNotifyUuid, this.charWriteUuid].filter(
      (uuid) => !ctx.availableChars.has(uuid),
    );
    if (missing.length) throw new Error(`IF_B2 discovery race: missing ${missing.join(', ')}`);
    s.ctx = ctx;
  }

  onSessionEnd(): void {
    this.s.dispose();
    this.s = new IfB2Session();
  }

  private considerLiveWeight(weightKg: number): void {
    const s = this.s;
    if (s.selectionAttempted || s.completed) return;
    if (weightKg === 0) {
      s.clearSelectionCandidate();
      return;
    }

    if (s.candidateWeight === weightKg) return;

    s.clearSelectionCandidate();
    s.candidateWeight = weightKg;
    s.selectionTimer = setTimeout(() => {
      const weight = s.candidateWeight;
      if (this.s !== s || !s.ctx || weight === undefined || s.completed) return;
      s.candidateWeight = undefined;
      s.selectionTimer = undefined;
      s.selectionAttempted = true;
      s.stableWeight = weight;
      // Once per weigh-in, on the settled weight. Nobody matching still writes
      // users[0]: the ack answers a write, and no log shows a weigh-in without
      // one, so skipping it could leave no reading. The processor decides who
      // the reading belongs to.
      s.selected = this.profileForWeight?.(weight) ?? s.ctx.profile;
      this.startProfileWrites(s, buildCloudProfileCommand(s.selected, weight));
    }, SELECTION_QUIET_MS);
    s.selectionTimer.unref?.();
  }

  private stopWrites(s: IfB2Session): void {
    s.writing = false;
    s.clearTimers();
  }

  /**
   * Write the profile every PROFILE_RETRY_MS until the scale acks it, never two
   * writes at once, for at most PROFILE_TIMEOUT_MS and IF_B2_MAX_PROFILE_WRITES.
   * The profile bytes are personal data, so no log line carries them.
   */
  private startProfileWrites(s: IfB2Session, command: Buffer): void {
    const ctx = s.ctx;
    if (!ctx) return;
    s.writing = true;
    const giveUp = (): void => {
      if (this.s !== s || !s.writing || s.acked) return;
      this.stopWrites(s);
      bleLog.info(
        `Senssun IF_B2: the scale did not confirm the user profile after ${s.writes} write(s), ` +
          'so it may send no reading',
      );
    };
    const send = (): void => {
      if (this.s !== s || !s.writing || s.acked || s.writeInFlight) return;
      if (s.writes >= IF_B2_MAX_PROFILE_WRITES) return giveUp();
      s.writeInFlight = true;
      if (s.writes === 0) s.firstWriteAt = Date.now();
      s.writes++;
      ctx.write(this.charWriteUuid, command, true).then(
        () => {
          s.writeInFlight = false;
        },
        (err: unknown) => {
          s.writeInFlight = false;
          s.debugOnce('write', `Senssun IF_B2: profile write failed: ${errMsg(err)}`);
        },
      );
    };
    s.commandWindowTimer = setTimeout(giveUp, PROFILE_TIMEOUT_MS);
    s.commandWindowTimer.unref?.();
    s.commandTimer = setInterval(send, PROFILE_RETRY_MS);
    s.commandTimer.unref?.();
    send();
  }

  /** The weight-only reading the session holds from a valid ack on, or null. */
  private onAck(s: IfB2Session, ack: IfB2ProfileAck): ScaleReading | null {
    // A late ack, after the writes gave up, still answers one of them.
    if (s.writes === 0 || s.acked || s.completed || ack.profilePin !== '0001') {
      s.debugOnce('ack', 'Senssun IF_B2: ignoring a profile ack this session did not ask for');
      return null;
    }
    s.acked = true;
    this.stopWrites(s);
    bleLog.debug(
      `Senssun IF_B2: profile confirmed after ${s.writes} write(s), ` +
        `${Date.now() - s.firstWriteAt} ms after the first`,
    );
    if (ack.status !== 0)
      bleLog.debug(
        `Senssun IF_B2: profile ack status 0x${ack.status.toString(16).padStart(2, '0')}`,
      );
    const held: ScaleReading = { weight: s.stableWeight ?? 0, impedance: 0 };
    this.heldReadings.add(held);
    return held;
  }

  parseNotification(data: Buffer, profile?: UserProfile): ScaleReading | null {
    const s = this.s;
    let emitted: ScaleReading | null = null;
    for (const frame of s.reassembler.push(data)) {
      const decodeProfile = s.selected ?? s.ctx?.profile ?? profile;
      const decoded = decodeIfB2Frame(frame, decodeProfile);
      if (!decoded) continue;

      if (decoded.frameType === 'live_weight') {
        const display: ScaleReading = { weight: decoded.weightKg, impedance: 0 };
        this.considerLiveWeight(decoded.weightKg);
        if (!emitted) emitted = display;
        continue;
      }

      if (decoded.frameType === 'profile_ack') {
        const held = this.onAck(s, decoded);
        if (held) emitted = held;
        continue;
      }

      // Only this weigh-in's record: slot 0, the PIN every write uses, no age.
      // No log has shown any other, so what the rest would mean is unproven.
      if (
        decoded.profilePin !== '0001' ||
        decoded.recordSlot !== 0 ||
        decoded.elapsedSeconds !== 0
      ) {
        s.debugOnce('record', 'Senssun IF_B2: ignoring a record that is not this weigh-in');
        continue;
      }
      if (s.completed) continue;

      // A record without our ack is still this weigh-in; the processor decides
      // who it belongs to.
      s.completed = true;
      this.stopWrites(s);
      s.clearSelectionCandidate();
      const reading: ScaleReading<IfB2Composition> = {
        weight: decoded.weightKg,
        impedance: decoded.impedanceOhms,
        scaleComposition: { record: decoded, transmittedFatTenths: u16(frame, 12) },
      };
      this.recordReadings.add(reading);
      emitted = reading;
    }
    return emitted;
  }

  isComplete(reading: ScaleReading): boolean {
    return this.recordReadings.has(reading) || this.heldReadings.has(reading);
  }

  isFinal(reading: ScaleReading): boolean {
    return this.recordReadings.has(reading);
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    if (reading.impedance === 0) return buildPayload(reading.weight, 0, {}, profile);
    const pinned = reading.scaleComposition as IfB2Composition | undefined;
    if (!pinned) return buildPayload(reading.weight, reading.impedance, {}, profile);
    const record = pinned.record;
    const comp = {
      fat: record.fatPercent,
      water: record.waterPercent,
      muscle: record.musclePercent,
      bone: record.boneKg,
      bmr: record.bmr,
      bodyAge: record.bodyAge,
    };
    const payload = buildPayload(reading.weight, reading.impedance, comp, profile);
    if (comp.bmr !== undefined) payload.bmr = comp.bmr;
    if (comp.bodyAge !== undefined) payload.metabolicAge = comp.bodyAge;
    return payload;
  }
}
