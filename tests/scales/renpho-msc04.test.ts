import { describe, it, expect, vi } from 'vitest';
import { RenphoMsc04Adapter } from '../../src/scales/renpho-msc04.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

const LIVE = Buffer.from('55aa210005010000255da8', 'hex'); // cmd 0x21 -> 95.65
const FINAL = Buffer.from('55aa240006011100002553b3', 'hex'); // cmd 0x24 -> 95.55
const START = [0x55, 0xaa, 0x90, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x94];

function makeAdapter() {
  return new RenphoMsc04Adapter();
}

describe('RenphoMsc04Adapter', () => {
  describe('matches() and registry resolution (#117/#265)', () => {
    it('matches the exact "R-MSC04" name (case-insensitive)', () => {
      expect(makeAdapter().matches(mockPeripheral('R-MSC04'))).toBe(true);
      expect(makeAdapter().matches(mockPeripheral('r-msc04'))).toBe(true);
    });

    it('does not match ES-CS20M or unrelated names', () => {
      expect(makeAdapter().matches(mockPeripheral('es-cs20m'))).toBe(false);
      expect(makeAdapter().matches(mockPeripheral('Random Scale'))).toBe(false);
    });

    it('resolves a named R-MSC04 to this adapter, not ES-CS20M (priority 235 > 130)', () => {
      // A real R-MSC04 advertises service 0x1A10, which ES-CS20M also claims.
      const info = mockPeripheral('R-MSC04', [uuid16(0x1a10)]);
      expect(resolveAdapter(info)?.name).toBe('Renpho R-MSC04');
      // Array-order first match (what registry-collision.test asserts) also wins.
      expect(adapters.filter((a) => a.matches(info))[0]?.name).toBe('Renpho R-MSC04');
    });

    it('does NOT claim a nameless 0x1A10 device (leaves it to ES-CS20M)', () => {
      const info = mockPeripheral('', [uuid16(0x1a10)]);
      expect(makeAdapter().matches(info)).toBe(false);
      expect(resolveAdapter(info)?.name).toBe('ES-CS20M');
    });
  });

  describe('onConnected() start command', () => {
    it('writes the 55AA start command to 0x2A11 without response', async () => {
      const writes: Array<{ uuid: string; data: number[] | Buffer; withResponse?: boolean }> = [];
      const ctx = {
        profile: defaultProfile(),
        deviceAddress: 'AA',
        availableChars: new Set<string>([uuid16(0x2a11)]),
        write: vi.fn(async (uuid: string, data: number[] | Buffer, withResponse?: boolean) => {
          writes.push({ uuid, data, withResponse });
        }),
        read: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as ConnectionContext;

      await makeAdapter().onConnected(ctx);

      expect(writes).toHaveLength(1);
      expect(writes[0].uuid).toBe(uuid16(0x2a11));
      expect([...(writes[0].data as number[])]).toEqual(START);
      expect(writes[0].withResponse).toBe(false);
    });

    it('throws a clear error when the write char was not discovered', async () => {
      const ctx = {
        profile: defaultProfile(),
        deviceAddress: 'AA',
        availableChars: new Set<string>(),
        write: vi.fn(),
        read: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as ConnectionContext;
      await expect(makeAdapter().onConnected(ctx)).rejects.toThrow(/not discovered/);
    });

    it('resets finalReceived on reconnect (shared singleton)', async () => {
      const adapter = makeAdapter();
      adapter.parseCharNotification(uuid16(0x2a12), FINAL);
      expect(adapter.isComplete({ weight: 95.55, impedance: 0 })).toBe(true);
      const ctx = {
        profile: defaultProfile(),
        deviceAddress: 'AA',
        availableChars: new Set<string>([uuid16(0x2a11)]),
        write: vi.fn(),
        read: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as ConnectionContext;
      // Handler order: onSessionStart before anything is subscribed, then
      // onConnected once the init sequence runs (src/ble/shared.ts).
      adapter.onSessionStart();
      await adapter.onConnected(ctx);
      expect(adapter.isComplete({ weight: 95.55, impedance: 0 })).toBe(false);
    });
  });

  describe('parseCharNotification() framing + weight', () => {
    it('parses a cmd 0x21 live frame -> 95.65 kg (progress, not complete)', () => {
      const adapter = makeAdapter();
      const r = adapter.parseCharNotification(uuid16(0x2a10), LIVE);
      expect(r).not.toBeNull();
      expect(r!.weight).toBeCloseTo(95.65, 2);
      expect(r!.impedance).toBe(0);
      expect(adapter.isComplete(r!)).toBe(false);
    });

    it('parses a cmd 0x24 final frame -> 95.55 kg and completes the reading', () => {
      const adapter = makeAdapter();
      const r = adapter.parseCharNotification(uuid16(0x2a12), FINAL);
      expect(r).not.toBeNull();
      expect(r!.weight).toBeCloseTo(95.55, 2);
      expect(r!.impedance).toBe(0);
      expect(adapter.isComplete(r!)).toBe(true);
    });

    it('rejects a frame with a bad checksum (no final latched)', () => {
      const adapter = makeAdapter();
      const bad = Buffer.from('55aa240006011100002553b4', 'hex'); // b4 != b3
      expect(adapter.parseCharNotification(uuid16(0x2a12), bad)).toBeNull();
      expect(adapter.isComplete({ weight: 95.55, impedance: 0 })).toBe(false);
    });

    it('rejects a frame without the 55AA header', () => {
      const adapter = makeAdapter();
      const bad = Buffer.from('56aa240006011100002553b4', 'hex');
      expect(adapter.parseCharNotification(uuid16(0x2a10), bad)).toBeNull();
    });

    it('rejects a truncated frame (declared length exceeds buffer)', () => {
      const adapter = makeAdapter();
      const t = Buffer.from('55aa24000601', 'hex'); // len says 6, only 1 payload byte present
      expect(adapter.parseCharNotification(uuid16(0x2a10), t)).toBeNull();
    });

    it('ignores an out-of-scope command with a valid checksum (e.g. 0x26)', () => {
      const adapter = makeAdapter();
      const body = Buffer.from('55aa26000212346d', 'hex'); // cmd 0x26, checksum ok
      expect(adapter.parseCharNotification(uuid16(0x2a10), body)).toBeNull();
      expect(adapter.isComplete({ weight: 95.55, impedance: 0 })).toBe(false);
    });

    it('legacy parseNotification() decodes the same frame', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(LIVE)!.weight).toBeCloseTo(95.65, 2);
    });
  });

  describe('isComplete() gating', () => {
    it('is false after only live frames, true after the final frame', () => {
      const adapter = makeAdapter();
      adapter.parseCharNotification(uuid16(0x2a10), LIVE);
      expect(adapter.isComplete({ weight: 95.65, impedance: 0 })).toBe(false);
      adapter.parseCharNotification(uuid16(0x2a12), FINAL);
      expect(adapter.isComplete({ weight: 95.55, impedance: 0 })).toBe(true);
    });

    it('is false when weight is 0 even after the final frame', () => {
      const adapter = makeAdapter();
      adapter.parseCharNotification(uuid16(0x2a12), FINAL);
      expect(adapter.isComplete({ weight: 0, impedance: 0 })).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('returns a weight-only payload (impedance 0) that passes range checks', () => {
      const payload = makeAdapter().computeMetrics(
        { weight: 95.55, impedance: 0 },
        defaultProfile(),
      );
      expect(payload.weight).toBeCloseTo(95.55, 2);
      expect(payload.impedance).toBe(0);
      assertPayloadRanges(payload);
    });
  });
});
