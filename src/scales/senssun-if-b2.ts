import type {
  AdapterRuntimeConfig,
  BleDeviceInfo,
  BodyComposition,
  ConnectionContext,
  ScaleAdapterCore,
  ScaleReading,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { buildPayload, uuid16 } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { isHistoricalReading } from '../interfaces/reading-time.js';

const CLOUD_HEADER = Buffer.from('100000c5', 'hex');
const LIVE_WEIGHT_FRAME = 0x80;
const PROFILE_ACK_FRAME = 0x81;
const HEALTH_RECORD_FRAME = 0x82;
const MAX_BUFFER = 4096;
const PROFILE_RETRY_MS = 200;
const PROFILE_TIMEOUT_MS = 5_000;
const SELECTION_QUIET_MS = 2_000;

class IfB2ProfileAcknowledgementError extends Error {}

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
  division?: number;
  elapsedSeconds: number;
  profilePin: string;
  raw: string;
  compositionSource?: string;
  derivedFatSource?: 'derived' | 'transmitted';
}
export interface IfB2ProfileAck {
  frameType: 'profile_ack';
  status: 'created' | 'updated' | 'deleted' | 'full';
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
function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`non-finite ${name}`);
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
      if (length !== 11 && length !== 14 && length !== 29 && length !== 30) {
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

export function decodeIfB2Frame(frame: Buffer, profile?: UserProfile): IfB2Frame {
  if (frame.length < 8 || !frame.subarray(0, 4).equals(CLOUD_HEADER))
    throw new Error('invalid IF_B2 header');
  if (frame[4] !== frame.length) throw new Error('invalid declared length');
  if (frame[5] !== 0x03) throw new Error('unsupported IF_B2 namespace');
  const checksum = frame.subarray(4, -1).reduce((sum, value) => (sum + value) & 0xff, 0);
  if (frame.at(-1) !== checksum) throw new Error('invalid additive checksum');
  if (frame[6] === PROFILE_ACK_FRAME) {
    if (frame.length !== 11) throw new Error('invalid profile-acknowledgement length');
    if (frame.subarray(8, 10).toString('hex') !== '0001')
      throw new Error('IF_B2 profile acknowledgement did not identify PIN 0001');
    const status = ['created', 'updated', 'deleted', 'full'] as const;
    if (frame[7] >= status.length)
      throw new IfB2ProfileAcknowledgementError(
        `unsupported profile acknowledgement 0x${frame[7].toString(16).padStart(2, '0')}`,
      );
    return {
      frameType: 'profile_ack',
      status: status[frame[7]],
      raw: frame.toString('hex'),
    };
  }
  if (frame[6] === LIVE_WEIGHT_FRAME) {
    if (frame.length !== 14) throw new Error('invalid live-weight length');
    const result: IfB2LiveWeight = {
      frameType: 'live_weight',
      weightKg: u16(frame, 7) / 10,
      weightLb: u16(frame, 9) / 10,
      unitCode: frame[11],
      control: frame[12],
      stable: frame[12] === 0xaa,
      raw: frame.toString('hex'),
    };
    assertFinite(result.weightKg, 'weight');
    if (result.weightKg < 0) throw new Error('invalid weight');
    return result;
  }
  if (frame[6] !== HEALTH_RECORD_FRAME || ![29, 30].includes(frame.length))
    throw new Error('unsupported IF_B2 frame type or length');
  if (frame[7] === 0xff) throw new Error('rejected record end marker');
  const division = frame.length === 30 ? frame[28] >> 4 : undefined;
  if (division !== undefined && division > 2) throw new Error('unsupported division');
  const weightKg = u16(frame, 10) / (division === 1 || division === 2 ? 100 : 10);
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
    ...(division === undefined ? {} : { division }),
    raw: frame.toString('hex'),
  };
  for (const [name, value] of Object.entries(result))
    if (typeof value === 'number') assertFinite(value, name);
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
    throw new Error('invalid health measurements');
  if (profile) {
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
  if (profile.gender !== 'male' && profile.gender !== 'female')
    throw new Error('invalid profile gender');
  if (!(profile.height > 0) || !(profile.age >= 1)) throw new Error('invalid profile');
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

export function buildCloudProfileCommand(profile: UserProfile, weightKg: number): Buffer {
  if (
    !Number.isFinite(profile.height) ||
    profile.height < 50 ||
    profile.height > 250 ||
    !Number.isInteger(profile.age) ||
    profile.age < 1 ||
    profile.age > 120 ||
    !Number.isFinite(weightKg) ||
    weightKg <= 0 ||
    weightKg >= 0x10000
  )
    throw new Error('invalid IF_B2 cloud profile');
  const bytes = Buffer.from('100000c5130301000000010000000000000000', 'hex');
  bytes[11] = profile.gender === 'male' ? 1 : 0;
  bytes[12] = Math.round(profile.height);
  bytes[13] = profile.age;
  bytes[14] = profile.isAthlete ? 5 : 0;
  bytes[15] = 0;
  bytes.writeUInt16BE(Math.trunc(weightKg), 16);
  bytes[18] = bytes.subarray(4, 18).reduce((sum, value) => (sum + value) & 0xff, 0);
  return bytes;
}

export class SenssunIfB2Adapter implements ScaleAdapterCore {
  readonly name = 'Senssun IF_B2';
  readonly match: MatchDescriptor = { priority: 300, names: { exact: ['if_b2'] } };
  readonly serviceUuid = uuid16(0xfff0);
  readonly charNotifyUuid = uuid16(0xfff1);
  readonly charWriteUuid = uuid16(0xfff2);
  private reassembler = new IfB2Reassembler();
  private ctx: ConnectionContext | undefined;
  private stableWeight: number | undefined;
  /** From configure(): process lifetime, replaced on every config reload. */
  private profileForWeight: AdapterRuntimeConfig['profileForWeight'];
  private candidateWeight: number | undefined;
  private selected: UserProfile | undefined;
  private selectionAttempted = false;
  private profileAcknowledged = false;
  private completed = false;
  private selectionTimer: NodeJS.Timeout | undefined;
  private commandTimer: NodeJS.Timeout | undefined;
  private commandWindowTimer: NodeJS.Timeout | undefined;
  private profileWriteInFlight = false;
  private pendingRecord:
    { record: IfB2HealthRecord; transmittedFatTenths: number; timestamp: Date } | undefined;
  private pendingCommandError: Error | undefined;
  private sessionToken = 0;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  configure(opts: AdapterRuntimeConfig): void {
    this.profileForWeight = opts.profileForWeight;
  }

  onSessionStart(): void {
    this.sessionToken++;
    this.resetSessionState();
  }

  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.ctx = undefined;
    const missing = [this.charNotifyUuid, this.charWriteUuid].filter(
      (uuid) => !ctx.availableChars.has(uuid),
    );
    if (missing.length) throw new Error(`IF_B2 discovery race: missing ${missing.join(', ')}`);
    this.ctx = ctx;
  }

  onSessionEnd(): void {
    this.sessionToken++;
    this.resetSessionState();
  }

  private resetSessionState(): void {
    this.clearTimers();
    this.ctx = undefined;
    this.reassembler = new IfB2Reassembler();
    this.candidateWeight = undefined;
    this.stableWeight = undefined;
    this.selected = undefined;
    this.selectionAttempted = false;
    this.profileAcknowledged = false;
    this.completed = false;
    this.profileWriteInFlight = false;
    this.pendingCommandError = undefined;
    this.pendingRecord = undefined;
  }

  private clearSelectionCandidate(): void {
    clearTimeout(this.selectionTimer);
    this.selectionTimer = undefined;
    this.candidateWeight = undefined;
  }

  private clearTimers(): void {
    clearTimeout(this.selectionTimer);
    clearInterval(this.commandTimer);
    clearTimeout(this.commandWindowTimer);
    this.selectionTimer = undefined;
    this.commandTimer = undefined;
    this.commandWindowTimer = undefined;
  }

  private considerLiveWeight(weightKg: number): void {
    if (this.selectionAttempted || this.completed) return;
    if (weightKg === 0) {
      this.clearSelectionCandidate();
      return;
    }

    if (this.candidateWeight === weightKg) return;

    this.clearSelectionCandidate();
    this.candidateWeight = weightKg;
    const token = this.sessionToken;
    this.selectionTimer = setTimeout(() => {
      const weight = this.candidateWeight;
      if (token !== this.sessionToken || !this.ctx || weight === undefined || this.completed)
        return;
      this.candidateWeight = undefined;
      this.selectionTimer = undefined;
      this.selectionAttempted = true;
      this.stableWeight = weight;
      // Once per weigh-in, on the settled weight. Nobody matching still writes
      // users[0]: the ack answers a write, and no log shows a weigh-in without
      // one, so skipping it could leave no reading. The processor decides who
      // the reading belongs to.
      this.selected = this.profileForWeight?.(weight) ?? this.ctx.profile;
      this.startProfileWrites();
    }, SELECTION_QUIET_MS);
  }

  private writeProfile(command: Buffer, token: number): void {
    const ctx = this.ctx;
    if (!ctx || token !== this.sessionToken || this.profileWriteInFlight) return;
    this.profileWriteInFlight = true;
    void ctx
      .write(this.charWriteUuid, command, true)
      .catch((error: unknown) => {
        if (token !== this.sessionToken || this.profileAcknowledged || this.completed) return;
        this.clearTimers();
        const detail = error instanceof Error ? error.message : String(error);
        this.pendingCommandError = new Error(`IF_B2 profile write failed: ${detail}`);
      })
      .finally(() => {
        if (token === this.sessionToken) this.profileWriteInFlight = false;
      });
  }

  private startProfileWrites(): void {
    const selected = this.selected;
    const weight = this.stableWeight;
    if (!this.ctx || !selected || weight === undefined) return;
    const token = this.sessionToken;
    let command: Buffer;
    try {
      command = buildCloudProfileCommand(selected, weight);
    } catch (error) {
      this.clearTimers();
      this.pendingCommandError = error instanceof Error ? error : new Error(String(error));
      return;
    }
    const send = () => {
      if (
        token !== this.sessionToken ||
        !this.ctx ||
        this.profileAcknowledged ||
        this.completed ||
        this.pendingCommandError
      )
        return;
      this.writeProfile(command, token);
    };
    this.commandWindowTimer = setTimeout(() => {
      if (token !== this.sessionToken || this.profileAcknowledged || this.completed) return;
      this.clearTimers();
      this.pendingCommandError = new Error('IF_B2 profile acknowledgement timed out');
    }, PROFILE_TIMEOUT_MS);
    this.commandTimer = setInterval(send, PROFILE_RETRY_MS);
    send();
  }

  private completePendingRecord(): ScaleReading | null {
    if (!this.pendingRecord || !this.selected || !this.profileAcknowledged || this.completed)
      return null;

    const { record: decoded, transmittedFatTenths, timestamp } = this.pendingRecord;
    this.pendingRecord = undefined;
    this.completed = true;
    this.clearTimers();
    this.pendingCommandError = undefined;
    const reading: ScaleReading<IfB2Composition> = {
      weight: decoded.weightKg,
      impedance: decoded.impedanceOhms,
      timestamp,
      scaleComposition: { record: decoded, transmittedFatTenths },
    };
    return reading;
  }

  parseNotification(data: Buffer, profile?: UserProfile): ScaleReading | null {
    if (this.pendingCommandError) {
      const error = this.pendingCommandError;
      this.pendingCommandError = undefined;
      throw error;
    }

    let emitted: ScaleReading | null = null;
    for (const frame of this.reassembler.push(data)) {
      let decoded: IfB2Frame;
      try {
        const decodeProfile = this.selected ?? (this.ctx ? this.ctx.profile : profile);
        decoded = decodeIfB2Frame(frame, decodeProfile);
      } catch (error) {
        if (error instanceof IfB2ProfileAcknowledgementError) {
          this.clearTimers();
          this.pendingCommandError = undefined;
          throw error;
        }
        continue;
      }

      if (decoded.frameType === 'live_weight') {
        const display: ScaleReading = { weight: decoded.weightKg, impedance: 0 };
        this.considerLiveWeight(decoded.weightKg);
        if (!emitted) emitted = display;
        continue;
      }

      if (decoded.frameType === 'profile_ack') {
        if (!this.selected || this.completed) continue;
        this.clearTimers();
        this.pendingCommandError = undefined;
        if (decoded.status === 'deleted')
          throw new Error('IF_B2 returned an unexpected profile-delete acknowledgement');
        if (decoded.status === 'full')
          throw new Error('IF_B2 profile storage is full; PIN 0001 is unavailable');
        this.profileAcknowledged = true;
        const reading = this.completePendingRecord();
        if (reading) emitted = reading;
        continue;
      }

      if (!this.selected && !this.ctx && profile) {
        const reading: ScaleReading<IfB2Composition> = {
          weight: decoded.weightKg,
          impedance: decoded.impedanceOhms,
          timestamp: new Date(Date.now() - decoded.elapsedSeconds * 1_000),
          scaleComposition: { record: decoded, transmittedFatTenths: u16(frame, 12) },
        };
        emitted = reading;
        continue;
      }

      if (decoded.profilePin !== '0001' || decoded.recordSlot !== 0 || decoded.elapsedSeconds > 600)
        continue;
      if (!this.selected || this.stableWeight === undefined)
        throw new Error('IF_B2 final record arrived before safe profile selection');
      if (this.completed) continue;

      if (!this.pendingRecord) {
        this.pendingRecord = {
          record: decoded,
          transmittedFatTenths: u16(frame, 12),
          timestamp: new Date(Date.now() - decoded.elapsedSeconds * 1_000),
        };
      }
      const reading = this.completePendingRecord();
      if (reading) emitted = reading;
    }
    return emitted;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    if (reading.impedance === 0) return buildPayload(reading.weight, 0, {}, profile);
    const pinned = reading.scaleComposition as IfB2Composition | undefined;
    if (!pinned) return buildPayload(reading.weight, reading.impedance, {}, profile);
    const record = pinned.record;
    // Stored readings are attributed independently at export time. Recompute
    // their profile-dependent values for that user, not the live session user.
    const comp = isHistoricalReading(reading)
      ? deriveComposition(reading.weight, reading.impedance, profile, pinned.transmittedFatTenths)
      : {
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
