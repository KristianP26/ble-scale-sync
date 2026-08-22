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

  describe('de-duplication and multi-user backlog', () => {
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

    it('emits one live reading, then history, so a backlog drains in one session', () => {
      // The household case: two people weigh before the sync runs. Both records
      // must reach the exporters from a single session, because the scale powers
      // off long before a second cycle could connect.
      const a = makeAdapter();
      a.parseNotification(clockReply(tsOf(REC_897_SLOT2), 30));

      const live = a.parseNotification(REC_897_SLOT2);
      expect(live).not.toBeNull();
      expect(live!.timestamp).toBeUndefined(); // live: resolves the session

      const older = a.parseNotification(REC_888_SLOT7);
      expect(older).not.toBeNull();
      expect(older!.timestamp).toBeInstanceOf(Date); // history: rides along
      expect(older!.weight).toBeCloseTo(88.8, 4);
    });

    it('dates history from the scale clock, not the host clock', () => {
      // The scale's clock was found an hour off the host's. Comparing a record
      // against the scale's OWN clock cancels that offset.
      const a = makeAdapter();
      const ageSec = 600;
      a.parseNotification(clockReply(tsOf(REC_897_SLOT2), 0));
      a.parseNotification(REC_897_SLOT2); // consumes the live slot

      const record = Buffer.from(REC_888_SLOT7);
      record.writeUInt32LE(tsOf(REC_897_SLOT2) - ageSec, 2);
      const reading = a.parseNotification(record);
      const deltaMs = Date.now() - reading!.timestamp!.getTime();
      expect(deltaMs / 1000).toBeGreaterThan(ageSec - 5);
      expect(deltaMs / 1000).toBeLessThan(ageSec + 5);
    });

    it('leaves a record unreported when the clock is unusable', () => {
      // No clock read yet: dating it would invent a measurement time, so it is
      // left for the next session to emit as the live reading instead.
      const a = makeAdapter();
      expect(a.parseNotification(REC_897_SLOT2)).not.toBeNull(); // live
      expect(a.parseNotification(REC_888_SLOT7)).toBeNull(); // no clock
      a.onSessionEnd();
      a.parseNotification(clockReply(tsOf(REC_888_SLOT7), 60));
      expect(a.parseNotification(REC_888_SLOT7)?.weight).toBeCloseTo(88.8, 4);
    });

    it('rejects a record the clock says is impossibly old', () => {
      const a = makeAdapter();
      a.parseNotification(clockReply(tsOf(REC_897_SLOT2), 0));
      a.parseNotification(REC_897_SLOT2);
      const ancient = Buffer.from(REC_888_SLOT7);
      ancient.writeUInt32LE(1, 2); // clock reset; record claims 1970
      expect(a.parseNotification(ancient)).toBeNull();
    });

    it('drains two weigh-ins across consecutive sessions, losing neither', () => {
      // Without a clock only one reading leaves per session, so the second must
      // still be waiting on the next one rather than being suppressed.
      const a = makeAdapter();
      const sweep = [REC_897_SLOT2, REC_888_SLOT7];

      const first = sweep.map((r) => a.parseNotification(r)).filter((r) => r !== null);
      expect(first).toHaveLength(1);
      a.onSessionEnd();

      const second = sweep.map((r) => a.parseNotification(r)).filter((r) => r !== null);
      expect(second).toHaveLength(1);
      a.onSessionEnd();

      const third = sweep.map((r) => a.parseNotification(r)).filter((r) => r !== null);
      expect(third).toHaveLength(0);

      const weights = [first[0]!.weight, second[0]!.weight].sort();
      expect(weights).toEqual([88.8, 89.7]);
    });

    it('does not suppress an older record just because a newer one was seen', () => {
      // A high-water mark would drop the earlier of two weigh-ins permanently.
      const a = makeAdapter();
      expect(a.parseNotification(REC_897_SLOT2)?.weight).toBeCloseTo(89.7, 4); // newest
      a.onSessionEnd();
      expect(a.parseNotification(REC_857_APP)?.weight).toBeCloseTo(85.7, 4); // much older
    });

    it('re-arms after every session', () => {
      const a = makeAdapter();
      expect(a.parseNotification(REC_880_SLOT1)).not.toBeNull();
      expect(a.parseNotification(REC_897_SLOT2)).toBeNull(); // no clock: deferred
      a.onSessionEnd();
      expect(a.parseNotification(REC_897_SLOT2)).not.toBeNull();
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
