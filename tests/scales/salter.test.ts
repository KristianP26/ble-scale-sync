import { describe, it, expect } from 'vitest';
import { SalterAdapter } from '../../src/scales/salter.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  expectMatches,
  parseOk,
  expectValidMetrics,
} from '../helpers/scale-test-utils.js';

/**
 * Every buffer below is a verbatim capture from a SALTER-SA00656-BK, taken with
 * a scratchpad client speaking the protocol or from an iOS PacketLogger trace of
 * the Salter Health app. Each weight was called out from the scale's display as
 * the reading was taken.
 *
 * Named by the slot they were found in; their timestamps are real and ascend in
 * the order listed, which the de-duplication tests rely on.
 */
const REC_857_APP = Buffer.from('0100ea048a6a5903c2016a01e200280036045903', 'hex'); // ts 6a8a04ea
const REC_876_BIA = Buffer.from('010016078a6a6c03c2016901e30028004c046c03', 'hex'); // ts 6a8a0716
const REC_876_SOCKS = Buffer.from('01007e078a6a6c03000000000000000000000000', 'hex'); // ts 6a8a077e
const REC_880_SLOT1 = Buffer.from('010083108a6a7003000000000000000000000000', 'hex'); // ts 6a8a1083
const REC_74_SLOT6 = Buffer.from('06004c148a6a4a00000000000000000000000000', 'hex'); // ts 6a8a144c
const REC_888_SLOT7 = Buffer.from('070067148a6a78033501e50164012000ea063301', 'hex'); // ts 6a8a1467
const REC_897_SLOT2 = Buffer.from('0200fa148a6a81033801e40162012100f4063601', 'hex'); // ts 6a8a14fa

/**
 * One slot holding two weigh-ins, from a vendor-app trace that read both ends
 * of its queue: `09 01 00` was answered with the first, `09 01 01` with the
 * second, and byte 1 of each echoes the position asked for. Their stamps are
 * 562 s apart, which is what pins position 0 as the OLDER end.
 */
const REC_886_POS0 = Buffer.from('0100d7048e6a76030401fe018c01220032070601', 'hex'); // ts 6a8e04d7
const REC_892_POS1 = Buffer.from('010109078e6a7c030601fd018a01220039070801', 'hex'); // ts 6a8e0709

/** Slots that hold nothing: all zeros, except slot 0 which uses 0xFFFFFFFF. */
const SLOT_EMPTY = Buffer.from('0100000000000000000000000000000000000000', 'hex');
const SLOT0_UNSET = Buffer.from('0000ffffffffffff000000000000000000000000', 'hex');

const PING_ECHO = Buffer.from('0b00', 'hex');
const STATUS_ECHO = Buffer.from('080101', 'hex');

/** `08 <slot> <count>`: the scale's answer to a record-count probe. */
function statusReply(slot: number, count: number): Buffer {
  return Buffer.from([0x08, slot, count]);
}

/** A record reply attributed to `slot`, for driving the walk. */
function recordFrom(slot: number): Buffer {
  const rec = Buffer.from(REC_888_SLOT7);
  rec[0] = slot;
  return rec;
}

function makeAdapter(): SalterAdapter {
  return new SalterAdapter();
}

/** A `02 <u32 LE>` clock reply placing `record` exactly `ageSec` in the past. */
function clockReply(recordTs: number, ageSec: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = 0x02;
  b.writeUInt32LE(recordTs + ageSec, 1);
  return b;
}

/** The timestamp embedded in a record buffer. */
function tsOf(record: Buffer): number {
  return record.readUInt32LE(2);
}

/** A copy of `record` restamped `secondsAgo` before `nowTs`. */
function aged(record: Buffer, nowTs: number, secondsAgo: number): Buffer {
  const b = Buffer.from(record);
  b.writeUInt32LE(nowTs - secondsAgo, 2);
  return b;
}

/**
 * Feed the clock reply that every real sweep sends before any record, placing
 * the scale's clock `ageSec` after `record`'s stamp.
 *
 * Records are judged for age against this clock, so a test that parses a record
 * without one is testing a state the protocol never produces.
 */
function primed(adapter: SalterAdapter, record: Buffer, ageSec = 10): SalterAdapter {
  adapter.parseNotification(clockReply(tsOf(record), ageSec));
  return adapter;
}

/** A `02 <u32 LE>` clock reply carrying `seconds` verbatim. */
function clockOf(seconds: number): Buffer {
  const b = Buffer.alloc(5);
  b[0] = 0x02;
  b.writeUInt32LE(seconds, 1);
  return b;
}

/**
 * A clock the scale could only be holding if it had been set: the timestamp on
 * the newest fixture. Anything below 2020 means new batteries, and the adapter
 * writes the clock instead of walking slots that a scale in that state has not
 * filled.
 */
const CLOCK_SET = clockOf(tsOf(REC_897_SLOT2));

/** A clock counting up from a battery change rather than from the epoch. */
const CLOCK_UNSET = clockOf(28);

/** The `01 00` the scale answers a clock write with. */
const SET_CLOCK_ACK = Buffer.from('0100', 'hex');

/** Render a command byte array as hex, for the "no destructive write" check. */
function a2h(bytes: number[]): string {
  return Buffer.from(bytes).toString('hex');
}

describe('SalterAdapter', () => {
  describe('matches() and registry resolution', () => {
    it('matches the advertised SALTER- name prefix, case-insensitively', () => {
      expectMatches(makeAdapter(), {
        yes: ['SALTER-SA00656-BK', 'salter-sa00656-bk', 'SALTER-SA00432-BK'],
        no: ['QN-Scale', 'Hutbit Scale', 'Renpho Body Scale', ''],
      });
    });

    it('claims both the advertised 0xCCFF and the discovered 0xFFCC service', () => {
      // The advertisement carries the service UUID byte-swapped relative to the
      // one exposed over GATT, and a name is not always present (the ESPHome
      // proxy leaves it empty), so both forms must resolve.
      expectMatches(makeAdapter(), {
        yes: [
          mockPeripheral('', ['ccff']),
          mockPeripheral('', ['ffcc']),
          mockPeripheral('', [uuid16(0xffcc)]),
        ],
      });
    });

    it('does NOT claim a device on the bare FFC1 characteristic alone', () => {
      // A `charUuids` claim hits with no service or name qualifier, and at
      // priority 125 it would outrank every adapter from Hoffen (20) to
      // Exingtech Y1 (120). A device one of those matched pre-connect would be
      // re-resolved here after discovery and then fail the whole read.
      const info: BleDeviceInfo = mockPeripheral('', [], undefined, [uuid16(0xffc1)]);
      expect(makeAdapter().matches(info)).toBe(false);
    });

    it('still re-resolves post-discovery on the service, name absent', () => {
      // Dropping the characteristic claim must not cost the post-discovery
      // path: a unit that reaches GATT as a Salter got there on the service.
      const info: BleDeviceInfo = mockPeripheral('', ['ffcc'], undefined, [uuid16(0xffc1)]);
      expect(makeAdapter().matches(info)).toBe(true);
    });

    it('resolves a real Salter advertisement to this adapter, not the generic one', () => {
      const info = mockPeripheral('SALTER-SA00656-BK', ['ccff']);
      expect(adapters.find((a) => a.matches(info))?.name).toBe('Salter');
      expect(resolveAdapter(info, adapters)?.name).toBe('Salter');
    });
  });

  describe('parseNotification() — measurement records', () => {
    it('decodes the weight from a bare-foot record (87.6 kg)', () => {
      parseOk(primed(makeAdapter(), REC_876_BIA), REC_876_BIA, { weight: 87.6, impedance: 0 });
    });

    it('decodes the same weight from a socks-on record with no composition', () => {
      // Same person, 104 s apart, no electrode contact: the six derived fields
      // are all zero while the weight is byte-identical. Weight must not depend
      // on whether the scale managed a bioimpedance sweep.
      parseOk(primed(makeAdapter(), REC_876_SOCKS), REC_876_SOCKS, { weight: 87.6, impedance: 0 });
      expect(REC_876_SOCKS.subarray(8).every((b) => b === 0)).toBe(true);
    });

    it('decodes records from every slot, not just one fixed index', () => {
      // Real sweep of a live unit: measurements sat in slots 2, 6 and 7 with the
      // rest empty. An adapter that reads one hardcoded slot sees none of these.
      for (const [rec, kg] of [
        [REC_897_SLOT2, 89.7],
        [REC_74_SLOT6, 7.4],
        [REC_888_SLOT7, 88.8],
      ] as const) {
        expect(primed(makeAdapter(), rec).parseNotification(rec)?.weight).toBeCloseTo(kg, 4);
      }
    });

    it('decodes a record captured from the vendor app (85.7 kg)', () => {
      parseOk(primed(makeAdapter(), REC_857_APP), REC_857_APP, { weight: 85.7, impedance: 0 });
    });

    it('reports no impedance — the protocol carries none', () => {
      // The scale measures bioimpedance but exposes only values it derived from
      // it, never the raw ohms.
      expect(primed(makeAdapter(), REC_876_BIA).parseNotification(REC_876_BIA)!.impedance).toBe(0);
    });

    it('rejects empty slots and the unset slot 0', () => {
      const a = makeAdapter();
      expect(a.parseNotification(SLOT_EMPTY)).toBeNull();
      expect(a.parseNotification(SLOT0_UNSET)).toBeNull();
    });

    it('rejects every command echo on the shared FFC1 channel', () => {
      const a = makeAdapter();
      for (const frame of [PING_ECHO, STATUS_ECHO, Buffer.from('0a0100', 'hex')]) {
        expect(a.parseNotification(frame), frame.toString('hex')).toBeNull();
      }
      expect(a.parseNotification(Buffer.alloc(0))).toBeNull();
    });

    it('rejects a record whose weight field is zero', () => {
      const zeroWeight = Buffer.from(REC_876_BIA);
      zeroWeight.writeUInt16LE(0, 6);
      expect(makeAdapter().parseNotification(zeroWeight)).toBeNull();
    });

    it('rejects an implausible weight rather than exporting it', () => {
      // The field is a bare u16, so unbounded it accepts 6553.5 kg. Any 20-byte
      // frame whose first byte is under 8 is treated as a record, so a garbled
      // frame or an unknown firmware reply must not decode to an absurd weight.
      // Both adapters are primed with a clock, or the no-clock gate rejects the
      // record before MAX_WEIGHT_KG is ever consulted and the ceiling goes
      // untested: raising it to 100000 leaves an unprimed version of this green.
      const absurd = Buffer.from(REC_876_BIA);
      absurd.writeUInt16LE(0xffff, 6); // 6553.5 kg
      expect(primed(makeAdapter(), absurd).parseNotification(absurd)).toBeNull();

      const overCeiling = Buffer.from(REC_876_BIA);
      overCeiling.writeUInt16LE(3001, 6); // 300.1 kg
      expect(primed(makeAdapter(), overCeiling).parseNotification(overCeiling)).toBeNull();
    });

    it('still accepts a legitimately light load', () => {
      // No floor to match the ceiling: the 7.4 kg fixture is a real capture.
      expect(parseOk(primed(makeAdapter(), REC_74_SLOT6), REC_74_SLOT6).weight).toBeCloseTo(7.4, 4);
    });
  });

  describe('newest-wins de-duplication', () => {
    it('reports a given stored measurement only once', () => {
      // Nothing is ever cleared, so the same record is re-read on every sweep
      // for as long as it sits in the buffer.
      const a = primed(makeAdapter(), REC_876_BIA);
      expect(a.parseNotification(REC_876_BIA)).not.toBeNull();
      a.onSessionEnd();
      a.parseNotification(clockReply(tsOf(REC_876_BIA), 20));
      expect(a.parseNotification(REC_876_BIA)).toBeNull();
      a.onSessionEnd();
      a.parseNotification(clockReply(tsOf(REC_876_BIA), 30));
      expect(a.parseNotification(REC_876_BIA)).toBeNull();
    });

    it('leaves the NEWEST record standing across a sweep', () => {
      // Slots are read in index order, which is not chronological: here the
      // newest (slot 2) is read first and the older ones must not displace it.
      // The handler resolves with the last reading it was given.
      const a = primed(makeAdapter(), REC_897_SLOT2);
      const emitted = [REC_897_SLOT2, REC_74_SLOT6, REC_888_SLOT7]
        .map((r) => a.parseNotification(r))
        .filter((r) => r !== null);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.weight).toBeCloseTo(89.7, 4);
    });

    it('emits an ascending sweep in order, ending on the newest', () => {
      // When older slots are read first, each newer record supersedes the last,
      // so the final emission is still the newest.
      // Restamped inside the acceptance window, because the captures span 68
      // minutes and a record that old is history rather than this weigh-in.
      // The ordering behaviour under test is unchanged by the restamping.
      const now = tsOf(REC_897_SLOT2);
      const a = makeAdapter();
      a.parseNotification(clockReply(now, 5));
      const weights = [
        aged(REC_857_APP, now, 40),
        aged(REC_876_BIA, now, 30),
        aged(REC_880_SLOT1, now, 20),
        aged(REC_897_SLOT2, now, 10),
      ]
        .map((r) => a.parseNotification(r))
        .filter((r) => r !== null)
        .map((r) => r!.weight);
      expect(weights).toEqual([85.7, 87.6, 88.0, 89.7]);
    });

    it('reports the fresh end of a backlogged slot whichever end arrives first', () => {
      // The two records one slot held in the vendor-app trace. With the clock
      // 10 s past the newer stamp, the older is 572 s behind it, well outside
      // MAX_RECORD_AGE_SEC. The walk fetches the newest position first and
      // then position 0, but both ends are fetched precisely so the ordering
      // need not be assumed, so the outcome must not depend on it.
      const newestFirst = primed(makeAdapter(), REC_892_POS1);
      expect(newestFirst.parseNotification(REC_892_POS1)?.weight).toBeCloseTo(89.2, 4);
      expect(newestFirst.parseNotification(REC_886_POS0)).toBeNull();

      const oldestFirst = primed(makeAdapter(), REC_892_POS1);
      expect(oldestFirst.parseNotification(REC_886_POS0)).toBeNull();
      expect(oldestFirst.parseNotification(REC_892_POS1)?.weight).toBeCloseTo(89.2, 4);
    });

    it('ignores months-old readings the scale still holds', () => {
      // The scale wakes because someone stood on it, so anything older than what
      // has already been reported is a past weigh-in, not a new measurement.
      const a = primed(makeAdapter(), REC_897_SLOT2);
      expect(a.parseNotification(REC_897_SLOT2)?.weight).toBeCloseTo(89.7, 4);
      a.onSessionEnd();
      a.parseNotification(clockReply(tsOf(REC_897_SLOT2), 20));
      expect(a.parseNotification(REC_857_APP)).toBeNull();
      expect(a.parseNotification(REC_876_BIA)).toBeNull();
    });

    // THE failure this bound exists for. `lastReportedTs` is in-memory and starts
    // at zero, so on the first session after any restart it suppresses nothing,
    // and the newest record the scale still holds would be published as today's
    // weight however old it is. This project shipped exactly that bug once on
    // another protocol family, where a stored record six days old published
    // 67.10 kg for a 75 kg user.
    it('refuses a stale stored record on the first session of a fresh process', () => {
      const a = makeAdapter();
      // Nothing reported yet: the high-water mark is zero and cannot help.
      a.parseNotification(clockReply(tsOf(REC_897_SLOT2), 3 * 24 * 3600));
      expect(a.parseNotification(REC_897_SLOT2)).toBeNull();
    });

    it('accepts a record inside the window and refuses one just outside it', () => {
      const now = tsOf(REC_897_SLOT2);
      const inside = makeAdapter();
      inside.parseNotification(clockReply(now, 0));
      expect(inside.parseNotification(aged(REC_897_SLOT2, now, 299))?.weight).toBeCloseTo(89.7, 4);

      const outside = makeAdapter();
      outside.parseNotification(clockReply(now, 0));
      expect(outside.parseNotification(aged(REC_897_SLOT2, now, 301))).toBeNull();
    });

    it('refuses any record until the clock has been read', () => {
      // Age is the only thing separating this weigh-in from the buffer behind
      // it, and without a clock there is nothing to measure age against. The
      // sweep always reads the clock first, so this state is defensive.
      //
      // The record is stamped at the host's own wall clock on purpose. With no
      // clock reply the adapter's zeroed clock reads as the unix epoch plus the
      // process uptime, so a record stamped anywhere near now looks brand new
      // and sails past the age bound. Only the no-clock gate rejects this one,
      // which is what makes this test pin that gate rather than the bound.
      const nowUnix = Math.floor(Date.now() / 1000);
      const a = makeAdapter();
      expect(a.parseNotification(aged(REC_897_SLOT2, nowUnix, 5))).toBeNull();
    });

    it('never emits a historical reading', () => {
      // A `timestamp` routes a reading into the cache-replay buffer, which only
      // drains on disconnect — and this adapter's poll holds the link open until
      // the session times out, where a timeout rejects instead.
      const a = makeAdapter();
      a.parseNotification(clockReply(tsOf(REC_897_SLOT2), 30));
      expect(a.parseNotification(REC_897_SLOT2)!.timestamp).toBeUndefined();
    });

    it('drops records from before a battery change', () => {
      // New batteries restart the clock near zero while stored records keep the
      // old epoch's timestamps, so they read as far in the future. Reporting one
      // would date a months-old weigh-in as today's.
      const a = makeAdapter();
      a.parseNotification(clockReply(0, 400)); // clock restarted: ~400s uptime
      expect(a.parseNotification(REC_897_SLOT2)).toBeNull(); // ts is a 2026 unix time
      expect(a.parseNotification(REC_888_SLOT7)).toBeNull();
    });

    it('still accepts a weigh-in taken moments after the clock was read', () => {
      // A record stamped slightly ahead of this session's clock read is normal:
      // someone stepped on the scale while the session was open.
      const a = makeAdapter();
      a.parseNotification(clockReply(tsOf(REC_897_SLOT2), -5)); // read 5s earlier
      expect(a.parseNotification(REC_897_SLOT2)?.weight).toBeCloseTo(89.7, 4);
    });

    it('recovers after a battery change instead of going silent forever', () => {
      // THE trap in a high-water mark: a reset clock stamps every future
      // weigh-in below the mark, so without noticing the clock went backwards
      // the adapter would suppress every reading from then on, silently.
      const a = primed(makeAdapter(), REC_897_SLOT2);
      expect(a.parseNotification(REC_897_SLOT2)).not.toBeNull(); // mark: 6a8a14fa
      a.onSessionEnd();

      // New batteries: clock restarts, and a fresh weigh-in is stamped ~500s.
      a.parseNotification(clockReply(0, 500));
      const fresh = Buffer.from(REC_888_SLOT7);
      fresh.writeUInt32LE(495, 2);
      expect(a.parseNotification(fresh)?.weight).toBeCloseTo(88.8, 4);
    });
  });

  describe('sweep wiring', () => {
    it('kicks each cycle with a keepalive and a clock read only', () => {
      // The slot walk is NOT written as a burst; see the chaining test below.
      const a = makeAdapter();
      expect(a.unlockCommands).toEqual([[0x0b, 0x00], [0x02]]);
    });

    it('chains the slot walk one command per reply: count, then fetch', () => {
      // The firmware has a single command buffer: nine writes fired back-to-back
      // produced three answers on hardware, and the only fetch that survived was
      // the last one written. Each reply must trigger the next command instead.
      const a = makeAdapter();
      // The clock reply starts the walk by asking slot 0 for its record count.
      expect(a.buildAck(CLOCK_SET)).toEqual([0x08, 0]);
      // An empty slot advances straight to the next slot's count.
      expect(a.buildAck(statusReply(0, 0))).toEqual([0x08, 1]);
      // A slot with one record fetches it — position 0 is its only position.
      expect(a.buildAck(STATUS_ECHO)).toEqual([0x09, 1, 0]);
      // A record reply advances to the next slot's count.
      expect(a.buildAck(recordFrom(1))).toEqual([0x08, 2]);
      expect(a.buildAck(recordFrom(6))).toEqual([0x08, 7]);
      expect(a.buildAck(recordFrom(7))).toBeNull(); // a record from the last slot ends the walk
      expect(a.buildAck(statusReply(7, 0))).toBeNull(); // an empty last slot also ends it
    });

    it('fetches both ends of a backlogged slot, newest first, then moves on', () => {
      // 09 <slot> <n> is position-indexed, and in the trace position 0 was the
      // older record. The walk does not rely on that: a count above one fetches
      // the last position and then position 0, and only then the next slot's
      // count, so the fresh weigh-in is read whichever end it sits at. Reading
      // position 0 alone is what hid a weigh-in behind a two-day-old record.
      const a = makeAdapter();
      expect(a.buildAck(statusReply(1, 2))).toEqual([0x09, 1, 1]);
      expect(a.buildAck(REC_892_POS1)).toEqual([0x09, 1, 0]);
      expect(a.buildAck(REC_886_POS0)).toEqual([0x08, 2]);
      // A deeper backlog still costs exactly two fetches: the last position and 0.
      expect(a.buildAck(statusReply(3, 5))).toEqual([0x09, 3, 4]);
      expect(a.buildAck(recordFrom(3))).toEqual([0x09, 3, 0]);
      expect(a.buildAck(recordFrom(3))).toEqual([0x08, 4]);
    });

    it('does not spend a second fetch on a slot with one record', () => {
      // With a count of one, position 0 is both ends of the queue.
      const a = makeAdapter();
      expect(a.buildAck(statusReply(2, 1))).toEqual([0x09, 2, 0]);
      expect(a.buildAck(recordFrom(2))).toEqual([0x08, 3]);
    });

    it('drops an owed fetch when the walk restarts', () => {
      // A fetch whose reply is lost is abandoned when the next tick's clock read
      // restarts the walk. If that reply then turns up late, the clean walk must
      // move on from it, not spend the fetch the old walk was owed. The same
      // goes for a record that lands after a session has ended.
      const a = makeAdapter();
      expect(a.buildAck(statusReply(1, 3))).toEqual([0x09, 1, 2]);
      expect(a.buildAck(CLOCK_SET)).toEqual([0x08, 0]);
      expect(a.buildAck(recordFrom(1))).toEqual([0x08, 2]); // late reply, not [0x09, 1, 0]

      expect(a.buildAck(statusReply(1, 3))).toEqual([0x09, 1, 2]);
      a.onSessionEnd();
      expect(a.buildAck(recordFrom(1))).toEqual([0x08, 2]);
    });

    it('ignores frames that drive neither the clock nor the slot walk', () => {
      const a = makeAdapter();
      expect(a.buildAck(PING_ECHO)).toBeNull();
      expect(a.buildAck(Buffer.from('dead', 'hex'))).toBeNull();
    });

    it('sets the clock when the scale has none, because it then stores nothing', () => {
      // Measured on hardware: with the clock counting up from a battery change,
      // fourteen sweeps either side of a real weigh-in found every slot empty
      // and every `08 <i>` counter at zero. Setting the clock fixed it, the next
      // weigh-in reading back at age zero.
      const a = makeAdapter();
      const before = Math.floor(Date.now() / 1000);
      const ack = a.buildAck(CLOCK_UNSET);

      expect(ack).not.toBeNull();
      expect(ack![0]).toBe(0x01);
      expect(ack).toHaveLength(5);
      const written = Buffer.from(ack!).readUInt32LE(1);
      expect(written).toBeGreaterThanOrEqual(before);
      expect(written).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
    });

    it('leaves a clock that is already set alone', () => {
      // The vendor app writes local time into that UTC field and the scale
      // drifts, so its clock disagrees with the host by an hour or more. Records
      // are judged against the scale's own clock, so that costs nothing, and
      // re-syncing would move the time base the app's history is dated against.
      expect(makeAdapter().buildAck(CLOCK_SET)).toEqual([0x08, 0]);
    });

    it('picks the slot walk back up as soon as the clock write is acked', () => {
      const a = makeAdapter();
      expect(a.buildAck(CLOCK_UNSET)![0]).toBe(0x01);
      expect(a.buildAck(SET_CLOCK_ACK)).toEqual([0x02]);
      expect(a.buildAck(CLOCK_SET)).toEqual([0x08, 0]);
    });

    it('writes the clock once per session, then walks the slots regardless', () => {
      // A write that does not take must not spin: the session simply yields
      // nothing and the next connection tries again.
      const a = makeAdapter();
      expect(a.buildAck(CLOCK_UNSET)![0]).toBe(0x01);
      expect(a.buildAck(CLOCK_UNSET)).toEqual([0x08, 0]);

      a.onSessionEnd();
      expect(a.buildAck(CLOCK_UNSET)![0]).toBe(0x01); // re-armed for the next one
    });

    it('writes acks without a response — FFC1 is write-without-response only', () => {
      expect(makeAdapter().ackWithResponse).toBe(false);
    });

    it('never emits a clear — the protocol has one and it destroys data', () => {
      // `0a <slot> <n>` consumes a record whether or not anything read it. An
      // earlier version paired it with a fixed-slot fetch and discarded three
      // unread weigh-ins off a real scale, and the vendor app's history is
      // whatever it drains itself. Every reply the walk can see is fed here,
      // including the both-ends path a backlog takes.
      const a = makeAdapter();
      const writes = [a2h(a.unlockCommand), ...a.unlockCommands.map(a2h)];
      const push = (ack: number[] | null): void => {
        if (ack) writes.push(a2h(ack));
      };
      push(a.buildAck(CLOCK_SET));
      push(makeAdapter().buildAck(CLOCK_UNSET));
      push(a.buildAck(SET_CLOCK_ACK));
      for (let i = 0; i < 8; i++) {
        for (const count of [0, 1, 2, 9]) {
          push(a.buildAck(statusReply(i, count)));
          push(a.buildAck(recordFrom(i))); // the fetch's reply...
          push(a.buildAck(recordFrom(i))); // ...and the owed one's, on a backlog
        }
      }
      expect(writes.length).toBeGreaterThan(40); // the walk really was driven
      expect(writes.some((w) => w.startsWith('0a'))).toBe(false);
    });

    it('sweeps on an interval that keeps the link alive', () => {
      const a = makeAdapter();
      expect(a.unlockIntervalMs).toBeGreaterThan(0);
      expect(a.unlockIntervalMs).toBeLessThanOrEqual(5000);
    });

    it('holds the link open long enough for a whole sweep', () => {
      const a = makeAdapter();
      expect(a.completionHoldMs).toBeGreaterThan(a.unlockIntervalMs);
      expect(a.isFinal()).toBe(false);
    });

    it('reads and writes on the single FFC1 characteristic', () => {
      const a = makeAdapter();
      expect(a.charNotifyUuid).toBe(uuid16(0xffc1));
      expect(a.charWriteUuid).toBe(uuid16(0xffc1));
    });

    it('declares normalizesWeight — records are canonical kg', () => {
      expect(makeAdapter().normalizesWeight).toBe(true);
    });

    it('has no onConnected hook, so the periodic unlock path stays armed', () => {
      // Declaring onConnected would pre-empt the handler's unlock interval and
      // silently disable the sweep this protocol depends on.
      expect((makeAdapter() as { onConnected?: unknown }).onConnected).toBeUndefined();
    });
  });

  describe('isComplete() and computeMetrics()', () => {
    it('treats any positive weight as a complete reading', () => {
      const a = makeAdapter();
      expect(a.isComplete({ weight: 87.6, impedance: 0 })).toBe(true);
      expect(a.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });

    it('produces a body-composition payload in valid ranges', () => {
      const a = primed(makeAdapter(), REC_876_BIA);
      const reading = parseOk(a, REC_876_BIA);
      const payload = expectValidMetrics(a, reading);
      expect(payload.weight).toBeCloseTo(87.6, 4);
    });

    it('estimates composition from the configured profile, not the scale', () => {
      // The scale's own derived values are computed from whatever profile was
      // last written into the device — on the decoded unit, a 100 cm height.
      const a = primed(makeAdapter(), REC_876_BIA);
      const reading = parseOk(a, REC_876_BIA);
      const short = a.computeMetrics(reading, defaultProfile({ height: 165 }));
      const tall = a.computeMetrics(reading, defaultProfile({ height: 195 }));
      expect(short.bmi).toBeGreaterThan(tall.bmi);
      // The payload rounds BMI to two decimals, so match at that precision.
      expect(short.bmi).toBeCloseTo(87.6 / 1.65 ** 2, 2);
    });
  });
});
