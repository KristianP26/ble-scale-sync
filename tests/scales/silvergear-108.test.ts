import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Silvergear108Adapter, BODY_FRAME_WINDOW_MS } from '../../src/scales/silvergear-108.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { buildPayload } from '../../src/scales/body-comp-helpers.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';
import { bleLog, IMPEDANCE_GRACE_MS } from '../../src/ble/types.js';

/**
 * Every frame below is lifted verbatim from the two iOS PacketLogger captures
 * attached to #297. The reporter recorded the outcome of each session, so the
 * settled frames have known ground truth: 108.5 kg and 5.6 kg as displayed.
 *
 * MAC A0:85:61:91:E9:4F, reversed into the first six bytes of every frame.
 */
const MAC_REVERSED = '4fe9916185a0';

/** Manufacturer data as BlueZ and Noble deliver it: company id already stripped. */
function mfg(payloadHex: string): Buffer {
  return Buffer.from(MAC_REVERSED + payloadHex, 'hex');
}

/** The idle frame. Present in BOTH captures, so it is a real zero-load reading. */
const IDLE = 'a02ca0a00db9';
/** Settled 108.480 kg. The scale displayed 108.5. */
const SETTLED_108 = '202d07600da1';
/** The same weight one frame earlier, still settling (bit 7 clear). */
const SETTLING_108 = 'a02d07600da1';
/** Settled 5.610 kg. The scale displayed 5.6. */
const SETTLED_5_6 = '202cb54a0db8';
/** Post-weigh-in body frame from the 108.5 kg session (type 0x06). */
const BODY_108 = 'a2b1a0a206bb';
/** Post-weigh-in body frame from the 5.6 kg session: an object, not a body. */
const BODY_5_6 = 'a0a0a0a206a8';

function advert(payloadHex = SETTLED_108, uuids: string[] = ['ffb0']): BleDeviceInfo {
  return {
    localName: '108',
    serviceUuids: uuids,
    manufacturerData: { id: 0xa0ac, data: mfg(payloadHex) },
  };
}

describe('Silvergear108Adapter (#297)', () => {
  // A fresh adapter per case. The registry hands out one shared instance, and an
  // adapter that remembers a weigh-in would otherwise carry it from one case into
  // the next, so a case could pass or fail on the order it runs in.
  let adapter: Silvergear108Adapter;
  beforeEach(() => {
    adapter = new Silvergear108Adapter();
  });

  describe('matches() and registry resolution', () => {
    it('claims the captured advertisement', () => {
      expect(adapter.matches(advert())).toBe(true);
      expect(resolveAdapter(advert(), adapters)?.name).toBe('Silvergear Smart Scale 108');
    });

    it('claims it with no advertised service list, as BlueZ delivers it pre-connect', () => {
      expect(adapter.matches(advert(SETTLED_108, []))).toBe(true);
    });

    it('does not claim the name alone: "108" identifies nothing', () => {
      expect(adapter.matches({ localName: '108', serviceUuids: ['ffb0'] })).toBe(false);
    });

    it('does not claim another vendor on the same service', () => {
      const other = advert();
      other.manufacturerData = { id: 0x02ac, data: mfg(SETTLED_108) };
      expect(adapter.matches(other)).toBe(false);
    });

    it('does not claim a payload whose checksum does not close', () => {
      const broken = advert();
      broken.manufacturerData = { id: 0xa0ac, data: mfg('202d07600d00') };
      expect(adapter.matches(broken)).toBe(false);
    });

    it('does not claim a payload of the wrong length', () => {
      const short = advert();
      short.manufacturerData = { id: 0xa0ac, data: Buffer.from(MAC_REVERSED + 'a02ca0', 'hex') };
      expect(adapter.matches(short)).toBe(false);
    });
  });

  describe('parseBroadcast()', () => {
    // Decoded, but not complete on its own: the reading waits for the weigh-in's
    // post-weigh-in frame (#357), see the describe block below.
    it('decodes the settled 108.5 kg frame', () => {
      const reading = adapter.parseBroadcast(mfg(SETTLED_108));
      expect(reading).toEqual({ weight: 108.48, impedance: 0 });
      expect(adapter.isComplete(reading!)).toBe(false);
    });

    it('decodes the settled 5.6 kg frame from the second capture', () => {
      const reading = adapter.parseBroadcast(mfg(SETTLED_5_6));
      expect(reading).toEqual({ weight: 5.61, impedance: 0 });
      expect(adapter.isComplete(reading!)).toBe(false);
    });

    // The two captures share this frame byte for byte, which is what makes the
    // weight bias a measurement rather than a fit to one session.
    it('reads the idle frame shared by both captures as zero, and does not publish it', () => {
      expect(adapter.parseBroadcast(mfg(IDLE))).toBeNull();
    });

    // The node-ble broadcast path re-reads BlueZ's cached advertisement on a
    // timer, so an unchanged frame reaches parseBroadcast many times (#372).
    it('logs a settling weight once, not once per re-read of the same advertisement', () => {
      const spy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      spy.mockClear(); // spyOn returns the existing mock when already spied
      const adapter = new Silvergear108Adapter();
      const frame = mfg(SETTLING_108);
      for (let i = 0; i < 5; i++) adapter.parseBroadcast(frame);
      const settlingLines = spy.mock.calls.filter((c) => String(c[0]).includes('settling'));
      expect(settlingLines).toHaveLength(1);
    });

    it('logs again once the settling weight actually changes', () => {
      const spy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      spy.mockClear(); // spyOn returns the existing mock when already spied
      const adapter = new Silvergear108Adapter();
      adapter.parseBroadcast(mfg(SETTLING_108));
      adapter.parseBroadcast(mfg(SETTLING_108));
      adapter.parseBroadcast(mfg(IDLE));
      const settlingLines = spy.mock.calls.filter((c) => String(c[0]).includes('settling'));
      expect(settlingLines).toHaveLength(2);
    });

    it('drops the settling stream even when it carries the final weight', () => {
      // Same 24-bit weight field as the settled frame, bit 7 of the status byte
      // clear. Publishing this would publish numbers the scale never displayed:
      // the same capture runs 39.60, 55.48, 83.46 and 107.03 kg on the way up.
      expect(adapter.parseBroadcast(mfg(SETTLING_108))).toBeNull();
    });

    it('does not publish the post-weigh-in body frame', () => {
      expect(adapter.parseBroadcast(mfg(BODY_108))).toBeNull();
      expect(adapter.parseBroadcast(mfg(BODY_5_6))).toBeNull();
    });

    it('rejects a frame whose checksum does not close', () => {
      expect(adapter.parseBroadcast(mfg('202d07600d00'))).toBeNull();
    });

    it('rejects manufacturer data of the wrong length', () => {
      expect(adapter.parseBroadcast(Buffer.from(MAC_REVERSED + '202d07600d', 'hex'))).toBeNull();
      expect(adapter.parseBroadcast(Buffer.alloc(0))).toBeNull();
    });

    it('rejects an out-of-range weight that happens to checksum', () => {
      // 0xffffff - 0x8C0000 grams is far past any human load; the checksum is
      // only five bits wide, so the range bound is what stops a mangled frame.
      const p = Buffer.from([0xa0 ^ 0x80, 0xff, 0xff, 0xff, 0x0d, 0x00]);
      p[5] = (0xa0 + ((p[0] + p[1] + p[2] + p[3] + p[4]) & 0x1f)) & 0xff;
      expect(
        adapter.parseBroadcast(Buffer.concat([Buffer.from(MAC_REVERSED, 'hex'), p])),
      ).toBeNull();
    });
  });

  // The display unit lives in the TOP 3 BITS of the last payload byte, and the
  // checksum in the low 5. Reading the whole byte as a checksum made the adapter
  // reject every frame from a scale not set to kilograms (#297). All frames here
  // are verbatim from the reporter's captures at each unit setting.
  describe('display units', () => {
    /** Same weigh-in as SETTLED_ST, with the scale showing 17 st 2 lb. */
    const SETTLED_ST = '202d099c0dff';
    /** A body frame captured with the scale showing 240.0 lb. */
    const BODY_LB = 'a2aea0a20698';
    /** A zero-load weight frame with the scale showing stones. */
    const IDLE_ST = 'a02ca0a00df9';

    it('decodes a weigh-in taken with the scale showing stones', () => {
      // 17 st 2 lb is 108.862 kg, and the app reported 240.0 lb for the same
      // weigh-in, which is the same number. The gram field does not change with
      // the display unit, so nothing is converted.
      const reading = adapter.parseBroadcast(mfg(SETTLED_ST));
      expect(reading).toEqual({ weight: 108.86, impedance: 0 });
      expect(adapter.isComplete(reading!)).toBe(false);
    });

    it('claims and parses frames at every observed unit setting', () => {
      for (const hex of [SETTLED_108, SETTLED_ST, IDLE_ST, BODY_LB]) {
        expect(adapter.matches(advert(hex))).toBe(true);
      }
    });

    it('still rejects a frame whose low five checksum bits do not close', () => {
      // Only the low 5 bits are the checksum, so the corruption has to be there
      // for the frame to be refused; changing the unit bits must not refuse it.
      const p = Buffer.from(SETTLED_ST, 'hex');
      p[5] = (p[5] & 0xe0) | ((p[5] + 1) & 0x1f);
      expect(adapter.parseBroadcast(mfg(p.toString('hex')))).toBeNull();
    });

    it('accepts a unit value it has never seen, rather than refusing the weigh-in', () => {
      // The three observed values are kg, lb and st. An unknown one is logged by
      // name and otherwise ignored: the weight is in grams either way, and
      // refusing a reading over an unrecognised presentation flag would repeat
      // the bug this describe block exists for.
      const p = Buffer.from(SETTLED_ST, 'hex');
      p[5] = (p[5] & 0x1f) | 0x60;
      expect(adapter.parseBroadcast(mfg(p.toString('hex')))?.weight).toBeCloseTo(108.86, 3);
    });
  });

  // The settled weight used to complete the reading on its own, which ended every
  // broadcast scan before the scale's post-weigh-in 0x06 frame arrived (#357).
  // Frames and their spacing below are from the #297 captures; each timestamp is
  // milliseconds after the first frame listed for that capture.
  describe('holding a weigh-in for its own post-weigh-in frame (#357)', () => {
    let clock: number;
    let held: Silvergear108Adapter;
    beforeEach(() => {
      clock = 0;
      held = new Silvergear108Adapter(() => clock);
    });

    /** Feed one frame at a time, returning the reading and whether it completes. */
    function at(ms: number, payloadHex: string, mac = MAC_REVERSED) {
      clock = ms;
      const reading = held.parseBroadcast(Buffer.from(mac + payloadHex, 'hex'));
      return { reading, complete: reading !== null && held.isComplete(reading) };
    }

    /** Replay a capture and return every frame that completed a reading. */
    function replay(frames: Array<[number, string]>) {
      return frames.map(([ms, hex]) => ({ ms, hex, ...at(ms, hex) })).filter((f) => f.complete);
    }

    // 108.5 kg capture: one settled frame, then 0x06 885 ms later.
    it('completes once, on the 0x06, in the 108.5 kg capture', () => {
      const done = replay([
        [0, SETTLING_108],
        [2112, SETTLED_108],
        [2997, BODY_108],
        [9021, BODY_108],
      ]);
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ ms: 2997, reading: { weight: 108.48, impedance: 0 } });
    });

    // 5.6 kg capture, timestamps from the first 'a02cb54a0db8'. The settled frame
    // repeats for 1.3 s and the 0x06 stream runs for 16 s after it.
    it('completes once, on the 0x06, in the 5.6 kg capture', () => {
      const done = replay([
        [0, 'a02cb54a0db8'],
        [1187, SETTLED_5_6],
        [2465, SETTLED_5_6],
        [2726, BODY_5_6],
        [18932, BODY_5_6],
      ]);
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ ms: 2726, reading: { weight: 5.61, impedance: 0 } });
    });

    // 17 st 2 lb capture, timestamps from the LAST 'a02d099c0dff' before settling.
    it('completes once, on the 0x06, in the 17 st 2 lb capture', () => {
      const done = replay([
        [0, 'a02d099c0dff'],
        [622, '202d099c0dff'],
        [2168, '202d099c0dff'],
        [2319, 'a2ada0a206f7'],
        [8745, 'a2ada0a206f7'],
      ]);
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ ms: 2319, reading: { weight: 108.86, impedance: 0 } });
    });

    it('hands the settled weight out as partial, repeat included, until the 0x06', () => {
      const first = at(0, SETTLED_108);
      const repeat = at(1000, SETTLED_108);
      expect(first).toEqual({ reading: { weight: 108.48, impedance: 0 }, complete: false });
      expect(repeat).toEqual({ reading: { weight: 108.48, impedance: 0 }, complete: false });
    });

    // The scale keeps sending 0x06 for seconds after a weigh-in, so a new session
    // can open on the previous weigh-in's frame. It must not pair with anything.
    it('does not complete on a 0x06 that no settled weight came before', () => {
      expect(at(0, BODY_108)).toEqual({ reading: null, complete: false });
      expect(at(500, SETTLED_108).complete).toBe(false);
      expect(at(1500, BODY_108).complete).toBe(true);
    });

    it('pairs a 0x06 exactly at the window edge, and not one millisecond later', () => {
      at(0, SETTLED_108);
      expect(at(BODY_FRAME_WINDOW_MS, BODY_108).complete).toBe(true);

      const late = new Silvergear108Adapter(() => clock);
      clock = 0;
      late.parseBroadcast(mfg(SETTLED_108));
      clock = BODY_FRAME_WINDOW_MS + 1;
      expect(late.parseBroadcast(mfg(BODY_108))).toBeNull();
    });

    it('counts the window from the first settled frame, not from a repeat', () => {
      at(0, SETTLED_108);
      at(5000, SETTLED_108);
      expect(at(BODY_FRAME_WINDOW_MS + 1, BODY_108).reading).toBeNull();
    });

    // Past the window the transport's own fallback owns the weigh-in. Handing the
    // weight out again would re-arm that fallback after it had fired.
    it('stops handing out the settled weight once the window has passed', () => {
      at(0, SETTLED_108);
      expect(at(BODY_FRAME_WINDOW_MS + 1, SETTLED_108).reading).toBeNull();
    });

    it('does not pair across a settling frame, which ends the weigh-in', () => {
      at(0, SETTLED_108);
      at(500, SETTLING_108);
      expect(at(1000, BODY_108).reading).toBeNull();
    });

    it('closes a weigh-in once: neither its 0x06 nor its weight completes again', () => {
      at(0, SETTLED_108);
      expect(at(900, BODY_108).complete).toBe(true);
      expect(at(1200, BODY_108).reading).toBeNull();
      expect(at(1300, SETTLED_108).reading).toBeNull();
    });

    it('reports the next weigh-in even when it lands on the same grams', () => {
      at(0, SETTLED_108);
      at(900, BODY_108);
      at(20_000, IDLE);
      at(21_000, SETTLING_108);
      expect(at(22_000, SETTLED_108)).toEqual({
        reading: { weight: 108.48, impedance: 0 },
        complete: false,
      });
      expect(at(23_000, BODY_108).complete).toBe(true);
    });

    // Discovery can finish after the scale settles, so the settling stream that
    // would end the last weigh-in is not always seen. A remembered weigh-in is
    // forgotten after a minute, or a same-grams weigh-in would be dropped for good.
    it('forgets a paired weigh-in after a minute', () => {
      at(0, SETTLED_108);
      at(900, BODY_108);
      expect(at(30_000, SETTLED_108).reading).toBeNull();
      expect(at(60_001, SETTLED_108).reading).toEqual({ weight: 108.48, impedance: 0 });
      expect(at(61_000, BODY_108).complete).toBe(true);
    });

    it('does not pair a 0x06 from another unit', () => {
      const OTHER_MAC = '112233445566';
      at(0, SETTLED_108);
      expect(at(900, BODY_108, OTHER_MAC).reading).toBeNull();
      expect(at(1000, BODY_108).complete).toBe(true);
    });

    // Two people, or one stepping off and back on. The first steps off before
    // any 0x06, so the settling frame that follows ends their weigh-in while the
    // transport is still holding it. The transport keeps one held reading per
    // address, so a second weigh-in in that hold would overwrite the first and
    // it would be lost. The first is completed from the settling frame instead,
    // weight only, which makes the transport export it at once and drop its
    // grace timer; the second then gets a hold, and a pairing window, of its own.
    it('exports a weigh-in that ends before its 0x06, and gives the next its own hold', () => {
      at(0, SETTLED_108);
      expect(at(3000, SETTLING_108)).toEqual({
        reading: { weight: 108.48, impedance: 0 },
        complete: true,
      });
      // Re-reads of the settling stream, and a late 0x06, add nothing to it.
      expect(at(3500, SETTLING_108).reading).toBeNull();
      expect(at(6000, '202d099c0dff')).toEqual({
        reading: { weight: 108.86, impedance: 0 },
        complete: false,
      });
      // Measured from the second weigh-in's own hold, which began at 6 s.
      expect(at(6000 + BODY_FRAME_WINDOW_MS, 'a2ada0a206f7')).toEqual({
        reading: { weight: 108.86, impedance: 0 },
        complete: true,
      });
    });

    it('does not pair a late 0x06 with a weigh-in its step-off already reported', () => {
      at(0, SETTLED_108);
      expect(at(3000, SETTLING_108).complete).toBe(true);
      expect(at(3500, BODY_108).reading).toBeNull();
      expect(at(4000, IDLE).reading).toBeNull();
    });

    // Past the window the transport's grace timer owns the weigh-in, as for a
    // late 0x06, so the step-off completes nothing and the hold carries on:
    // measuring a new window from the next weigh-in would let its 0x06 complete
    // after the timer had already exported the hold, two exports of one hold.
    it('leaves a weigh-in that ends past the window to the transport, and keeps its hold', () => {
      at(0, SETTLED_108);
      expect(at(BODY_FRAME_WINDOW_MS + 1, SETTLING_108).reading).toBeNull();
      expect(at(BODY_FRAME_WINDOW_MS + 500, '202d099c0dff').reading).toEqual({
        weight: 108.86,
        impedance: 0,
      });
      expect(at(BODY_FRAME_WINDOW_MS + 1000, 'a2ada0a206f7').reading).toBeNull();
    });

    // The transport's grace timer fires IMPEDANCE_GRACE_MS into the hold, on the
    // event loop and possibly late, so a new hold waits a second past it.
    it('starts a fresh hold only a second after the last one can have run out', () => {
      at(0, SETTLED_108);
      at(BODY_FRAME_WINDOW_MS + 1, SETTLING_108);
      at(IMPEDANCE_GRACE_MS + 999, SETTLED_108);
      expect(at(IMPEDANCE_GRACE_MS + 1500, BODY_108).reading).toBeNull();

      at(IMPEDANCE_GRACE_MS + 2000, SETTLING_108);
      at(IMPEDANCE_GRACE_MS + 2500, IDLE);
      at(IMPEDANCE_GRACE_MS + 3000, SETTLED_108);
      expect(at(IMPEDANCE_GRACE_MS + 3500, BODY_108).complete).toBe(true);
    });

    it('opens the new hold exactly a second after the grace, not a millisecond sooner', () => {
      at(0, SETTLED_108);
      at(BODY_FRAME_WINDOW_MS + 1, SETTLING_108);
      at(IMPEDANCE_GRACE_MS + 1000, SETTLED_108);
      expect(at(IMPEDANCE_GRACE_MS + 1500, BODY_108).complete).toBe(true);
    });

    // Default clock: performance.now(), which NTP cannot step. A wall clock that
    // jumps back inside a hold must not reopen the pairing window.
    it('times the hold on the monotonic clock, not the wall clock', () => {
      vi.useFakeTimers({ toFake: ['Date', 'performance'] });
      try {
        const mono = new Silvergear108Adapter();
        mono.parseBroadcast(mfg(SETTLED_108));
        vi.advanceTimersByTime(BODY_FRAME_WINDOW_MS + 1);
        vi.setSystemTime(Date.now() - 60_000);
        expect(mono.parseBroadcast(mfg(BODY_108))).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    // The proxy watchers export the held weight when the grace runs out, without
    // recording it in their dedup window. A 0x06 paired after that would export
    // the same weigh-in a second time.
    it('keeps the pairing window inside the transport grace window', () => {
      expect(BODY_FRAME_WINDOW_MS).toBeLessThan(IMPEDANCE_GRACE_MS);
    });

    it('never publishes the 0x06 field as impedance', () => {
      at(0, SETTLED_108);
      expect(at(900, BODY_108).reading?.impedance).toBe(0);
    });

    it('logs the settled weight, and the 0x06 against the weigh-in it closed', () => {
      const spy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      spy.mockClear();
      at(0, SETTLED_108);
      at(885, BODY_108);
      // The scale repeats the frame for seconds; the repeats belong to the same,
      // already closed weigh-in and say nothing new.
      at(1500, BODY_108);
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('body frame'))).toHaveLength(1);
      expect(lines).toContain(
        'Silvergear settled: 108.480 kg (scale is displaying kg), ' +
          'holding for its post-weigh-in frame',
      );
      expect(lines).toContain(
        `Silvergear body frame (undecoded): ${MAC_REVERSED}${BODY_108} field=529, ` +
          '0.9 s after settling at 108.480 kg',
      );
    });

    it('logs an unpaired 0x06 once, however often it is re-read', () => {
      const spy = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      spy.mockClear();
      for (let i = 0; i < 5; i++) at(i * 100, BODY_108);
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('body'));
      expect(lines).toEqual([
        `Silvergear body frame (undecoded, no settled weight from this weigh-in): ` +
          `${MAC_REVERSED}${BODY_108} field=529`,
      ]);
    });
  });

  describe('body composition', () => {
    it('estimates from BMI, since the advertisement carries no decoded impedance', () => {
      const profile = defaultProfile();
      expect(adapter.computeMetrics({ weight: 108.48, impedance: 0 }, profile)).toEqual(
        buildPayload(108.48, 0, {}, profile),
      );
    });
  });
});
