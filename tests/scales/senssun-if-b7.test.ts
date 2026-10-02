import { describe, it, expect, vi, afterEach } from 'vitest';
import { SenssunIfB7Adapter } from '../../src/scales/senssun-if-b7.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { buildPayload } from '../../src/scales/body-comp-helpers.js';
import { evaluateAdvertisement } from '../../src/ble/advertisement.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';
import { bleLog } from '../../src/ble/types.js';

/**
 * Real frames only, manufacturer data with the company id stripped as every
 * transport delivers it: two from the #423 reporter's first posts (the issue's
 * log and a frame quoted in a comment), more from the same reporter's ESPHome
 * export (timestamps as exported), and one from
 * ble_monitor. Nothing here is built from our own reading of the format; the
 * only altered frames below are single-byte changes to these, and each says
 * which byte.
 */

/** #423, unit 64:FB:01:2D:92:50, taken while weighing (status 0x01): 87.30 kg. */
const LIVE_87_30 = '02031164fb012d925001221a00000190ce';
/** #423, same unit, while weighing: 84.20 kg (the display settled on 84.3). */
const LIVE_84_20 = '02031164fb012d92500120e40000011c22';
const MAC_423 = '64:FB:01:2D:92:50';

/*
 * #423 comment 2026-09-29T16:52:27Z, ESPHome export of the same unit. A weigh-in
 * with the scale displaying kg, 88.1 kg in the vendor app.
 */
/** Frame at 16:37:23.467Z: the last weighing frame (status 0x01), 88.10 kg. */
const KG_WEIGHING_88_10 = '02031164fb012d925001226a000001d05e';
/** Frame at 16:37:23.875Z: the first finished frame (status 0xA1), 88.10 kg, [12..13] = 0. */
const KG_FINISHED_FIRST = '02031164fb012d925001226a0000a1d1ff';
/** Frame at 16:37:24.199Z: the next advert, only [15] and the checksum (0xff -> 0x00) differ. */
const KG_FINISHED_SECOND = '02031164fb012d925001226a0000a1d200';
/** Frame at 16:37:25.208Z: still finished, 88.10 kg, now [12..13] = 137. */
const KG_FINISHED_137 = '02031164fb012d925001226a0089a1d78e';

/*
 * The same export, a weigh-in 18 minutes later with the scale displaying lb. The
 * reporter gave no display value for it.
 */
/** Frame at 16:55:30.448Z: the last weighing frame (status 0x02), [10..11] = 8760. */
const LB_WEIGHING_87_60 = '02031164fb012d92500122380000027edb';
/** Frame at 16:55:30.856Z: the first finished frame (status 0xA2), [12..13] = 0. */
const LB_FINISHED_FIRST = '02031164fb012d92500122380000a27f7c';
/** Frame at 16:55:32.392Z: still finished, now [12..13] = 202. */
const LB_FINISHED_202 = '02031164fb012d925001223800caa2864d';

/**
 * custom-components/ble_monitor test_senssun_parser.py, the payload of the raw
 * HCI advertising report `043E2B...14FF0001<this>C5`: a second unit, finished
 * (status 0xA1), 67.25 kg, [12..13] = 180.
 */
const FINISHED_67_25 = '020311187a93c1b333021a4500b4a1ab61';
const MAC_BLE_MONITOR = '18:7A:93:C1:B3:33';

function buf(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/** A real frame with byte `index` replaced, checksum left as captured. */
function withByte(hex: string, index: number, value: number): Buffer {
  const b = buf(hex);
  b[index] = value;
  return b;
}

/**
 * A real frame with byte `index` replaced AND the checksum at [16] recomputed.
 * Such a frame is derived, not captured: it is only ever used to show that the
 * adapter REFUSES it, never to show what it decodes to.
 */
function derived(hex: string, index: number, value: number): Buffer {
  const b = withByte(hex, index, value);
  let sum = 0;
  for (let i = 9; i < 16; i++) sum += b[i];
  b[16] = sum & 0xff;
  return b;
}

function advert(
  data: Buffer | string,
  address: string | null = MAC_423,
  localName = 'IF_B7',
  id = 0x0100,
): BleDeviceInfo {
  return {
    localName,
    ...(address !== null ? { address } : {}),
    serviceUuids: [],
    manufacturerData: { id, data: typeof data === 'string' ? buf(data) : data },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SenssunIfB7Adapter (#423)', () => {
  describe('matches() and registry resolution', () => {
    const adapter = new SenssunIfB7Adapter();

    it('claims the #423 advertisement and wins the registry', () => {
      expect(adapter.matches(advert(LIVE_87_30))).toBe(true);
      expect(resolveAdapter(advert(LIVE_87_30), adapters)?.name).toBe('Senssun IF_B7');
    });

    it('claims a frame taken with the display in lb', () => {
      expect(adapter.matches(advert(LB_FINISHED_202))).toBe(true);
    });

    it('claims the ble_monitor unit on its own address', () => {
      expect(adapter.matches(advert(FINISHED_67_25, MAC_BLE_MONITOR))).toBe(true);
    });

    it('declares its company id, which node-ble filters manufacturer entries by', () => {
      expect(adapter.match.manufacturerId).toBe(0x0100);
    });

    it('refuses a real frame heard from a different address', () => {
      expect(adapter.matches(advert(LIVE_87_30, MAC_BLE_MONITOR))).toBe(false);
    });

    it('refuses a frame whose echoed MAC differs in one byte ([8] 0x50 -> 0x51)', () => {
      // [3..8] is outside the checksum, so this frame still closes; only the
      // echo check can refuse it.
      expect(adapter.matches(advert(withByte(LIVE_87_30, 8, 0x51)))).toBe(false);
    });

    it('refuses a frame whose checksum does not close ([16] 0xce -> 0xcf)', () => {
      expect(adapter.matches(advert(withByte(LIVE_87_30, 16, 0xcf)))).toBe(false);
    });

    it('refuses a frame whose header differs ([0] 0x02 -> 0x03)', () => {
      expect(adapter.matches(advert(withByte(LIVE_87_30, 0, 0x03)))).toBe(false);
    });

    it('refuses the same payload under another company id', () => {
      expect(adapter.matches(advert(LIVE_87_30, MAC_423, 'IF_B7', 0x0101))).toBe(false);
    });

    it('refuses a truncated frame (last byte dropped)', () => {
      expect(adapter.matches(advert(buf(LIVE_87_30).subarray(0, 16)))).toBe(false);
    });

    it('does not claim the name alone', () => {
      expect(adapter.matches({ localName: 'IF_B7', serviceUuids: [] })).toBe(false);
    });

    it('falls back to the exact name when the transport has no address (noble on macOS)', () => {
      expect(adapter.matches(advert(LIVE_87_30, null))).toBe(true);
      // What noble hands over on macOS: formatMac('<unknown>').
      expect(adapter.matches(advert(LIVE_87_30, '<U:NK:NO:WN'))).toBe(true);
      expect(adapter.matches(advert(LIVE_87_30, null, ''))).toBe(false);
      expect(adapter.matches(advert(LIVE_87_30, null, 'IF_B7X'))).toBe(false);
    });

    it('does not let the name override a known address that does not match', () => {
      expect(adapter.matches(advert(LIVE_87_30, MAC_BLE_MONITOR, 'IF_B7'))).toBe(false);
    });
  });

  describe('decoding', () => {
    it('reports the #423 frames as live weights, never as readings', () => {
      const adapter = new SenssunIfB7Adapter();
      expect(adapter.parseBroadcast(buf(LIVE_87_30))).toBeNull();
      expect(adapter.parseBroadcast(buf(LIVE_84_20))).toBeNull();
      expect(adapter.parseLiveBroadcast(buf(LIVE_87_30))?.weight).toBeCloseTo(87.3, 2);
      expect(adapter.parseLiveBroadcast(buf(LIVE_84_20))?.weight).toBeCloseTo(84.2, 2);
    });

    it('reads the finished ble_monitor frame as 67.25 kg with no impedance', () => {
      const adapter = new SenssunIfB7Adapter();
      const reading = adapter.parseBroadcast(buf(FINISHED_67_25));
      expect(reading).toEqual({ weight: 67.25, impedance: 0 });
      expect(adapter.parseLiveBroadcast(buf(FINISHED_67_25))).toBeNull();
    });

    it('reads the #423 kg weigh-in: live while weighing, 88.10 kg once finished', () => {
      const adapter = new SenssunIfB7Adapter();
      expect(adapter.parseBroadcast(buf(KG_WEIGHING_88_10))).toBeNull();
      expect(adapter.parseLiveBroadcast(buf(KG_WEIGHING_88_10))).toEqual({ weight: 88.1 });
      expect(adapter.parseBroadcast(buf(KG_FINISHED_FIRST))).toEqual({
        weight: 88.1,
        impedance: 0,
      });
    });

    it('does not publish [12..13] of the #423 unit either (137 on this frame)', () => {
      const adapter = new SenssunIfB7Adapter();
      expect(adapter.parseBroadcast(buf(KG_FINISHED_137))).toEqual({
        weight: 88.1,
        impedance: 0,
      });
    });

    it('reads [10..11] as kg with the display in lb, on both channels, without a warning', () => {
      const adapter = new SenssunIfB7Adapter();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      expect(adapter.parseBroadcast(buf(LB_WEIGHING_87_60))).toBeNull();
      expect(adapter.parseLiveBroadcast(buf(LB_WEIGHING_87_60))).toEqual({ weight: 87.6 });
      expect(adapter.parseBroadcast(buf(LB_FINISHED_FIRST))).toEqual({
        weight: 87.6,
        impedance: 0,
      });
      expect(adapter.parseBroadcast(buf(LB_FINISHED_202))).toEqual({
        weight: 87.6,
        impedance: 0,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('logs [12..13] of the finished frame at debug level instead of publishing it', () => {
      const adapter = new SenssunIfB7Adapter();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const reading = adapter.parseBroadcast(buf(FINISHED_67_25));
      expect(reading?.impedance).toBe(0);
      expect(debug.mock.calls.some(([m]) => String(m).includes('[12..13]=180'))).toBe(true);
    });

    it('logs a finished frame once, not once per re-read of the same advertisement', () => {
      const adapter = new SenssunIfB7Adapter();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      adapter.parseBroadcast(buf(FINISHED_67_25));
      adapter.parseBroadcast(buf(FINISHED_67_25));
      adapter.parseBroadcast(buf(FINISHED_67_25));
      expect(debug).toHaveBeenCalledTimes(1);
    });

    it('logs the finished state once per payload, not once per advert', () => {
      const adapter = new SenssunIfB7Adapter();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const finished = () => debug.mock.calls.filter(([m]) => String(m).includes('finished'));
      // Two consecutive adverts that differ only in the counter at [15].
      adapter.parseBroadcast(buf(KG_FINISHED_FIRST));
      adapter.parseBroadcast(buf(KG_FINISHED_SECOND));
      expect(finished()).toHaveLength(1);
      // [12..13] turning non-zero is new information.
      adapter.parseBroadcast(buf(KG_FINISHED_137));
      expect(finished()).toHaveLength(2);
      expect(String(finished()[1][0])).toContain('[12..13]=137');
    });

    it('logs the finished state of a second weigh-in that ends on the same payload', () => {
      const adapter = new SenssunIfB7Adapter();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const finished = () => debug.mock.calls.filter(([m]) => String(m).includes('finished'));
      adapter.parseBroadcast(buf(KG_FINISHED_FIRST));
      // A weighing frame in between starts a new weigh-in.
      adapter.parseBroadcast(buf(KG_WEIGHING_88_10));
      adapter.parseBroadcast(buf(KG_FINISHED_SECOND));
      expect(finished()).toHaveLength(2);
    });

    it('logs the finished frame of every poll scan, even on the payload of the scan before', () => {
      // A poll transport stops at the first finished frame and reads again only
      // after scan_cooldown (5 s at the least), seeing no weighing frame in
      // between if the finished state outlived the cooldown.
      let t = 0;
      const adapter = new SenssunIfB7Adapter(() => t);
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const finished = () => debug.mock.calls.filter(([m]) => String(m).includes('finished'));
      // A watcher first: ten seconds of the same payload, one advert every
      // 400 ms (about the longest gap in the #423 capture), is one line.
      for (let i = 0; i < 25; i++) {
        adapter.parseBroadcast(buf(i % 2 === 0 ? KG_FINISHED_FIRST : KG_FINISHED_SECOND));
        t += 400;
      }
      expect(finished()).toHaveLength(1);
      t += 5_000;
      adapter.parseBroadcast(buf(KG_FINISHED_FIRST));
      expect(finished()).toHaveLength(2);
    });

    it('logs an unseen state again after the same expiry (derived: [14] 0xA1 -> 0xE1)', () => {
      let t = 0;
      const adapter = new SenssunIfB7Adapter(() => t);
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const unknown = derived(KG_FINISHED_FIRST, 14, 0xe1);
      adapter.parseBroadcast(unknown);
      t += 5_000;
      adapter.parseBroadcast(unknown);
      expect(
        debug.mock.calls.filter(([m]) => String(m).includes('not a known state')),
      ).toHaveLength(2);
    });

    it('logs a weighing value once, and again only when it changes', () => {
      const adapter = new SenssunIfB7Adapter();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      adapter.parseBroadcast(buf(LIVE_87_30));
      adapter.parseBroadcast(buf(LIVE_87_30));
      expect(debug).toHaveBeenCalledTimes(1);
      adapter.parseBroadcast(buf(LIVE_84_20));
      expect(debug).toHaveBeenCalledTimes(2);
    });

    it('refuses a frame with a broken checksum on both channels ([16] 0x61 -> 0x60)', () => {
      const adapter = new SenssunIfB7Adapter();
      const broken = withByte(FINISHED_67_25, 16, 0x60);
      expect(adapter.parseBroadcast(broken)).toBeNull();
      expect(adapter.parseLiveBroadcast(broken)).toBeNull();
    });

    it('refuses an unknown display unit on both channels and warns once (derived: [14] 0xA2 -> 0xA3)', () => {
      const adapter = new SenssunIfB7Adapter();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const unknownUnit = derived(LB_FINISHED_FIRST, 14, 0xa3);
      expect(adapter.parseBroadcast(unknownUnit)).toBeNull();
      expect(adapter.parseBroadcast(unknownUnit)).toBeNull();
      expect(adapter.parseLiveBroadcast(unknownUnit)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain('0x3');
      expect(message).toContain('Only kg and lb are decoded');
    });

    it('logs an unseen state once, so a timeout on such a unit is explainable', () => {
      const adapter = new SenssunIfB7Adapter();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const unknown = derived(FINISHED_67_25, 14, 0xe1);
      adapter.parseBroadcast(unknown);
      adapter.parseBroadcast(unknown);
      const lines = () => debug.mock.calls.filter(([m]) => String(m).includes('not a known state'));
      expect(lines()).toHaveLength(1);
      // Derived: [14] 0xA1 -> 0xE1 on two adverts that differ only in [15], one
      // payload.
      adapter.parseBroadcast(derived(KG_FINISHED_FIRST, 14, 0xe1));
      adapter.parseBroadcast(derived(KG_FINISHED_SECOND, 14, 0xe1));
      expect(lines()).toHaveLength(2);
      debug.mockRestore();
    });

    it('refuses a live weight above the plausible range (derived: [10] 0x22 -> 0x7a)', () => {
      const adapter = new SenssunIfB7Adapter();
      expect(adapter.parseLiveBroadcast(derived(LIVE_87_30, 10, 0x7a))).toBeNull();
    });

    it('treats an unseen state as neither finished nor live (derived: [14] 0xA1 -> 0xE1)', () => {
      const adapter = new SenssunIfB7Adapter();
      const unknown = derived(FINISHED_67_25, 14, 0xe1);
      expect(adapter.parseBroadcast(unknown)).toBeNull();
      expect(adapter.parseLiveBroadcast(unknown)).toBeNull();
    });

    it('refuses an out-of-range finished weight (derived: [10] 0x1a -> 0x00, 0.69 kg)', () => {
      const adapter = new SenssunIfB7Adapter();
      expect(adapter.parseBroadcast(derived(FINISHED_67_25, 10, 0x00))).toBeNull();
    });
  });

  describe('advertisement decision', () => {
    it('completes on the finished frame', () => {
      const adapter = new SenssunIfB7Adapter();
      const decision = evaluateAdvertisement(adapter, advert(FINISHED_67_25, MAC_BLE_MONITOR));
      expect(decision).toEqual({ kind: 'complete', reading: { weight: 67.25, impedance: 0 } });
    });

    it('completes on the #423 finished frame with the display in lb', () => {
      const adapter = new SenssunIfB7Adapter();
      const decision = evaluateAdvertisement(adapter, advert(LB_FINISHED_FIRST));
      expect(decision).toEqual({ kind: 'complete', reading: { weight: 87.6, impedance: 0 } });
    });

    it('waits on a weighing frame and carries its live weight', () => {
      const adapter = new SenssunIfB7Adapter();
      const decision = evaluateAdvertisement(adapter, advert(LIVE_87_30));
      expect(decision.kind).toBe('wait');
      expect(decision.kind === 'wait' && decision.live?.weight).toBeCloseTo(87.3, 2);
    });
  });

  describe('completion and body composition', () => {
    const adapter = new SenssunIfB7Adapter();

    it('completes only inside the plausible range', () => {
      expect(adapter.isComplete({ weight: 67.25, impedance: 0 })).toBe(true);
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
      expect(adapter.isComplete({ weight: 400, impedance: 0 })).toBe(false);
    });

    it('estimates composition from BMI, ignoring any impedance on the reading', () => {
      const profile = defaultProfile();
      expect(adapter.computeMetrics({ weight: 67.25, impedance: 180 }, profile)).toEqual(
        buildPayload(67.25, 0, {}, profile),
      );
    });
  });
});
