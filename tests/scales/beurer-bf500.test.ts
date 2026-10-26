import { describe, it, expect, vi } from 'vitest';
import { BeurerBf500Adapter } from '../../src/scales/beurer-bf500.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import { mockPeripheral, defaultProfile } from '../helpers/scale-test-utils.js';

const CHR_WEIGHT = uuid16(0x2a9d);
const CHR_BODYCOMP = uuid16(0x2a9c);
const CHR_UCP = uuid16(0x2a9f);
const CHR_TIME = uuid16(0x2a2b);
const CHR_DOB = uuid16(0x2a85);
const CHR_GENDER = uuid16(0x2a8c);
const CHR_HEIGHT = uuid16(0x2a8e);
const CHR_INCREMENT = uuid16(0x2a99);
const CHR_USER_LIST = uuid16(0xfff1);
const CHR_ACTIVITY = uuid16(0xfff2);
const CHR_TRIGGER = uuid16(0xfff4);

const ALL_CHARS = [
  CHR_WEIGHT,
  CHR_BODYCOMP,
  CHR_UCP,
  CHR_TIME,
  CHR_DOB,
  CHR_GENDER,
  CHR_HEIGHT,
  CHR_INCREMENT,
  CHR_USER_LIST,
  CHR_ACTIVITY,
  CHR_TRIGGER,
];

function makeCtx(over: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    profile: defaultProfile(),
    deviceAddress: 'D80BCB5F90F1',
    availableChars: new Set(ALL_CHARS),
    scaleAuth: { pin: 1234, userIndex: 1 },
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    subscribe: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as ConnectionContext;
}

const writesTo = (ctx: ConnectionContext, uuid: string) =>
  (ctx.write as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === uuid);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('BeurerBf500Adapter', () => {
  it('requires bonding', () => {
    expect(new BeurerBf500Adapter().requiresBonding).toBe(true);
  });

  describe('matching', () => {
    it('matches only by the BF500 name', () => {
      const a = new BeurerBf500Adapter();
      expect(a.matches(mockPeripheral('BF500'))).toBe(true);
      expect(a.matches(mockPeripheral('Beurer BF500'))).toBe(true);
      expect(a.matches(mockPeripheral('BF720'))).toBe(false);
      expect(a.matches({ localName: '', serviceUuids: ['181d'] })).toBe(false);
    });

    it('wins over the BF720 adapter for the name "BF500"', () => {
      const info = { localName: 'BF500', serviceUuids: ['181d', '181b'] };
      expect(resolveAdapter(info)?.name).toBe('Beurer BF500');
    });
  });

  describe('onConnected()', () => {
    it('queries the user list on 0xFFF1 and never touches the activity char 0xFFF2', async () => {
      const ctx = makeCtx();
      await new BeurerBf500Adapter().onConnected(ctx);
      expect(writesTo(ctx, CHR_USER_LIST)).toHaveLength(1);
      expect(writesTo(ctx, CHR_ACTIVITY)).toHaveLength(0);
    });

    it('sends consent for the configured slot and PIN (little-endian)', async () => {
      const ctx = makeCtx({ scaleAuth: { pin: 0x09d8, userIndex: 2 } });
      await new BeurerBf500Adapter().onConnected(ctx);
      expect(writesTo(ctx, CHR_UCP)[0][1]).toEqual([0x02, 0x02, 0xd8, 0x09]);
    });

    it('throws a helpful error without a PIN', async () => {
      const ctx = makeCtx({ scaleAuth: undefined });
      await expect(new BeurerBf500Adapter().onConnected(ctx)).rejects.toThrow(/beurer_pin/);
    });

    it('registers instead of consenting when beurer_register_new_user is set', async () => {
      const ctx = makeCtx({ scaleAuth: { pin: 0x1234, registerNewUser: true } });
      await new BeurerBf500Adapter().onConnected(ctx);
      expect(writesTo(ctx, CHR_UCP).map((c) => c[1])).toEqual([[0x01, 0x34, 0x12]]);
    });
  });

  describe('consent flow', () => {
    it('triggers a measurement on 0xFFF4 after an accepted consent, without rewriting the profile', async () => {
      const a = new BeurerBf500Adapter();
      const ctx = makeCtx();
      await a.onConnected(ctx);
      a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x02, 0x01]));
      await flush();
      expect(writesTo(ctx, CHR_TRIGGER)[0][1]).toEqual([0x00]);
      expect(writesTo(ctx, CHR_DOB)).toHaveLength(0);
    });

    it('does not trigger when the consent is refused', async () => {
      const a = new BeurerBf500Adapter();
      const ctx = makeCtx();
      await a.onConnected(ctx);
      a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x02, 0x04]));
      await flush();
      expect(writesTo(ctx, CHR_TRIGGER)).toHaveLength(0);
    });

    it('after registering: consents to the assigned slot, writes the profile, then triggers', async () => {
      const a = new BeurerBf500Adapter();
      const ctx = makeCtx({ scaleAuth: { pin: 0x1234, registerNewUser: true } });
      await a.onConnected(ctx);
      a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x01, 0x01, 0x03]));
      await flush();
      expect(writesTo(ctx, CHR_UCP)[1][1]).toEqual([0x02, 0x03, 0x34, 0x12]);
      expect(writesTo(ctx, CHR_TRIGGER)).toHaveLength(0);

      a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x02, 0x01]));
      await flush();
      for (const chr of [CHR_DOB, CHR_GENDER, CHR_HEIGHT, CHR_INCREMENT, CHR_ACTIVITY]) {
        expect(writesTo(ctx, chr)).toHaveLength(1);
      }
      expect(writesTo(ctx, CHR_ACTIVITY)[0][1]).toEqual([0x03]);
      expect(writesTo(ctx, CHR_TRIGGER)).toHaveLength(1);
    });

    it('falls back to write-without-response for the trigger', async () => {
      const a = new BeurerBf500Adapter();
      const write = vi
        .fn()
        .mockImplementation(async (uuid: string, _d: unknown, resp?: boolean) => {
          if (uuid === CHR_TRIGGER && resp) throw new Error('not permitted');
        });
      const ctx = makeCtx({ write });
      await a.onConnected(ctx);
      a.parseCharNotification(CHR_UCP, Buffer.from([0x20, 0x02, 0x01]));
      await flush();
      expect(writesTo(ctx, CHR_TRIGGER).map((c) => c[2])).toEqual([true, false]);
    });
  });

  describe('measurement parsing', () => {
    // Frames decoded from the #168 openScale HCI snoop (same SIG formats as the BF720).
    const WSS = Buffer.from('0e783eea07050c12353601ee002607', 'hex');
    const BCS = Buffer.from('9803c200df1a9701cc2fca21a811', 'hex');

    it('emits a reading once weight and body composition both arrived', () => {
      const a = new BeurerBf500Adapter();
      expect(a.parseCharNotification(CHR_WEIGHT, WSS)).toBeNull();
      const r = a.parseCharNotification(CHR_BODYCOMP, BCS);
      expect(r?.weight).toBeCloseTo(79.96, 1);
    });
  });
});
