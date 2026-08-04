import { computeBiaFat, buildPayload, uuid16 } from './body-comp-helpers.js';
import type {
  BleDeviceInfo,
  CharacteristicBinding,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  MultiCharNotify,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { bleLog, normalizeUuid } from '../ble/types.js';
import type { MatchDescriptor } from './match-descriptor.js';

/**
 * A&D Medical UC-450BLE body-composition scale (Lifesense OEM, vendor service
 * 0xA602).
 *
 * Decoded from an iOS PacketLogger capture of the A&D Heart Track app, since no
 * public documentation of this protocol exists. The device reports
 * `Manufacturer Name String` = "Lifesense" and advertises service 0xA602 with a
 * `12 34 56 78` manufacturer-data magic followed by its MAC.
 *
 * Characteristic roles (the important part — three of the six are decoys):
 *   A620  indicate  unused by the vendor app
 *   A621  notify    scale -> host data channel (status + measurement records)
 *   A622  write-nr  host -> scale ACK channel, always `00 01 01`
 *   A623  write     never touched by the vendor app
 *   A624  write-nr  host -> scale COMMAND channel
 *   A625  notify    scale -> host ACK channel, always `00 01 01`
 *
 * Framing is `[0x10][len][subcommand][payload...]` where `len` counts every byte
 * after itself. Every scale->host frame on A621 is acknowledged by writing
 * `00 01 01` to A622; the scale likewise ACKs each command on A625.
 *
 * Captured session (host writes marked ->, scale notifies <-):
 *   <- A621  10 0A 00 07 00 00 00 00 00 00 00 52     status / idle
 *   -> A622  00 01 01                                 ack
 *   -> A624  10 0B 00 08 01 00 00 00 00 00 00 01 01   host hello
 *   <- A625  00 01 01
 *   -> A624  10 08 10 02 03 6A70FBA3 FC               time sync + tz
 *   <- A625  00 01 01
 *   <- A621  10 05 10 00 10 02 01                     time accepted
 *   -> A622  00 01 01
 *   -> A624  10 04 48 01 00 01                        fetch stored record
 *   <- A621  10 11 48 02 ... measurement ...          one stored record
 *   -> A622  00 01 01                                 ack, then fetch again
 *
 * Measurement record (subcommand 0x48, 19 bytes total):
 *   [0]      0x10 frame type
 *   [1]      0x11 length (17)
 *   [2]      0x48 record type
 *   [3]      0x02 record subtype
 *   [4]      0x00
 *   [5]      records still queued after this one, counting down to 0x00
 *   [6]      0x00
 *   [7]      user / profile slot (0x01)
 *   [8-9]    flags (0x4008 in the capture)
 *   [10-11]  weight, BE uint16, / 100 kg
 *   [12-15]  timestamp, BE uint32, Unix seconds (UTC)
 *   [16-17]  impedance, BE uint16, ohms — `00 00` on a weight-only record
 *   [18]     0x00 trailer
 *
 * Verified against a known weigh-in: `26 D9` -> 99.45 kg (219.2 lb, reported as
 * 218.9 lb), impedance 395/391 ohm, and timestamps that match the capture wall
 * clock exactly at UTC-4.
 *
 * The scale never streams live frames — it only replays stored records when
 * asked, which is why the two records in the capture arrived 1.2s apart on the
 * wire while their timestamps were 22s apart.
 */

const CHR_A620 = uuid16(0xa620);
const CHR_A621 = uuid16(0xa621);
const CHR_A622 = uuid16(0xa622);
const CHR_A624 = uuid16(0xa624);
const CHR_A625 = uuid16(0xa625);

const SVC_A602 = 'a602';

/**
 * Advertised manufacturer data is `12 34 56 78 <type> <mac…>`. Noble splits the
 * leading two bytes off as the company id, so the 4-byte magic arrives as a
 * little-endian id of 0x3412 plus `56 78` at the head of the payload.
 */
const MFG_COMPANY_ID = 0x3412;
const MFG_MAGIC_TAIL = [0x56, 0x78];

/** Frame type byte shared by every vendor frame in both directions. */
const FRAME_TYPE = 0x10;

/** Subcommands seen on A621. */
const SUB_STATUS = 0x00;
const SUB_TIME = 0x10;
const SUB_RECORD = 0x48;

/** The universal acknowledgement written to A622 / notified on A625. */
const ACK = [0x00, 0x01, 0x01];

/** Host hello, replayed verbatim from the capture. */
const HELLO = [0x10, 0x0b, 0x00, 0x08, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01];

/** Fetch-next-stored-record command. */
const FETCH_RECORD = [0x10, 0x04, 0x48, 0x01, 0x00, 0x01];

/** Full measurement record length, including the 2-byte header. */
const RECORD_LEN = 19;

/**
 * Stand-in when a record is too short to carry the remaining-record counter.
 * Any non-zero value keeps the dump going under the MAX_RECORDS backstop.
 */
const UNKNOWN_REMAINING = -1;

/**
 * Bound on how many stored records we pull in one session. The scale holds up
 * to 200; without a cap a scale with a full history would keep the link open
 * far past the point of usefulness. Mirrors the bounded-retry approach the QN
 * adapter uses for its stored-data queries.
 */
const MAX_RECORDS = 24;

/**
 * A record younger than this (relative to connect time) is treated as the live
 * weigh-in rather than history, so a normal step-on-and-read resolves
 * immediately instead of waiting for the scale to auto-off. Older records carry
 * `timestamp` and are routed into `RawReading.history` by the BLE handler.
 * Same rationale and window as the QN adapter's stored-record freshness gate.
 */
const FRESH_RECORD_SEC = 90;

export class Uc450bleAdapter implements ScaleAdapterCore, GattWiring, MultiCharNotify {
  readonly name = 'A&D UC-450BLE';
  readonly match: MatchDescriptor = {
    priority: 245,
    custom: true,
    names: { startsWith: ['uc-450'] },
    serviceUuids: [SVC_A602],
    charUuids: ['a621', 'a624'],
  };

  // Legacy single-char fields; the multi-char bindings below are what the
  // handler actually wires up.
  readonly charNotifyUuid = CHR_A621;
  readonly charWriteUuid = CHR_A624;
  readonly normalizesWeight = true;

  readonly characteristics: CharacteristicBinding[] = [
    { uuid: CHR_A621, type: 'notify' },
    { uuid: CHR_A625, type: 'notify' },
    // Present on the device but never used by the vendor app; subscribing is
    // harmless and keeps an unexpected firmware variant observable in logs.
    { uuid: CHR_A620, type: 'notify', optional: true },
    { uuid: CHR_A622, type: 'write' },
    { uuid: CHR_A624, type: 'write' },
  ];

  private ctx: ConnectionContext | null = null;

  /** Unix seconds at connect, the reference for record freshness. */
  private sessionStartedSec = 0;

  /** Records pulled this session, bounding the fetch loop. */
  private recordsSeen = 0;

  /** Guards so a repeated status frame cannot restart the handshake. */
  private helloSent = false;
  private fetchStarted = false;

  /**
   * Resolver for the in-flight A625 acknowledgement, if any.
   *
   * The scale tolerates exactly one outstanding command: the vendor app writes
   * to A624, waits for the A625 ACK, and only then sends the next command.
   * Firing two write-without-response commands back to back (they land in the
   * same connection interval) makes the scale acknowledge once and then go
   * silent for the rest of the session — it stops even emitting its 3s status
   * heartbeat, so nothing recovers it.
   */
  private ackResolve: (() => void) | null = null;

  /** Longest we wait for an A625 ACK before sending the next command anyway. */
  private static readonly ACK_TIMEOUT_MS = 1500;

  onConnected(ctx: ConnectionContext): void {
    this.ctx = ctx;
    this.ackResolve = null;
    this.sessionStartedSec = Math.floor(Date.now() / 1000);
    this.recordsSeen = 0;
    this.helloSent = false;
    this.fetchStarted = false;
    // No opening write: the scale speaks first with a status frame on A621, and
    // every subsequent command is a response to something it sent.
  }

  matches(device: BleDeviceInfo): boolean {
    const name = (device.localName || '').toLowerCase();
    if (name.startsWith('uc-450')) return true;

    const uuids = (device.serviceUuids || []).map((u) => u.toLowerCase());
    if (uuids.some((u) => u === SVC_A602 || u === uuid16(0xa602))) return true;

    const mfg = device.manufacturerData;
    if (
      mfg &&
      mfg.id === MFG_COMPANY_ID &&
      mfg.data.length >= MFG_MAGIC_TAIL.length &&
      MFG_MAGIC_TAIL.every((b, i) => mfg.data[i] === b)
    ) {
      return true;
    }

    // Post-discovery: the A621 + A624 pair is unique to this vendor service.
    const chars = (device.characteristicUuids || []).map((u) => u.toLowerCase());
    const hasNotify = chars.some((u) => u === 'a621' || u === CHR_A621);
    const hasWrite = chars.some((u) => u === 'a624' || u === CHR_A624);
    return hasNotify && hasWrite;
  }

  /**
   * A625 carries only ACKs. Routing it here keeps those frames out of
   * parseNotification, which would otherwise log them as unrecognised data.
   */
  parseCharNotification(charUuid: string, data: Buffer): ScaleReading | null {
    // A625 carries only command acknowledgements; each one releases the next
    // queued command rather than producing a reading.
    if (normalizeUuid(charUuid) === CHR_A625) {
      this.releaseAck();
      return null;
    }
    return this.parseNotification(data);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3 || data[0] !== FRAME_TYPE) return null;

    // On macOS the first status frame can arrive before onConnected() runs, so
    // there is nothing to write with yet. Bail before the one-shot handshake
    // guards are consumed; the scale repeats the frame every ~3s.
    if (!this.ctx) return null;

    switch (data[2]) {
      case SUB_STATUS:
        void this.handleStatus();
        return null;

      case SUB_TIME:
        void this.handleTimeAccepted();
        return null;

      case SUB_RECORD:
        return this.parseRecord(data);

      default:
        bleLog.debug(
          `UC-450BLE: ignoring subcommand 0x${data[2].toString(16).padStart(2, '0')} ` +
            `(${data.length}B): ${data.toString('hex')}`,
        );
        return null;
    }
  }

  /** Decode a 0x48 stored measurement record. */
  private parseRecord(data: Buffer): ScaleReading | null {
    // Byte [5] counts the records still queued behind this one and reaches 0 on
    // the last. Read it before requesting anything, so the final record ends the
    // dump instead of provoking a fetch the scale will never answer. A record
    // too short to carry the counter leaves it unknown, and the MAX_RECORDS cap
    // remains the backstop.
    const remaining = data.length >= RECORD_LEN ? data[5] : UNKNOWN_REMAINING;

    // Acknowledge regardless of whether this record is usable — a malformed or
    // implausible one must not stall the dump, since the scale only sends the
    // next in response to our fetch.
    void this.ackAndFetchNext(remaining);

    if (data.length < RECORD_LEN) {
      bleLog.debug(`UC-450BLE: short record (${data.length}B): ${data.toString('hex')}`);
      return null;
    }

    const weight = data.readUInt16BE(10) / 100;
    const recordedAt = data.readUInt32BE(12);
    const impedance = data.readUInt16BE(16);

    if (weight <= 5 || weight >= 300 || !Number.isFinite(weight)) {
      bleLog.debug(`UC-450BLE: implausible weight ${weight} kg, ignoring record`);
      return null;
    }

    const ageSec = this.sessionStartedSec - recordedAt;
    const isHistorical = ageSec > FRESH_RECORD_SEC;

    bleLog.debug(
      `UC-450BLE: record ${weight.toFixed(2)} kg / ${impedance} Ohm ` +
        `@ ${new Date(recordedAt * 1000).toISOString()} (${isHistorical ? 'history' : 'live'})`,
    );

    return isHistorical
      ? { weight, impedance, timestamp: new Date(recordedAt * 1000) }
      : { weight, impedance };
  }

  // ─── Handshake (fire-and-forget from parseNotification) ──────────────────

  /** Respond to the status frame with an ACK, the hello, and a time sync. */
  private async handleStatus(): Promise<void> {
    if (!this.helloSent) {
      this.helloSent = true;
      await this.ack();
      await this.command(HELLO);
      await this.command(this.buildTimeSync());
      return;
    }

    // The scale repeats this status frame roughly every 3s for as long as the
    // link is up. If the time-sync reply that normally starts the record dump
    // never arrived, treat the repeat as a retry rather than sitting idle for
    // the rest of the session. The handshake itself is not re-sent.
    if (!this.fetchStarted) {
      this.fetchStarted = true;
      bleLog.debug('UC-450BLE: no time-sync reply, starting record fetch from status repeat');
      await this.ack();
      await this.command(FETCH_RECORD);
    }
  }

  /** The scale accepted the time; start pulling stored records. */
  private async handleTimeAccepted(): Promise<void> {
    if (this.fetchStarted) return;
    this.fetchStarted = true;
    await this.ack();
    await this.command(FETCH_RECORD);
  }

  /**
   * ACK a delivered record and request the next one, unless the record's own
   * counter says it was the last (or the safety cap is hit).
   */
  private async ackAndFetchNext(remaining: number): Promise<void> {
    await this.ack();
    this.recordsSeen += 1;

    if (remaining === 0) {
      bleLog.debug('UC-450BLE: last record (0 remaining), dump complete');
      return;
    }
    if (this.recordsSeen >= MAX_RECORDS) {
      bleLog.debug(`UC-450BLE: reached the ${MAX_RECORDS}-record cap, stopping fetch`);
      return;
    }
    await this.command(FETCH_RECORD);
  }

  /**
   * Time sync: `10 08 10 02 03 <unix BE uint32> <tz>`, where `tz` is the local
   * UTC offset in whole hours as a signed byte (the capture used 0xFC = -4 for
   * EDT, with a UTC timestamp).
   */
  private buildTimeSync(): number[] {
    const now = Math.floor(Date.now() / 1000);
    const tzHours = -Math.round(new Date().getTimezoneOffset() / 60);
    return [
      0x10,
      0x08,
      0x10,
      0x02,
      0x03,
      (now >>> 24) & 0xff,
      (now >>> 16) & 0xff,
      (now >>> 8) & 0xff,
      now & 0xff,
      tzHours & 0xff,
    ];
  }

  private async ack(): Promise<void> {
    await this.write(CHR_A622, ACK);
  }

  /**
   * Send one command on A624 and wait for its A625 acknowledgement before
   * returning, so at most one command is ever outstanding. The timeout keeps a
   * missing ACK from wedging the session; proceeding is strictly better than
   * stopping, since the alternative is no reading at all.
   */
  private async command(data: number[]): Promise<void> {
    await this.write(CHR_A624, data);
    await this.awaitAck();
  }

  private awaitAck(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.ackResolve = null;
        bleLog.debug('UC-450BLE: no A625 ack within timeout, continuing');
        resolve();
      }, Uc450bleAdapter.ACK_TIMEOUT_MS);
      this.ackResolve = () => {
        clearTimeout(timer);
        this.ackResolve = null;
        resolve();
      };
    });
  }

  private releaseAck(): void {
    this.ackResolve?.();
  }

  /** Both vendor write characteristics are write-without-response. */
  private async write(charUuid: string, data: number[]): Promise<void> {
    if (!this.ctx) return;
    try {
      await this.ctx.write(charUuid, data, false);
      bleLog.debug(`UC-450BLE write ${charUuid.slice(4, 8)}: ${Buffer.from(data).toString('hex')}`);
    } catch (err) {
      bleLog.debug(`UC-450BLE write to ${charUuid} failed: ${String(err)}`);
    }
  }

  isComplete(reading: ScaleReading): boolean {
    if (reading.weight <= 10) return false;
    // Impedance 0 means the record carried no BIA; the weight is still usable.
    return reading.impedance === 0 || reading.impedance > 200;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}
