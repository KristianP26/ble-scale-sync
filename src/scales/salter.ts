import type {
  AckProtocol,
  BleDeviceInfo,
  BodyComposition,
  GattWiring,
  HoldForComposition,
  ScaleAdapterCore,
  ScaleReading,
  Unlockable,
  UserProfile,
} from '../interfaces/scale-adapter.js';
import { uuid16, buildPayload } from './body-comp-helpers.js';
import { bleLog } from '../ble/types.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';

// ─── Salter smart scale (0xFFCC "Healthcare ELectronic" command protocol) ────

const CHR_FFC1 = uuid16(0xffc1);

/**
 * Opcodes decoded from an iOS PacketLogger trace of the Salter Health app doing
 * one weigh-in, then corrected against live hardware. Every command is written
 * to FFC1 write-without-response and the reply arrives as a notification on that
 * same characteristic. FFC2 and FFC3 are advertised as notify and the app
 * subscribes to both, but neither ever carried a byte: the entire protocol lives
 * on FFC1.
 *
 * Not used here, but decoded and recorded so the next person does not have to:
 *   03 <i> <5 bytes>   write a user profile      04 <i>  read one back
 *   0a <i> <n>         clear the record at queue position n; answered `0a <i> 00`
 */
const CMD_SET_CLOCK = 0x01; // `01 <seconds u32 LE>` -> `01 00`; only when unset
const CMD_PING = 0x0b; // keepalive; the vendor app sends it before every poll
const CMD_CLOCK = 0x02; // `02` → `02 <seconds u32 LE>`, the scale's own clock
const CMD_STATUS = 0x08; // `08 <index>` → `08 <index> <count>`, records queued in that slot
const CMD_FETCH = 0x09; // `09 <index> <pos>` → the 20-byte record at that queue position

/** `02 <u32 LE>`: opcode plus the clock, five bytes. */
const CLOCK_REPLY_LEN = 5;

/** `01 00`: the scale's acknowledgement of a clock write. */
const SET_CLOCK_ACK_LEN = 2;

/** `08 <index> <count>`: opcode, slot, queued-record count — three bytes. */
const STATUS_REPLY_LEN = 3;

/**
 * Below this the scale's clock is not a wall clock, so it has never been set.
 *
 * A scale whose batteries have just been changed counts up from zero, and in
 * that state it stores no measurements at all (see the class comment). This
 * separates the two cases cleanly: 2020-09-13 is long past, so any real Unix
 * time the scale could hold is above it, while a bare uptime counter would need
 * fifty years of running to reach it.
 */
const MIN_PLAUSIBLE_CLOCK_SEC = 1_600_000_000;

/**
 * How far ahead of the scale's clock a record may legitimately be stamped.
 *
 * Covers a weigh-in taken mid-session, after this session's clock read: the poll
 * restarts every few seconds and the link is held open for a few more, so a
 * handful of seconds of "future" is normal. Anything beyond it is a record from
 * before the clock was reset — see `isFromAnotherEpoch`.
 */
const FUTURE_TOLERANCE_SEC = 60;

/**
 * How far BEHIND the scale's own clock a record may be and still count as this
 * weigh-in.
 *
 * Without this bound the only staleness guard is `lastReportedTs`, an in-memory
 * high-water mark that starts at zero on every process start. The first session
 * after a restart would therefore accept the newest record the scale still
 * holds, whatever its age, and publish it as today's weight. This project has
 * already shipped that bug once on another protocol family, where a stored
 * record six days old published 67.10 kg for a 75 kg user, and it reads as "the
 * numbers are occasionally wrong" rather than as an obvious failure.
 *
 * Five minutes is deliberately generous rather than tight. The scale records a
 * weigh-in the moment it settles and the host may only poll a little later: the
 * sweep restarts every few seconds, but a continuous-mode run reconnects on its
 * own cadence, and someone who steps off before the host connects should still
 * get their reading. Anything older than this is buffer the scale never forgets.
 */
const MAX_RECORD_AGE_SEC = 300;

/**
 * Plausibility ceiling on the decoded weight, matching `koogeek-s1.ts`.
 *
 * The weight field is a bare u16, so on its own it accepts up to 6553.5 kg. Any
 * 20-byte frame whose first byte is under 8 is treated as a record here, so a
 * garbled frame, or a firmware variant answering some other opcode with a
 * 20-byte reply, would otherwise decode to an absurd weight and be exported.
 * No matching floor: the 7.4 kg fixture shows light loads are legitimate.
 */
const MAX_WEIGHT_KG = 300;

/**
 * Number of record indexes the scale exposes. Measurements are NOT kept in one
 * fixed place: a sweep of a live unit found records at indices 2, 6 and 7 with
 * the rest empty, and the index a given weigh-in occupies is not predictable
 * from anything the client can see, so all of them are read.
 */
const RECORD_SLOTS = 8;

/**
 * How often the sweep is kicked off. Each tick sends only a keepalive and a
 * clock read; the slot walk chains itself off the replies (see `buildAck`), so
 * this is the restart interval rather than the pace of the sweep itself.
 */
const SWEEP_INTERVAL_MS = 3000;

/**
 * How long the link is held open after the first record decodes.
 *
 * A sweep issues a count probe per slot and up to two fetches for each slot
 * that holds records, and the replies trickle back over a second or two, so the
 * window has to outlast a full cycle rather than ending the session on the first
 * frame that decodes. It also covers the case where the scale is mid-reply when
 * the first record lands.
 */
const COMPLETION_HOLD_MS = 5000;

/**
 * Measurement record: `<slot> <position> | <unix seconds u32 LE> | <7 x u16 LE>`.
 *
 * The second byte echoes the queue position that was asked for: `09 01 01` was
 * answered `01 01 ...` in the vendor-app trace. Every earlier capture read
 * position 0, which is why the older fixtures all carry `00` there. It is
 * logged, so a hardware run shows which end of a queue a record came from, but
 * nothing is decided by it.
 *
 * The seven trailing fields are weight, body fat %, body water %, muscle mass %,
 * bone mass kg, BMR kcal and BMI — each scaled by ten except BMR, a whole number
 * of kilocalories. Confirmed field by field against the Salter Health app's own
 * display for the same reading, and the weight against six weigh-ins called out
 * from the scale (87.6, 85.7, 88.0, 88.8, 89.7, 7.4 kg).
 *
 * Only the weight is read; see the class comment for why the other six are not.
 */
const RECORD_LEN = 20;
const POSITION_OFFSET = 1;
const TIMESTAMP_OFFSET = 2;
const WEIGHT_OFFSET = 6;
const WEIGHT_DIV = 10;

/** An empty slot reads back as all zeros; slot 0 uses 0xFFFFFFFF instead. */
const TIMESTAMP_UNSET = 0xffffffff;

/** True for a measurement record as opposed to a command echo. */
function isRecord(data: Buffer): boolean {
  return data.length === RECORD_LEN && data[0] < RECORD_SLOTS;
}

/** `08 <slot + 1>`: the next slot's count, or nothing once the last is walked. */
function statusOfNextSlot(slot: number): number[] | null {
  return slot + 1 < RECORD_SLOTS ? [CMD_STATUS, slot + 1] : null;
}

/** `01 <unix seconds u32 LE>`: set the scale's clock to the host's time. */
function setClockCommand(): number[] {
  const now = Math.floor(Date.now() / 1000);
  return [CMD_SET_CLOCK, now & 0xff, (now >>> 8) & 0xff, (now >>> 16) & 0xff, (now >>> 24) & 0xff];
}

/**
 * Adapter for Salter Bluetooth body-analyser scales (SALTER-SA00656-BK and the
 * SA00432 firmware family it reports in its Device Information Service; the
 * vendor string is "Healthcare ELectronic", a Nordic nRF5x design).
 *
 * This scale never speaks first. It answers a GATT connection, advertises three
 * notify characteristics, then sends nothing at all — through a weigh-in,
 * through a two-minute wait, through anything — until the client writes to FFC1.
 * It also puts no weight in its advertisement. Neither passive broadcast parsing
 * nor waiting for a stream works here; the only way to read it is to ask:
 *
 *   -> 0b 00        <- 0b 00                  keepalive
 *   -> 02           <- 02 <clock u32 LE>      the scale's own clock
 *   -> 08 00        <- 08 00 00               slot 0 count: empty, skip it
 *   -> 08 01        <- 08 01 02               slot 1 count: two records queued
 *   -> 09 01 01     <- 01 01 <ts> <record>    its newest position, count - 1
 *   -> 09 01 00     <- 01 00 <ts> <record>    then its oldest, position 0
 *   -> 08 02        <- 08 02 01               slot 2 count: one record, so
 *   -> 09 02 00     <- 02 00 <ts> <record>    one fetch, its only position
 *
 * IT ALSO STORES NOTHING UNTIL ITS CLOCK IS SET, which is why the one write this
 * adapter makes that CHANGES anything on the device is `01 <unix u32 LE>`, and
 * only when it finds the clock unset. Everything else it sends is a read.
 * Changing the batteries restarts that clock at zero, and in that state the unit
 * commits no measurements whatsoever: fourteen slot sweeps either side of a real
 * 88.5 kg weigh-in came back empty, every `08 <i>` counter reading 0, on a scale
 * that was otherwise answering every command. Writing the clock fixed it
 * outright, the next weigh-in committing immediately and reading back at age
 * zero with its composition intact. Without that write the adapter reads empty
 * slots forever on healthy hardware, which is indistinguishable from a scale
 * that is not talking at all, and a battery change is enough to cause it.
 *
 * A clock that is already set is LEFT ALONE; see {@link MIN_PLAUSIBLE_CLOCK_SEC}.
 * The vendor app writes local time into that UTC field and the scale drifts
 * about 24 s an hour, so its clock disagrees with the host by an hour or more,
 * and re-syncing would move the time base its own history is dated against.
 * Nothing here needs the two clocks to agree: every record is judged against the
 * scale's own clock, which cancels both the offset and the drift. QN (`0x20`)
 * and MGB both re-sync on every session; this one is deliberately narrower.
 *
 * MEASUREMENTS ARE STORED, AND WHICH SLOT HOLDS WHAT IS NOT PREDICTABLE. The
 * scale keeps every weigh-in; `08 <i>` counts how many a slot holds, and each
 * slot is a queue addressed by position: `09 <i> <n>` returns the record at
 * position n. A vendor-app trace read a slot holding two weigh-ins, and the
 * records' own timestamps settle which end is which: `09 01 00` returned 88.6 kg
 * stamped 1787692247 and `09 01 01` returned 89.2 kg stamped 1787692809, so
 * position 0 is the OLDER record, by 562 s, and count - 1 the newest. Reads are
 * non-destructive and nothing is ever cleared, so a slot's queue only grows
 * until the vendor app drains it.
 *
 * THE WALK FETCHES BOTH ENDS OF A BACKLOGGED SLOT. Reading only `09 <i> 00`, as
 * this adapter once did, is what hid a fresh weigh-in behind an old one: on a
 * live run against a backlogged slot, position 0 handed back the same 90.0 kg
 * record on every sweep, 168 070 s behind the scale's own clock, the age gate
 * rejected it each time, and nothing was published after the user had just
 * stepped off. Reading only `09 <i> <count-1>` would fix that on this unit, but
 * it rests on the ordering above holding on every firmware, and if a unit
 * queues the other way round the failure is the same one, silent. So a slot
 * with a count above one is asked for its newest position and then position 0,
 * and the newest-timestamp-wins comparison that already runs across slots picks
 * between them: whichever end the fresh weigh-in sits at, it is read. That
 * costs one extra round trip only on a backlogged slot. Newest is fetched
 * first because the scale can power off mid-sweep (see below), and the record
 * that matters should land before it does. Only the two ends are read: a
 * weigh-in that is neither the newest nor the oldest in its slot is never
 * fetched, which is the store-is-not-history stance below applied to a queue;
 * with a host connected each weigh-in gets its own session, so the case only
 * arises when the host was away for more than one. Checked on the same unit
 * against slots holding up to six records: on every sweep the newest position
 * published at 0 s of age while position 0 was rejected as stale.
 *
 * The store is not treated as history to be replayed. The older entries are past
 * readings already dealt with, some of them months old, and reporting them would
 * overwrite today's numbers with last month's. Records arrive in index order,
 * which is not chronological, so newest-wins is also what stops the reading that
 * resolves the session being whichever index happened to be read first.
 *
 * NEWEST IN THE STORE IS NOT THE SAME AS TAKEN JUST NOW, and on this hardware
 * the gap can be large. Position 0 of slot 1 held the OLDEST un-collected record
 * rather than the newest: a weigh-in taken with nothing connected pushed `08 01`
 * from 4 to 8 while `09 01 00` kept returning a record 334 seconds old, and one
 * session exported a record stamped 6720 seconds before the scale's own clock.
 * That is the failure {@link MAX_RECORD_AGE_SEC} exists to stop, and it is why
 * the age gate is not belt-and-braces here but load-bearing.
 *
 * NOTHING IS EVER CLEARED. The protocol has a clear (`0a <slot> <n>`, answered
 * `0a <slot> 00`) and the vendor app uses it, reading every position of a slot
 * and then clearing each, but this adapter does not, and that is deliberate.
 * The app's own history is whatever it drains, so a clear from here would also
 * erase weigh-ins the app has not yet seen. An earlier version fired the clear
 * on a timer without reading first; because the clear consumes an entry whether
 * or not anything read it, it destroyed unread weigh-ins off a real user's
 * scale. A later run of twenty clears against a counter of twenty, with one real
 * record present, left the store inconsistent for hours: the counter kept
 * climbing while records stopped being retrievable, until a battery pull reset
 * it.
 *
 * The cost of not clearing is that the store is never drained, so a backlog
 * persists until the vendor app collects it. The walk reads past a backlog by
 * fetching both ends of the slot, and the age gate keeps the old end from being
 * reported, so what a backlog costs is one extra round trip rather than a
 * reading. Whether one clear per connection, issued only after its record has
 * been decoded, would drain safely is untested on a healthy scale: the
 * observations above were made either side of a store this adapter's own
 * probing had corrupted, so they justify caution rather than a design.
 *
 * THE SCALE IS OFF MOST OF THE TIME. It powers up when someone stands on it and
 * powers down after the reading and a short standby, taking its radio with it. A
 * session open when it switches off gets no clean disconnect: the link dies
 * silently and writes stop completing, and on a transport that does not surface
 * the drop (macOS/noble was seen doing this) the session then only ends on the
 * idle timeout. Continuous mode with a short cooldown is the configuration that
 * suits it, and a short `ble.session_timeout_sec` (30 s or so) recovers from a
 * dead link quickly without cutting a live weigh-in short: the sweep answers
 * every few seconds, so a longer silence already means the scale has gone.
 *
 * BODY COMPOSITION IS DELIBERATELY NOT TAKEN FROM THE SCALE. The record carries
 * six derived values and they decode perfectly, but the scale computes them from
 * a user profile stored on the device, and that profile is whatever the vendor
 * app last wrote. On the unit this was decoded against the app had provisioned a
 * height of 100 cm, which the scale's own BMI field confirmed by reporting 85.7
 * for an 85.7 kg person — weight ÷ 1.00 m². Every derived value on that reading
 * inherited the error: 45 % body fat, 36.2 % water, 1078 kcal BMR, all displayed
 * by the app without question.
 *
 * Even provisioned correctly those values would describe whoever the scale was
 * last told about, not the user this reading is being matched to. So the adapter
 * reports weight only (`impedance: 0`) and body composition comes from the shared
 * estimator using the height, age and gender in the user's own config. That
 * follows the Hutbit adapter's precedent, where the vendor's derived body fat was
 * similarly unusable.
 *
 * The scale does measure bioimpedance — the display runs an electrode animation
 * with bare feet, and all six derived fields drop to zero in a socks-on reading
 * while the weight stays identical — but it exposes only the computed results,
 * never the raw ohms. There is nothing to feed the BIA estimator.
 */
export class SalterAdapter
  implements ScaleAdapterCore, GattWiring, Unlockable, AckProtocol, HoldForComposition
{
  readonly name = 'Salter';
  readonly match: MatchDescriptor = {
    priority: 125,
    names: { startsWith: ['salter-'] },
    // The GATT service is 0xFFCC, but the advertisement carries it byte-swapped
    // as 0xCCFF (observed on CoreBluetooth, which reports the advertised UUID
    // verbatim). Both are claimed so the adapter matches pre-connect on the
    // advertised form and post-connect on the discovered one, and so a unit
    // whose local name is missing — as happens over the ESPHome proxy, where the
    // name lives in the scan response — is still recognised.
    //
    // FFC1 is deliberately NOT claimed as a `charUuids` match. A characteristic
    // claim hits on its own, with no service or name qualifier, and at priority
    // 125 that outranks every adapter from Hoffen (20) up to Exingtech Y1 (120):
    // a device one of those matched pre-connect would be re-resolved to Salter
    // by the post-discovery pass and then fail the whole read, because it does
    // not speak the 0xFFCC protocol. The claim could not pay off anyway: a unit
    // advertising neither the name nor 0xFFCC/0xCCFF never reaches discovery as
    // a Salter, and one that does already matches on the service above.
    serviceUuids: ['ffcc', 'ccff'],
  };

  readonly charNotifyUuid = CHR_FFC1;
  readonly charWriteUuid = CHR_FFC1;

  /**
   * The record's weight is treated as canonical kg, so the handler must not run
   * it through the lbs conversion on top.
   *
   * INFERRED, NOT DIRECTLY VERIFIED. Every capture so far was taken with the
   * scale displaying kg, so a record from a scale set to lb has never been seen.
   * The inference rests on the record's companion fields, which are unambiguously
   * metric whatever the display is doing: bone mass arrives in kilograms and BMR
   * in kilocalories. A record that switched its weight field to pounds while
   * leaving bone mass in kilograms would be a very strange protocol, and the
   * vendor app converts for display anyway.
   *
   * If a unit with a lb display ever reports weights wrong by a factor of 2.2,
   * this flag is the first thing to check.
   */
  readonly normalizesWeight = true;

  /**
   * What each tick kicks off: a keepalive, then the clock read whose reply starts
   * the slot walk (see {@link buildAck}). The slots themselves are NOT listed
   * here — writing them as one burst is what this firmware drops.
   *
   * `unlockCommand` is the interface's required single-command member;
   * `unlockCommands` is what actually runs.
   */
  readonly unlockCommand = [CMD_CLOCK];
  readonly unlockCommands = [[CMD_PING, 0x00], [CMD_CLOCK]];
  readonly unlockIntervalMs = SWEEP_INTERVAL_MS;

  /** FFC1 is write-without-response only; a with-response write is rejected. */
  readonly ackWithResponse = false;

  /**
   * Walk the record slots, one reply at a time.
   *
   * The slots CANNOT be read as a burst. This firmware has a single command
   * buffer, so writes fired back-to-back overwrite one another: sending the
   * ping, the clock read and eight fetches together got three answers out of
   * ten, and the only fetch that survived was the last one written. Chaining
   * each fetch off the previous reply paces the sweep at the device's own
   * round-trip instead, which is what the vendor app effectively does.
   *
   * The periodic clock read is what restarts the walk, so a dropped reply costs
   * one cycle rather than stalling the session.
   *
   * The clock reply is also where an unset clock is caught and set, because a
   * scale in that state has nothing in its slots to walk. The write is answered
   * with `01 00`, which is chained straight back into another clock read so the
   * walk still starts inside the same cycle.
   *
   * A slot's count decides how many fetches it gets: none when it is empty, one
   * for a single record, and two for a backlog, its newest position and then
   * position 0 (see the class comment). The second fetch is owed across one
   * reply, and that is the only state the walk keeps. Every fetch follows the
   * count reply that decides whether one is owed, and a walk restart drops the
   * flag as well, so a reply turning up late from an abandoned walk cannot
   * claim a fetch it was never owed.
   */
  buildAck(data: Buffer): number[] | null {
    if (data.length === CLOCK_REPLY_LEN && data[0] === CMD_CLOCK) {
      if (data.readUInt32LE(1) < MIN_PLAUSIBLE_CLOCK_SEC && !this.clockSyncSent) {
        // Once per session. A write that does not take leaves the slots empty
        // and the session yields nothing, which the next connection retries;
        // retrying inside this one would only spin.
        this.clockSyncSent = true;
        bleLog.info(
          "Salter: the scale's clock is unset (new batteries?); setting it, " +
            'or it will not store the weigh-in',
        );
        return setClockCommand();
      }
      this.oldestOwed = false; // a fresh walk owes nothing from the last one
      return [CMD_STATUS, 0]; // start the walk by asking slot 0 how many records it holds
    }
    if (data.length === SET_CLOCK_ACK_LEN && data[0] === CMD_SET_CLOCK) {
      return [CMD_CLOCK]; // re-read it, and pick the walk up from there
    }
    if (data.length === STATUS_REPLY_LEN && data[0] === CMD_STATUS) {
      const slot = data[1];
      const count = data[2];
      if (count === 0) return statusOfNextSlot(slot); // empty: straight on
      // Newest position first, so the reading that matters lands before the
      // scale can power off. A backlogged slot then owes a fetch of position 0
      // as well; parseNotification keeps the newer of the two.
      this.oldestOwed = count > 1;
      return [CMD_FETCH, slot, count - 1];
    }
    if (isRecord(data)) {
      if (this.oldestOwed) {
        this.oldestOwed = false;
        return [CMD_FETCH, data[0], 0];
      }
      return statusOfNextSlot(data[0]);
    }
    return null;
  }

  /** Keep the link open for a whole sweep; see {@link COMPLETION_HOLD_MS}. */
  readonly completionHoldMs = COMPLETION_HOLD_MS;

  /**
   * Timestamp of the newest record ever reported, kept ACROSS sessions.
   *
   * The scale is a sender of one current reading, not an archive: it wakes
   * because someone stood on it, so the newest record in the buffer is that
   * weigh-in. Anything older is a past reading that has already been dealt with,
   * and re-reporting it would overwrite today's numbers with last month's.
   *
   * Records arrive in slot order, which is not chronological, so this is also
   * what makes the NEWEST record the one that resolves the session: only a
   * record newer than everything before it is emitted, and the handler keeps the
   * last reading it was given.
   *
   * Deliberately NOT reset by {@link onSessionEnd} — it is de-duplication state,
   * not session state. It is cleared only when the scale's clock goes backwards;
   * see {@link noteClock}.
   */
  private lastReportedTs = 0;

  /** Scale clock from the last `02` reply, and the local time it arrived. */
  private clockSec = 0;
  private clockAt = 0;

  /** Whether this session has already written the clock; see {@link buildAck}. */
  private clockSyncSent = false;

  /**
   * Whether the slot being walked still owes a fetch of position 0. Set when a
   * count above one comes back, consumed by the record reply that follows, and
   * dropped whenever a walk restarts; see {@link buildAck}.
   */
  private oldestOwed = false;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    // Log every frame before the shape gate, so "frames arrive but are rejected"
    // stays distinguishable from "frames never arrive" — the question every
    // stalled-scale report ends up asking.
    bleLog.debug(`Salter RAW (${data.length}B): ${data.toString('hex')}`);

    // The clock reply arrives on the same characteristic; capture it, then stop.
    if (data.length === CLOCK_REPLY_LEN && data[0] === CMD_CLOCK) {
      this.noteClock(data.readUInt32LE(1));
      return null;
    }

    if (!isRecord(data)) return null;
    const where = `slot ${data[0]} position ${data[POSITION_OFFSET]}`;

    const timestamp = data.readUInt32LE(TIMESTAMP_OFFSET);
    if (timestamp === 0 || timestamp === TIMESTAMP_UNSET) return null; // empty slot

    const weight = data.readUInt16LE(WEIGHT_OFFSET) / WEIGHT_DIV;
    if (!(weight > 0) || !Number.isFinite(weight) || weight > MAX_WEIGHT_KG) return null;

    if (this.isFromAnotherEpoch(timestamp)) return null;

    // Every record this scale returns is a stored one, so age is the only thing
    // separating the weigh-in that just happened from the buffer behind it.
    // Without a clock there is nothing to measure age against, and a record of
    // unknown age must not be published as today's weight. The sweep always
    // reads the clock before any record, so this is defensive rather than a
    // state the protocol produces.
    if (!this.clockSec) {
      bleLog.debug(`Salter: record from ${where} ignored, no clock read yet`);
      return null;
    }
    const ageSec = this.scaleNow() - timestamp;
    if (ageSec > MAX_RECORD_AGE_SEC) {
      bleLog.debug(
        `Salter: ignoring stored record from ${where}, ` +
          `${Math.round(ageSec)}s old (limit ${MAX_RECORD_AGE_SEC}s)`,
      );
      return null;
    }

    // Newest wins. Older records are past weigh-ins the scale simply never
    // forgets; only a record newer than anything reported before is a new
    // measurement, and emitting them in ascending order leaves the newest as the
    // reading the handler resolves with.
    if (timestamp <= this.lastReportedTs) return null;
    this.lastReportedTs = timestamp;

    bleLog.debug(
      `Salter: ${weight.toFixed(1)} kg from ${where} ` +
        `(stamp ${timestamp}, ${Math.round(ageSec)}s old)`,
    );
    // Deliberately UNDATED, even though every record here is a stored one.
    // Setting `ScaleReading.timestamp` routes a reading into the cache-replay
    // buffer in `waitForRawReading`, which returns early and only drains on
    // disconnect. This adapter holds the link open and polls until the session
    // times out, and a timeout rejects, so a dated reading would be buffered and
    // never delivered. The age bound above is what replaces the platform's own
    // replay protections, which undated readings do not get.
    return { weight, impedance: 0 };
  }

  /** The scale's clock, advanced by the time since it was read. */
  private scaleNow(): number {
    return this.clockSec + (Date.now() - this.clockAt) / 1000;
  }

  /**
   * Record the scale's clock, and notice when it has gone backwards.
   *
   * New batteries restart the clock near zero. Every subsequent weigh-in is then
   * stamped with a small number, far below the newest timestamp already reported
   * — so a plain high-water mark would suppress every future reading, forever
   * and silently. A clock behind the mark means the epoch changed, and the mark
   * belongs to a numbering that no longer exists.
   */
  private noteClock(seconds: number): void {
    this.clockSec = seconds;
    this.clockAt = Date.now();
    if (this.lastReportedTs && seconds + FUTURE_TOLERANCE_SEC < this.lastReportedTs) {
      bleLog.info(
        "Salter: the scale's clock went backwards (new batteries?); resetting de-duplication",
      );
      this.lastReportedTs = 0;
    }
  }

  /**
   * True for a record whose timestamp sits ahead of the scale's own clock.
   *
   * Changing the batteries restarts the clock near zero while the stored records
   * keep the timestamps of the old epoch, so everything weighed before the change
   * suddenly reads as far in the future. Those records are stale by definition
   * and there is no way to date them — the clock that produced them is gone — so
   * they are dropped rather than reported as though they were taken today.
   *
   * The tolerance covers the ordinary case of someone stepping on the scale
   * mid-session, after this session's clock was read.
   */
  private isFromAnotherEpoch(timestamp: number): boolean {
    if (!this.clockSec) return false; // no clock yet: nothing to compare against
    return timestamp > this.scaleNow() + FUTURE_TOLERANCE_SEC;
  }

  /**
   * Forget this session's clock reading, and re-arm the clock write. Adapters are
   * shared singletons, so a stale clock would otherwise be used to judge the next
   * session's records — including the backwards-clock check, which must see a
   * fresh value — and a clock write that failed would never be retried.
   */
  onSessionEnd(): void {
    this.clockSec = 0;
    this.clockAt = 0;
    this.clockSyncSent = false;
    this.oldestOwed = false;
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  /**
   * Never resolve on a record, always wait out the hold window.
   *
   * There is no richer frame to wait for; the hold exists so a full sweep lands
   * before the newest record is chosen. Returning true would resolve on whichever
   * slot happened to be read first.
   */
  isFinal(): boolean {
    return false;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // No raw impedance exists in this protocol, so this is the BMI-based estimate
    // path for every reading. See the class comment for why the scale's own
    // derived values are not used instead.
    return buildPayload(reading.weight, reading.impedance, {}, profile);
  }
}
