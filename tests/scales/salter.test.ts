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

/** Slots that hold nothing: all zeros, except slot 0 which uses 0xFFFFFFFF. */
const SLOT_EMPTY = Buffer.from('0100000000000000000000000000000000000000', 'hex');
const SLOT0_UNSET = Buffer.from('0000ffffffffffff000000000000000000000000', 'hex');

const PING_ECHO = Buffer.from('0b00', 'hex');
const STATUS_ECHO = Buffer.from('080101', 'hex');

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

    it('claims a device by its FFC1 command characteristic post-discovery', () => {
      const info: BleDeviceInfo = mockPeripheral('', [], undefined, [uuid16(0xffc1)]);
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
      parseOk(makeAdapter(), REC_876_BIA, { weight: 87.6, impedance: 0 });
    });

    it('decodes the same weight from a socks-on record with no composition', () => {
      // Same person, 104 s apart, no electrode contact: the six derived fields
      // are all zero while the weight is byte-identical. Weight must not depend
      // on whether the scale managed a bioimpedance sweep.
      parseOk(makeAdapter(), REC_876_SOCKS, { weight: 87.6, impedance: 0 });
      expect(REC_876_SOCKS.subarray(8).every((b) => b === 0)).toBe(true);
    });

    it('decodes records from every slot, not just one fixed index', () => {
      // Real sweep of a live unit: measurements sat in slots 2, 6 and 7 with the
      // rest empty. An adapter that reads one hardcoded slot sees none of these.
      expect(makeAdapter().parseNotification(REC_897_SLOT2)?.weight).toBeCloseTo(89.7, 4);
      expect(makeAdapter().parseNotification(REC_74_SLOT6)?.weight).toBeCloseTo(7.4, 4);
      expect(makeAdapter().parseNotification(REC_888_SLOT7)?.weight).toBeCloseTo(88.8, 4);
    });

    it('decodes a record captured from the vendor app (85.7 kg)', () => {
      parseOk(makeAdapter(), REC_857_APP, { weight: 85.7, impedance: 0 });
    });

    it('reports no impedance — the protocol carries none', () => {
      // The scale measures bioimpedance but exposes only values it derived from
      // it, never the raw ohms.
      expect(makeAdapter().parseNotification(REC_876_BIA)!.impedance).toBe(0);
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
  });

  describe('newest-wins de-duplication', () => {
    it('reports a given stored measurement only once', () => {
      // Nothing is ever cleared, so the same record is re-read on every sweep
      // for as long as it sits in the buffer.
      const a = makeAdapter();
      expect(a.parseNotification(REC_876_BIA)).not.toBeNull();
      a.onSessionEnd();
      expect(a.parseNotification(REC_876_BIA)).toBeNull();
      a.onSessionEnd();
      expect(a.parseNotification(REC_876_BIA)).toBeNull();
    });

    it('leaves the NEWEST record standing across a sweep', () => {
      // Slots are read in index order, which is not chronological: here the
      // newest (slot 2) is read first and the older ones must not displace it.
      // The handler resolves with the last reading it was given.
      const a = makeAdapter();
      const emitted = [REC_897_SLOT2, REC_74_SLOT6, REC_888_SLOT7]
        .map((r) => a.parseNotification(r))
        .filter((r) => r !== null);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.weight).toBeCloseTo(89.7, 4);
    });

    it('emits an ascending sweep in order, ending on the newest', () => {
      // When older slots are read first, each newer record supersedes the last,
      // so the final emission is still the newest.
      const a = makeAdapter();
      const weights = [REC_857_APP, REC_876_BIA, REC_880_SLOT1, REC_897_SLOT2]
        .map((r) => a.parseNotification(r))
        .filter((r) => r !== null)
        .map((r) => r!.weight);
      expect(weights).toEqual([85.7, 87.6, 88.0, 89.7]);
    });

    it('ignores months-old readings the scale still holds', () => {
      // The scale wakes because someone stood on it, so anything older than what
      // has already been reported is a past weigh-in, not a new measurement.
      const a = makeAdapter();
      expect(a.parseNotification(REC_897_SLOT2)?.weight).toBeCloseTo(89.7, 4);
      a.onSessionEnd();
      expect(a.parseNotification(REC_857_APP)).toBeNull();
      expect(a.parseNotification(REC_876_BIA)).toBeNull();
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
      const a = makeAdapter();
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

    it('chains the slot walk one fetch per reply', () => {
      // The firmware has a single command buffer: nine writes fired back-to-back
      // produced three answers on hardware, and the only fetch that survived was
      // the last one written. Each reply must trigger the next fetch instead.
      const a = makeAdapter();
      expect(a.buildAck(clockReply(0, 0))).toEqual([0x09, 0, 0x00]);

      const fromSlot = (i: number): number[] | null => {
        const rec = Buffer.from(REC_888_SLOT7);
        rec[0] = i;
        return a.buildAck(rec);
      };
      expect(fromSlot(0)).toEqual([0x09, 1, 0x00]);
      expect(fromSlot(5)).toEqual([0x09, 6, 0x00]);
      expect(fromSlot(7)).toBeNull(); // last slot ends the walk
    });

    it('ignores frames that are neither a clock reply nor a record', () => {
      const a = makeAdapter();
      expect(a.buildAck(PING_ECHO)).toBeNull();
      expect(a.buildAck(STATUS_ECHO)).toBeNull();
    });

    it('writes acks without a response — FFC1 is write-without-response only', () => {
      expect(makeAdapter().ackWithResponse).toBe(false);
    });

    it('never emits a clear — the protocol has one and it destroys data', () => {
      // `0a <index> 00` consumes a record regardless of which slot was read. An
      // earlier version paired it with a fixed-slot fetch and discarded three
      // unread weigh-ins off a real scale.
      const a = makeAdapter();
      const writes = [a2h(a.unlockCommand), ...a.unlockCommands.map(a2h)];
      const record = Buffer.from(REC_888_SLOT7);
      for (let i = 0; i < 8; i++) {
        record[0] = i;
        const ack = a.buildAck(record);
        if (ack) writes.push(a2h(ack));
      }
      writes.push(a2h(a.buildAck(clockReply(0, 0)) ?? []));
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
      const a = makeAdapter();
      const reading = parseOk(a, REC_876_BIA);
      const payload = expectValidMetrics(a, reading);
      expect(payload.weight).toBeCloseTo(87.6, 4);
    });

    it('estimates composition from the configured profile, not the scale', () => {
      // The scale's own derived values are computed from whatever profile was
      // last written into the device — on the decoded unit, a 100 cm height.
      const a = makeAdapter();
      const reading = parseOk(a, REC_876_BIA);
      const short = a.computeMetrics(reading, defaultProfile({ height: 165 }));
      const tall = a.computeMetrics(reading, defaultProfile({ height: 195 }));
      expect(short.bmi).toBeGreaterThan(tall.bmi);
      // The payload rounds BMI to two decimals, so match at that precision.
      expect(short.bmi).toBeCloseTo(87.6 / 1.65 ** 2, 2);
    });
  });
});
