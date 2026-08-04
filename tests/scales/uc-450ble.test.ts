import { describe, it, expect, vi, afterEach } from 'vitest';
import { Uc450bleAdapter } from '../../src/scales/uc-450ble.js';
import { adapters } from '../../src/scales/index.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  expectMatches,
  parseOk,
  expectValidMetrics,
} from '../helpers/scale-test-utils.js';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s/g, ''), 'hex');

// ─── Fixtures straight from the iOS PacketLogger capture of the A&D app ──────

/** Idle status frame the scale sends first on A621. */
const STATUS = hex('10 0A 00 07 00 00 00 00 00 00 00 52');
/** Scale's "time accepted" reply on A621. */
const TIME_OK = hex('10 05 10 00 10 02 01');
/**
 * Two stored records from the app capture: 99.45 kg, 395 and 391 ohm, 22s apart.
 * Byte [5] is 0 in both, i.e. each was the last record of its dump.
 */
const RECORD_A = hex('10 11 48 02 00 00 00 01 40 08 26 D9 6A 70 FB 90 01 8B 00');
const RECORD_B = hex('10 11 48 02 00 00 00 01 40 08 26 D9 6A 70 FB A6 01 87 00');

/**
 * Records from a live hardware dump (2026-08-03). Byte [5] counts down, so
 * these exercise the continue/stop decision that RECORD_A/B cannot.
 */
const RECORD_MORE = hex('10 11 48 02 00 0B 00 01 40 08 26 D9 6A 70 FB A6 01 87 00'); // 11 left
const RECORD_LAST = hex('10 11 48 02 00 00 00 01 40 08 26 C5 6A 71 0C F1 00 00 00'); // last, no BIA

/** Absolute Unix seconds encoded in RECORD_A / RECORD_B. */
const RECORD_A_TS = 0x6a70fb90;
const RECORD_B_TS = 0x6a70fba6;

function makeAdapter(): Uc450bleAdapter {
  return new Uc450bleAdapter();
}

/**
 * Adapter with a stubbed ConnectionContext, capturing every write.
 *
 * The scale acknowledges each A624 command on A625 before it will accept the
 * next one, and the adapter now waits for that. `autoAck` replays it so the
 * handshake advances at full speed; pass false to exercise the timeout path.
 * The ACK is deferred by a macrotask because the adapter arms its waiter in the
 * microtask that follows the write.
 */
function connected(nowSec = RECORD_A_TS, autoAck = true) {
  vi.setSystemTime(nowSec * 1000);
  const adapter = makeAdapter();
  const writes: Array<{ uuid: string; data: string }> = [];
  const ctx = {
    write: vi.fn(async (uuid: string, data: Buffer | number[]) => {
      writes.push({ uuid, data: Buffer.from(data as number[]).toString('hex') });
      if (autoAck && uuid === uuid16(0xa624)) {
        setTimeout(() => adapter.parseCharNotification(uuid16(0xa625), hex('00 01 01')), 0);
      }
    }),
    read: vi.fn(),
    subscribe: vi.fn(),
    profile: defaultProfile(),
    deviceAddress: 'F88FC8AF4936',
    availableChars: new Set<string>(),
  } as unknown as ConnectionContext;
  adapter.onConnected(ctx);
  return { adapter, writes };
}

describe('Uc450bleAdapter', () => {
  // Record freshness is judged against the wall clock, so the fixtures' absolute
  // timestamps only make sense with the clock pinned. Restore it afterwards so
  // the mocked Date cannot leak into another suite.
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('matches()', () => {
    it('matches the advertised name and the A602 vendor service', () => {
      expectMatches(makeAdapter(), {
        yes: [
          'UC-450BLE-CV_AF4936',
          'uc-450ble',
          mockPeripheral('', ['a602']),
          mockPeripheral('', [uuid16(0xa602)]),
        ],
        no: ['QN-Scale', 'renpho ES-CS20M', mockPeripheral('', ['fff0'])],
      });
    });

    it('matches on the 12345678 manufacturer-data magic', () => {
      // Noble splits the leading two bytes off as the company id (LE 0x3412).
      const mfg = { id: 0x3412, data: hex('56 78 01 F8 8F C8 AF 49 36') };
      expect(makeAdapter().matches(mockPeripheral('', [], undefined))).toBe(false);
      expect(
        makeAdapter().matches({ localName: '', serviceUuids: [], manufacturerData: mfg }),
      ).toBe(true);
    });

    it('matches a nameless device by the A621 + A624 characteristic pair', () => {
      const info = mockPeripheral('', [], undefined, [uuid16(0xa621), uuid16(0xa624)]);
      expect(makeAdapter().matches(info)).toBe(true);
    });

    it('does not claim a device exposing only one of the pair', () => {
      const info = mockPeripheral('', [], undefined, [uuid16(0xa621)]);
      expect(makeAdapter().matches(info)).toBe(false);
    });

    it('resolves through the registry to this adapter', () => {
      const matched = adapters.find((a) => a.matches(mockPeripheral('UC-450BLE-CV_AF4936')));
      expect(matched?.name).toBe('A&D UC-450BLE');
    });
  });

  describe('parseNotification() — measurement records', () => {
    it('decodes weight and impedance from the captured record', () => {
      const { adapter } = connected();
      const reading = parseOk(adapter, RECORD_A, { weight: 99.45, impedance: 395 });
      // 99.45 kg is 219.2 lb; the reporter's scale read 218.9 lb.
      expect(reading.weight * 2.20462).toBeCloseTo(219.2, 1);
    });

    it('decodes the second record with its own impedance', () => {
      const { adapter } = connected();
      parseOk(adapter, RECORD_B, { weight: 99.45, impedance: 391 });
    });

    it('treats a fresh record as live (no timestamp)', () => {
      const { adapter } = connected(RECORD_A_TS + 5);
      const reading = parseOk(adapter, RECORD_A);
      expect(reading.timestamp).toBeUndefined();
    });

    it('marks an old record as historical with its captured timestamp', () => {
      const { adapter } = connected(RECORD_A_TS + 3600);
      const reading = parseOk(adapter, RECORD_A);
      expect(reading.timestamp).toEqual(new Date(RECORD_A_TS * 1000));
    });

    it('distinguishes the two records by timestamp', () => {
      const { adapter } = connected(RECORD_B_TS + 3600);
      const a = parseOk(adapter, RECORD_A);
      const b = parseOk(adapter, RECORD_B);
      expect(b.timestamp!.getTime() - a.timestamp!.getTime()).toBe(22_000);
    });

    it('rejects a truncated record but still fetches the next one', async () => {
      const { adapter, writes } = connected();
      expect(adapter.parseNotification(RECORD_A.subarray(0, 12))).toBeNull();
      // A malformed record must not stall the dump: the scale only sends the
      // next record in response to our fetch.
      await vi.waitFor(() => expect(writes.some((w) => w.data === '100448010001')).toBe(true));
    });

    it('rejects an implausible weight but still fetches the next one', async () => {
      const { adapter, writes } = connected();
      const bad = Buffer.from(RECORD_MORE); // records still remaining
      bad.writeUInt16BE(30_000, 10); // 300 kg
      expect(adapter.parseNotification(bad)).toBeNull();
      await vi.waitFor(() => expect(writes.some((w) => w.data === '100448010001')).toBe(true));
    });

    it('ignores frames that are not vendor frames', () => {
      const { adapter } = connected();
      expect(adapter.parseNotification(hex('00 01 01'))).toBeNull();
      expect(adapter.parseNotification(hex('11 0A 00'))).toBeNull();
      expect(adapter.parseNotification(Buffer.alloc(0))).toBeNull();
    });

    it('returns null for an unknown subcommand', () => {
      const { adapter } = connected();
      expect(adapter.parseNotification(hex('10 04 99 01 00 01'))).toBeNull();
    });
  });

  describe('parseCharNotification() routing', () => {
    it('drops the A625 ACK channel without parsing', () => {
      const { adapter } = connected();
      expect(adapter.parseCharNotification(uuid16(0xa625), hex('00 01 01'))).toBeNull();
    });

    it('parses records arriving on A621', () => {
      const { adapter } = connected();
      const reading = adapter.parseCharNotification(uuid16(0xa621), RECORD_A);
      expect(reading?.weight).toBeCloseTo(99.45, 2);
    });
  });

  describe('handshake', () => {
    it('answers the status frame with an ACK, hello, and time sync', async () => {
      const { adapter, writes } = connected();
      adapter.parseNotification(STATUS);
      await vi.waitFor(() => expect(writes.length).toBe(3));

      expect(writes[0]).toEqual({ uuid: uuid16(0xa622), data: '000101' });
      expect(writes[1]).toEqual({
        uuid: uuid16(0xa624),
        data: '100b00080100000000000001 01'.replace(/\s/g, ''),
      });
      // 10 08 10 02 03 <unix BE> <tz>
      expect(writes[2].uuid).toBe(uuid16(0xa624));
      expect(writes[2].data.slice(0, 10)).toBe('1008100203');
      expect(parseInt(writes[2].data.slice(10, 18), 16)).toBe(RECORD_A_TS);
    });

    it('sends only one A624 command at a time, waiting for each A625 ack', async () => {
      // Regression: firing HELLO and the time sync back to back put both in one
      // connection interval; the real scale acked once and then went silent for
      // the rest of the session, heartbeat included.
      const { adapter, writes } = connected(RECORD_A_TS, false);
      adapter.parseNotification(STATUS);

      await vi.waitFor(() => expect(writes.length).toBe(2)); // ack + HELLO
      await new Promise((r) => setTimeout(r, 30));
      expect(writes.length).toBe(2); // time sync withheld until HELLO is acked

      adapter.parseCharNotification(uuid16(0xa625), hex('00 01 01'));
      await vi.waitFor(() => expect(writes.length).toBe(3));
      expect(writes[2].data.slice(0, 10)).toBe('1008100203');
    });

    it('continues if an ack never arrives, rather than wedging the session', async () => {
      const { adapter, writes } = connected(RECORD_A_TS, false);
      adapter.parseNotification(STATUS);
      // ACK_TIMEOUT_MS is 1500ms; the time sync must still go out eventually.
      await vi.waitFor(() => expect(writes.length).toBe(3), { timeout: 5000 });
    }, 10_000);

    it('does not re-send the handshake on a repeated status frame', async () => {
      const { adapter, writes } = connected();
      adapter.parseNotification(STATUS);
      await vi.waitFor(() => expect(writes.length).toBe(3));
      adapter.parseNotification(STATUS);
      await vi.waitFor(() => expect(writes.length).toBe(5));
      // The hello and time sync are sent exactly once.
      expect(writes.filter((w) => w.data.startsWith('100b0008')).length).toBe(1);
      expect(writes.filter((w) => w.data.startsWith('1008100203')).length).toBe(1);
    });

    it('falls back to fetching records when the time-sync reply never arrives', async () => {
      const { adapter, writes } = connected();
      adapter.parseNotification(STATUS);
      await vi.waitFor(() => expect(writes.length).toBe(3));
      // Scale keeps heartbeating but never sends TIME_OK — must not stall.
      adapter.parseNotification(STATUS);
      await vi.waitFor(() => expect(writes.some((w) => w.data === '100448010001')).toBe(true));
    });

    it('does not double-start the fetch if the time-sync reply arrives late', async () => {
      const { adapter, writes } = connected();
      adapter.parseNotification(STATUS);
      await vi.waitFor(() => expect(writes.length).toBe(3));
      adapter.parseNotification(STATUS); // fallback starts the fetch
      await vi.waitFor(() => expect(writes.length).toBe(5));
      adapter.parseNotification(TIME_OK); // late reply must be a no-op
      await new Promise((r) => setTimeout(r, 20));
      expect(writes.filter((w) => w.data === '100448010001').length).toBe(1);
    });

    it('requests the first stored record once the time is accepted', async () => {
      const { adapter, writes } = connected();
      adapter.parseNotification(TIME_OK);
      await vi.waitFor(() => expect(writes.length).toBe(2));
      expect(writes[0].uuid).toBe(uuid16(0xa622));
      expect(writes[1]).toEqual({ uuid: uuid16(0xa624), data: '100448010001' });
    });

    it('acknowledges a record and asks for the next while more remain', async () => {
      const { adapter, writes } = connected();
      adapter.parseNotification(RECORD_MORE);
      await vi.waitFor(() => expect(writes.length).toBe(2));
      expect(writes[0]).toEqual({ uuid: uuid16(0xa622), data: '000101' });
      expect(writes[1]).toEqual({ uuid: uuid16(0xa624), data: '100448010001' });
    });

    it('stops fetching on the last record, which reports 0 remaining', async () => {
      // Fetching past the end leaves the scale silent and the session waiting
      // out the ack timeout for nothing.
      const { adapter, writes } = connected();
      adapter.parseNotification(RECORD_LAST);
      await vi.waitFor(() => expect(writes.length).toBe(1));
      await new Promise((r) => setTimeout(r, 30));
      expect(writes).toEqual([{ uuid: uuid16(0xa622), data: '000101' }]);
    });

    it('still caps the dump if the counter never reaches zero', async () => {
      const { adapter, writes } = connected();
      for (let i = 0; i < 30; i++) adapter.parseNotification(RECORD_MORE);
      await vi.waitFor(() =>
        expect(writes.filter((w) => w.data === '100448010001').length).toBe(23),
      );
    });

    it('writes without response on both vendor characteristics', async () => {
      vi.setSystemTime(RECORD_A_TS * 1000);
      const adapter = makeAdapter();
      const write = vi.fn(async () => {});
      adapter.onConnected({
        write,
        read: vi.fn(),
        subscribe: vi.fn(),
        profile: defaultProfile(),
        deviceAddress: '',
        availableChars: new Set<string>(),
      } as unknown as ConnectionContext);
      adapter.parseNotification(RECORD_A);
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
      for (const call of write.mock.calls) expect(call[2]).toBe(false);
    });
  });

  describe('isComplete()', () => {
    it('accepts a normal BIA reading', () => {
      expect(makeAdapter().isComplete({ weight: 99.45, impedance: 395 })).toBe(true);
    });

    it('accepts a weight-only record', () => {
      expect(makeAdapter().isComplete({ weight: 99.45, impedance: 0 })).toBe(true);
    });

    it('rejects an implausible weight or a nonsense impedance', () => {
      expect(makeAdapter().isComplete({ weight: 2, impedance: 395 })).toBe(false);
      expect(makeAdapter().isComplete({ weight: 99.45, impedance: 12 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('produces a sane body-composition payload from the captured reading', () => {
      const payload = expectValidMetrics(makeAdapter(), { weight: 99.45, impedance: 395 });
      expect(payload.impedance).toBe(395);
    });

    it('falls back to estimation when a record carried no impedance', () => {
      expectValidMetrics(makeAdapter(), { weight: 99.45, impedance: 0 });
    });
  });
});
