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
 * The three real frames, manufacturer data with the company id stripped as
 * every transport delivers it. Nothing here is built from our own reading of
 * the format; the only altered frames below are single-byte changes to these,
 * and each says which byte.
 */

/** #423, unit 64:FB:01:2D:92:50, taken while weighing (status 0x01): 87.30 kg. */
const LIVE_87_30 = '02031164fb012d925001221a00000190ce';
/** #423, same unit, while weighing: 84.20 kg (the display settled on 84.3). */
const LIVE_84_20 = '02031164fb012d92500120e40000011c22';
const MAC_423 = '64:FB:01:2D:92:50';

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

    it('refuses an lb frame on both channels and warns once (derived: [14] 0xA1 -> 0xA2)', () => {
      const adapter = new SenssunIfB7Adapter();
      const warn = vi.spyOn(bleLog, 'warn').mockImplementation(() => {});
      const lbFinished = derived(FINISHED_67_25, 14, 0xa2);
      const lbLive = derived(LIVE_87_30, 14, 0x02);
      expect(adapter.parseBroadcast(lbFinished)).toBeNull();
      expect(adapter.parseBroadcast(lbFinished)).toBeNull();
      expect(adapter.parseLiveBroadcast(lbLive)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('lb');
    });

    it('logs an unseen state once, so a timeout on such a unit is explainable', () => {
      const adapter = new SenssunIfB7Adapter();
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      const unknown = derived(FINISHED_67_25, 14, 0xe1);
      adapter.parseBroadcast(unknown);
      adapter.parseBroadcast(unknown);
      const lines = debug.mock.calls.filter(([m]) => String(m).includes('not a known state'));
      expect(lines).toHaveLength(1);
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
