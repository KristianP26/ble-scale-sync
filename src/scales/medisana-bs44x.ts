import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  MultiCharNotify,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload, type ScaleBodyComp } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { trustedScaleTime } from './sig-wss.js';
import { bleLog, normalizeUuid } from '../ble/types.js';
import { HISTORY_WINDOW_MS } from '../interfaces/reading-time.js';

const CHR_WEIGHT = uuid16(0x8a21);
const CHR_FEATURE = uuid16(0x8a22);
const CHR_WRITE = uuid16(0x8a81);

/** First byte of a 0x8A21 weight frame and of a 0x8A22 composition frame (#511, BS440.py). */
const WEIGHT_FRAME = 0x1d;
const FEATURE_FRAME = 0x6f;

/** Seconds from the Unix epoch to 2010-01-01T00:00:00Z. */
export const MEDISANA_EPOCH_2010_OFFSET = 1262304000;

/**
 * How far ahead of the host a record may be stamped and still be read. Our
 * time sync sets the clock on every connection, so a record further ahead was
 * stamped by a clock somebody else set (the vendor app, possibly on local
 * time); read, it would also lift the de-duplication mark past the weigh-ins
 * that follow.
 */
const FUTURE_SLACK_MS = 10 * 60 * 1000;

/**
 * The oldest a record may be and still be the weigh-in of this session. The
 * scale sends its memory seconds after the weigh-in (8 s in #511), while the
 * weigh-ins before it were 87 s and 161 s old; two weigh-ins rarely come
 * closer than a minute apart. Every other record is a stored one, flagged so
 * (D065): judged by age against the 5 min live window alone, a weigh-in a
 * minute older would take the live slot and the newer one would replace it in
 * the hold, losing it.
 */
const LIVE_RECORD_MAX_AGE_MS = 60 * 1000;

/** 2015-01-01T00:00:00Z, the floor `trustedScaleTime` applies, in Unix seconds. */
const MIN_MARK_SEC = 1420070400;

/**
 * Offset to subtract from Unix time for the time-sync command.
 *
 * openScale's MedisanaBs44xHandler predicts the epoch from the name: the
 * BS444/BS440 families ("013197", "013198", "0202b6") count seconds from
 * 2010-01-01, the BS430 ("0203b") and anything unrecognised count Unix
 * seconds. A BS444 sent Unix time sets its clock about 40 years ahead. Without
 * a name (a transport that saw none) Unix stays the default, as in openScale.
 */
export function medisanaTimeEpochOffset(deviceName: string | undefined): number {
  const name = (deviceName ?? '').toLowerCase();
  if (name.startsWith('013197') || name.startsWith('013198') || name.startsWith('0202b6')) {
    return MEDISANA_EPOCH_2010_OFFSET;
  }
  return 0;
}

/**
 * A record stamp in Unix seconds. One memory can hold both epochs: the #511
 * scale had 28 records counted from 2010 and 2 from a time its clock was set
 * in Unix seconds, so the epoch is picked per record, the one that lands
 * nearer the host's clock. The two readings are 40 years apart.
 */
export function medisanaRecordTime(raw: number, nowSec: number): number {
  const from2010 = raw + MEDISANA_EPOCH_2010_OFFSET;
  return Math.abs(from2010 - nowSec) <= Math.abs(raw - nowSec) ? from2010 : raw;
}

/** One record's two halves, keyed by the stamp both carry. */
interface RecordHalves {
  weight?: number;
  comp?: ScaleBodyComp;
}

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class MedisanaSession {
  /** Halves seen so far, by raw stamp. Order is not relied on: a proxy may reorder them. */
  halves = new Map<number, RecordHalves>();
  /** Raw stamps already settled this session, so a late or repeated half is ignored. */
  settled = new Set<number>();
  /** Time (Unix s) of the newest live record returned this session. */
  liveSec: number | undefined;
  /**
   * The mark when the session started. Records up to it were exported before;
   * the moving mark is not used, so a record that comes after a newer one of
   * the same memory still goes out.
   */
  floor: number | undefined;
  /** No mark when the session started: the stored records are not exported (D093). */
  baseline = false;
  baselineLogged = false;
  lateLogged = false;
  skippedLogged = false;
}

/** Decode a 12-bit field (the top nibble is a flag) in tenths. */
function tenths(data: Buffer, offset: number): number {
  return (data.readUInt16LE(offset) & 0x0fff) / 10;
}

/**
 * Adapter for Medisana BS444 / BS440 / BS430 BLE body-composition scales
 * (#511, D093).
 *
 * Protocol (log #511; openScale MedisanaBs44xHandler; keptenkurk/BS440):
 *   - Service 0x78B2. Indications on 0x8A21 (weight) and 0x8A22 (body
 *     composition), time sync written to 0x8A81: [0x02, u32 LE seconds].
 *   - After a weigh-in the scale sends its memory, oldest first: per record a
 *     0x8A21 frame and a 0x8A22 frame carrying the same stamp. The last record
 *     is the weigh-in itself. Then it ends the link.
 *   - 0x8A21: [1..2] weight u16 LE / 100 kg, [5..8] stamp u32 LE.
 *   - 0x8A22: [1..4] stamp u32 LE, [6..7] BMR kcal, [8..9] fat %, [10..11]
 *     water %, [12..13] muscle %, [14..15] bone kg; each u16 LE, low 12 bits,
 *     tenths except BMR.
 *
 * The memory comes on every connection, so a high-water mark (D032) keeps a
 * record from going out twice; the runtime persists it.
 */
export class MedisanaBs44xAdapter
  implements ScaleAdapterCore, GattWiring, MultiCharNotify, HoldForComposition
{
  readonly name = 'Medisana BS44x';
  readonly match: MatchDescriptor = {
    priority: 150,
    // startsWith, not exact: openScale matches all four families by prefix, and
    // these numeric names are firmware-generated, so a unit that appends a
    // suffix was missed by name and depended entirely on the 78b2 service
    // claim (#409).
    names: { startsWith: ['013197', '013198', '0202b6', '0203b'] },
    serviceUuids: ['78b2'],
  };
  readonly charNotifyUuid = CHR_WEIGHT;
  readonly charWriteUuid = CHR_WRITE;
  readonly characteristics: CharacteristicBinding[] = [
    // Composition first, as openScale enables them.
    { uuid: CHR_FEATURE, type: 'notify' },
    { uuid: CHR_WEIGHT, type: 'notify' },
    { uuid: CHR_WRITE, type: 'write' },
  ];
  /**
   * The live record is held, not resolved on: a later record in the same
   * memory may be newer. The scale ends the link right after its memory
   * (0.14 s in #511), which hands the held one over.
   */
  readonly completionHoldMs = 5000;

  private s = new MedisanaSession();
  /**
   * Newest record time (Unix s) returned, or seen in a baseline session; set
   * when the record is parsed, whether or not its export then succeeds.
   * Outlives sessions.
   */
  private mark: number | undefined;

  /**
   * Time sync: [0x02, u32 LE seconds]. The epoch depends on the model, which
   * only the advertised name tells apart (see medisanaTimeEpochOffset).
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const cmd = Buffer.alloc(5);
    cmd[0] = 0x02;
    cmd.writeUInt32LE(now - medisanaTimeEpochOffset(ctx.deviceName), 1);
    await ctx.write(this.charWriteUuid, [...cmd], true);
  }

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  onSessionStart(): void {
    this.s = new MedisanaSession();
    this.s.floor = this.mark;
    this.s.baseline = this.mark === undefined;
  }

  /** Frames are told apart by their characteristic; both are 19 bytes on the BS444. */
  parseNotification(): ScaleReading<ScaleBodyComp> | null {
    return null;
  }

  parseCharNotification(charUuid: string, data: Buffer): ScaleReading<ScaleBodyComp> | null {
    const uuid = normalizeUuid(charUuid);
    let raw: number;
    let half: RecordHalves;
    if (uuid === CHR_WEIGHT) {
      if (data.length < 9 || data[0] !== WEIGHT_FRAME) return null;
      raw = data.readUInt32LE(5);
      half = { weight: data.readUInt16LE(1) / 100 };
    } else if (uuid === CHR_FEATURE) {
      if (data.length < 16 || data[0] !== FEATURE_FRAME) return null;
      raw = data.readUInt32LE(1);
      half = { comp: this.parseComposition(data) };
    } else {
      return null;
    }
    if (this.s.settled.has(raw)) return null;
    const record = { ...this.s.halves.get(raw), ...half };
    if (record.weight === undefined || record.comp === undefined) {
      this.s.halves.set(raw, record);
      return null;
    }
    this.s.halves.delete(raw);
    this.s.settled.add(raw);
    return this.settle(raw, record.weight, record.comp);
  }

  private parseComposition(data: Buffer): ScaleBodyComp {
    const positive = (v: number) => (v > 0 ? v : undefined);
    return {
      bmr: positive(data.readUInt16LE(6) & 0x0fff),
      fat: positive(tenths(data, 8)),
      water: positive(tenths(data, 10)),
      muscle: positive(tenths(data, 12)),
      bone: positive(tenths(data, 14)),
    };
  }

  /** A record with both halves: the reading to return, or null when it is not exported. */
  private settle(
    raw: number,
    weight: number,
    comp: ScaleBodyComp,
  ): ScaleReading<ScaleBodyComp> | null {
    if (!(weight > 0)) return null;
    const nowMs = Date.now();
    const sec = medisanaRecordTime(raw, Math.floor(nowMs / 1000));
    const timestamp = trustedScaleTime(new Date(sec * 1000));
    if (!timestamp) {
      bleLog.debug(`Medisana: record with stamp ${raw} is before 2015 (clock not set), not read`);
      return null;
    }
    if (sec * 1000 > nowMs + FUTURE_SLACK_MS) {
      bleLog.debug(
        `Medisana: record stamped ${timestamp.toISOString()}, ahead of this host's clock, not read`,
      );
      return null;
    }
    if (this.s.floor !== undefined && sec <= this.s.floor) {
      if (!this.s.skippedLogged) {
        this.s.skippedLogged = true;
        bleLog.debug(
          `Medisana: records up to ${new Date(this.s.floor * 1000).toISOString()} were exported ` +
            'before, skipping them',
        );
      }
      return null;
    }

    const reading: ScaleReading<ScaleBodyComp> = {
      weight,
      impedance: 0,
      timestamp,
      scaleComposition: comp,
    };
    // The newest record close enough to now to be this session's weigh-in is
    // live; every other one is a stored record. Bounded on both sides: a record
    // stamped a few minutes ahead (within FUTURE_SLACK_MS) is not the weigh-in.
    const ageMs = nowMs - sec * 1000;
    const live =
      Math.abs(ageMs) <= LIVE_RECORD_MAX_AGE_MS &&
      (this.s.liveSec === undefined || sec > this.s.liveSec);
    if (live) this.s.liveSec = sec;
    else reading.fromMemory = true;
    if (!live && this.s.liveSec === undefined && ageMs > LIVE_RECORD_MAX_AGE_MS) {
      // Says why a weigh-in that arrived late went to the stored records: a
      // record between 60 s and 5 min old may be the weigh-in of this session.
      // It can also be an earlier one; the live record may still follow.
      if (ageMs <= HISTORY_WINDOW_MS && !this.s.lateLogged) {
        this.s.lateLogged = true;
        bleLog.info(
          `Medisana: a weigh-in from ${Math.round(ageMs / 1000)} s ago is older than ` +
            `${LIVE_RECORD_MAX_AGE_MS / 1000} s, so it is handled as a stored weigh-in, ` +
            'not as the one just taken',
        );
      }
    }

    this.mark = this.mark === undefined ? sec : Math.max(this.mark, sec);
    if (this.s.baseline && !live) {
      if (!this.s.baselineLogged) {
        this.s.baselineLogged = true;
        bleLog.info(
          'Medisana: first session, so the weigh-ins stored on the scale are not exported; ' +
            'from the next session on, new ones are.',
        );
      }
      return null;
    }
    return reading;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  /** Never final: a newer record of the same memory may still come. */
  isFinal(): boolean {
    return false;
  }

  /** The high-water mark, for the runtime to persist (D032). */
  dedupMark(): number | undefined {
    return this.mark;
  }

  /**
   * Take back a mark from an earlier process: a whole Unix second, 2015 or
   * later, at most FUTURE_SLACK_MS ahead (no record further ahead is read).
   */
  restoreDedupMark(mark: number): void {
    const maxSec = Math.floor((Date.now() + FUTURE_SLACK_MS) / 1000);
    if (!Number.isInteger(mark) || mark < MIN_MARK_SEC || mark > maxSec) return;
    if (this.mark === undefined || mark > this.mark) this.mark = mark;
  }

  computeMetrics(reading: ScaleReading<ScaleBodyComp>, profile: UserProfile): BodyComposition {
    // Per-reading snapshot taken in parseCharNotification(); the reading always
    // carries it, so there is no live cache to fall back on.
    return buildPayload(reading.weight, reading.impedance, reading.scaleComposition ?? {}, profile);
  }
}
