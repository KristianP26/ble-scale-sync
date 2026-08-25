import { describe, it, expect, vi } from 'vitest';
import { HutbitAdapter } from '../../src/scales/hutbit.js';
import { isHutbitOemAdvert } from '../../src/scales/lefu-signature.js';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo, ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  expectMatches,
  parseOk,
  expectValidMetrics,
} from '../helpers/scale-test-utils.js';

function makeAdapter() {
  return new HutbitAdapter();
}

describe('HutbitAdapter (#254)', () => {
  describe('matches() and registry resolution', () => {
    it('matches the advertised "Hutbit Scale" name (case-insensitive)', () => {
      expectMatches(makeAdapter(), {
        yes: ['Hutbit Scale', 'hutbit scale', 'HUTBIT'],
        no: ['Robi S9', 'icomon', 'swan123', 'QN-Scale', ''],
      });
    });

    it('resolves "Hutbit Scale" to the Hutbit adapter, not MGB/Robi', () => {
      const matched = adapters.find((a) => a.matches(mockPeripheral('Hutbit Scale', ['ffb0'])));
      expect(matched?.name).toBe('Hutbit');
    });

    it('does not claim a nameless FFB0 device (left to Robi/MGB)', () => {
      const info = mockPeripheral('', [uuid16(0xffb0)], undefined, [
        uuid16(0xffb1),
        uuid16(0xffb2),
      ]);
      expect(makeAdapter().matches(info)).toBe(false);
    });
  });

  describe('OEM/rebranded advertisement (SWAN, #278)', () => {
    // Real capture: Lefu OEM stock branding. Manufacturer data 0x02AC carries
    // the device's MAC reversed (03:B3:EC:93:B8:7E) + status byte (01 = active).
    // Over the ESPHome proxy the local name arrives empty.
    function swanAdvert(name = 'SWAN', charUuids?: string[]): BleDeviceInfo {
      return {
        localName: name,
        serviceUuids: [uuid16(0xd618), uuid16(0xffb0)],
        manufacturerData: { id: 0x02ac, data: Buffer.from('7eb893ecb30301', 'hex') },
        ...(charUuids ? { characteristicUuids: charUuids } : {}),
      };
    }

    it('claims the SWAN-branded advert via the 0x02AC manufacturer signature', () => {
      expect(makeAdapter().matches(swanAdvert())).toBe(true);
      expect(isHutbitOemAdvert(swanAdvert())).toBe(true);
    });

    it('claims the same advert with an empty name (ESPHome proxy transport)', () => {
      expect(makeAdapter().matches(swanAdvert(''))).toBe(true);
    });

    it('accepts the idle-status variant (payload ends 0x00)', () => {
      const idle = swanAdvert();
      idle.manufacturerData = { id: 0x02ac, data: Buffer.from('7eb893ecb30300', 'hex') };
      expect(makeAdapter().matches(idle)).toBe(true);
    });

    // #318: a second SWAN unit advertises the same MAC-reversed payload with no
    // status byte at all. Requiring 7 bytes sent it to MGB, whose parser rejects
    // every AC02 frame this family sends, so the measurement never completed.
    it('accepts the six-byte MAC-only payload (#318)', () => {
      const sixByte = swanAdvert('SWAN');
      sixByte.manufacturerData = { id: 0x02ac, data: Buffer.from('12a291ecb303', 'hex') };
      expect(isHutbitOemAdvert(sixByte)).toBe(true);
      expect(makeAdapter().matches(sixByte)).toBe(true);
      expect(resolveAdapter(sixByte, adapters)?.name).toBe('Hutbit');
    });

    it('claims a named six-byte payload advertising FFB0 without D618', () => {
      const noD618 = swanAdvert('SWAN');
      noD618.serviceUuids = [uuid16(0xffb0)];
      noD618.manufacturerData = { id: 0x02ac, data: Buffer.from('12a291ecb303', 'hex') };
      expect(isHutbitOemAdvert(noD618)).toBe(true);
    });

    // #322: a Juniper-branded unit running the same Lefu AC02 protocol
    // advertises FFB0 alone. Its traffic is genuine AC02 (stable weight
    // 103.0 kg, then 521 ohm on FD01, both checksum-valid), but D618 sent it to
    // MGB, whose parser rejects every frame it sends, so every cycle ended in a
    // GATT reading timeout. Byte-for-byte the advert the reporter logged.
    it('claims the Juniper FFB0-only advert and keeps it away from MGB (#322)', () => {
      const juniper: BleDeviceInfo = {
        localName: 'SWAN',
        serviceUuids: [uuid16(0xffb0)],
        manufacturerData: { id: 0x02ac, data: Buffer.from('c3b4d5ecb60100', 'hex') },
      };
      expect(isHutbitOemAdvert(juniper)).toBe(true);
      expect(makeAdapter().matches(juniper)).toBe(true);
      expect(resolveAdapter(juniper, adapters)?.name).toBe('Hutbit');
    });

    // The same advert with the name stripped, as a proxy transport delivers it.
    // This one must NOT flip: nameless FFB0 belongs to the Robi S9.
    it('leaves the nameless form of that advert alone (#322, #248)', () => {
      const nameless: BleDeviceInfo = {
        localName: '',
        serviceUuids: [uuid16(0xffb0)],
        manufacturerData: { id: 0x02ac, data: Buffer.from('c3b4d5ecb60100', 'hex') },
      };
      expect(isHutbitOemAdvert(nameless)).toBe(false);
    });

    it('rejects 0x02AC data that does not fit the signature shape', () => {
      const tooShort = swanAdvert('');
      tooShort.manufacturerData = { id: 0x02ac, data: Buffer.from('93ecb303', 'hex') };
      expect(makeAdapter().matches(tooShort)).toBe(false);

      const wrongStatus = swanAdvert('');
      wrongStatus.manufacturerData = { id: 0x02ac, data: Buffer.from('7eb893ecb303ff', 'hex') };
      expect(makeAdapter().matches(wrongStatus)).toBe(false);
    });

    it('registry resolves the SWAN broadcast to Hutbit, not MGB', () => {
      expect(resolveAdapter(swanAdvert(), adapters)?.name).toBe('Hutbit');
      expect(resolveAdapter(swanAdvert(''), adapters)?.name).toBe('Hutbit');
    });

    it('post-discovery re-resolution stays on Hutbit — Robi S9 must not steal FFB3 (#278)', () => {
      // Mirrors the esphome-proxy watcher: after GATT discovery the device info
      // gains characteristicUuids (the Hutbit exposes an unused FFB3) and has no
      // usable name. Without the Robi-side signature guard, Robi S9 (prio 40)
      // would claim this and replay a handshake the Hutbit rejects.
      const postDiscovery = swanAdvert('', [uuid16(0xffb1), uuid16(0xffb2), uuid16(0xffb3)]);
      expect(resolveAdapter(postDiscovery, adapters)?.name).toBe('Hutbit');
    });

    it('does not shadow the Robi S9: nameless FFB0+FFB3 without the signature still resolves to Robi', () => {
      const robiLike: BleDeviceInfo = {
        localName: '',
        serviceUuids: [uuid16(0xffb0)],
        characteristicUuids: [uuid16(0xffb1), uuid16(0xffb2), uuid16(0xffb3)],
      };
      expect(resolveAdapter(robiLike, adapters)?.name).toBe('Robi S9');
    });

    // 0x02AC is SIG-assigned to RTB Elektronik and the Lefu firmware squats on
    // it, so the shape alone is too weak to claim a NAMELESS device: that space
    // is the Robi S9's. A named advert has already passed every name branch in
    // the family (Robi bows out of swan/icomon/yg and claims robi before it
    // consults this predicate), so there D618 is no longer required (#322).
    it('drops the d618 requirement only for named adverts', () => {
      const named = swanAdvert();
      named.serviceUuids = [uuid16(0xffb0)];
      expect(makeAdapter().matches(named)).toBe(true);
      expect(isHutbitOemAdvert(named)).toBe(true);

      const nameless = swanAdvert('');
      nameless.serviceUuids = [uuid16(0xffb0)];
      expect(makeAdapter().matches(nameless)).toBe(false);
      expect(isHutbitOemAdvert(nameless)).toBe(false);
    });

    // Guards the symmetry between HutbitAdapter.matches() and the RobiS9
    // bow-out. If Robi ever bows out of a WIDER set than Hutbit claims, this
    // device is rejected by Robi, unclaimed by Hutbit, and swept up by MGB on
    // the bare ffb0 descriptor claim, whose parser rejects every frame this
    // family sends. Today it resolves to Robi and it must stay that way.
    it('a nameless FFB0+FFB3 unit carrying the 0x02AC shape but no d618 still resolves to Robi', () => {
      const robiLikeWithMfg: BleDeviceInfo = {
        localName: '',
        serviceUuids: [uuid16(0xffb0)],
        characteristicUuids: [uuid16(0xffb1), uuid16(0xffb2), uuid16(0xffb3)],
        manufacturerData: { id: 0x02ac, data: Buffer.from('7eb893ecb30301', 'hex') },
      };
      expect(resolveAdapter(robiLikeWithMfg, adapters)?.name).toBe('Robi S9');
    });

    // The noble target-MAC path builds its device record from GATT-discovered
    // services, where d618 (an advertised 16-bit UUID, AD type 0x03) need not
    // appear at all. The handler therefore unions the advertised UUIDs in; this
    // pins the resulting shape, since without the union the signature check
    // could never fire there and the unit fell through to MGB, whose parser
    // rejects every frame this family sends.
    it('claims a target-MAC record whose advertised d618 is unioned with GATT services', () => {
      const targetMac: BleDeviceInfo = {
        localName: 'SWAN',
        // d618 from the advertisement, ffb0 from both, plus GATT-only services.
        serviceUuids: [uuid16(0xd618), uuid16(0xffb0), uuid16(0x1800), uuid16(0x180a)],
        characteristicUuids: [uuid16(0xffb1), uuid16(0xffb2), uuid16(0xffb3)],
        manufacturerData: { id: 0x02ac, data: Buffer.from('7eb893ecb30301', 'hex') },
      };
      expect(resolveAdapter(targetMac, adapters)?.name).toBe('Hutbit');
    });

    // The Robi guard sits AFTER the robi-name check on purpose, so a correctly
    // named Robi is never stolen even if it carries the full fingerprint.
    it('a named Robi S9 carrying the full OEM fingerprint still resolves to Robi', () => {
      const namedRobi = swanAdvert('Robi S9', [uuid16(0xffb1), uuid16(0xffb2), uuid16(0xffb3)]);
      expect(resolveAdapter(namedRobi, adapters)?.name).toBe('Robi S9');
    });
  });

  describe('onConnected() handshake', () => {
    it('replays the captured 8-byte FFB1 handshake in order', async () => {
      const writes: Buffer[] = [];
      const ctx = {
        profile: defaultProfile(),
        deviceAddress: 'AA',
        availableChars: new Set<string>(),
        write: vi.fn(async (_uuid: string, data: number[] | Buffer) => {
          writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        }),
        read: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as ConnectionContext;

      await makeAdapter().onConnected(ctx);

      expect(writes).toHaveLength(5);
      expect(writes[0].toString('hex')).toBe('ac02fa010000ccc7');
      expect(writes[4].toString('hex')).toBe('ac02fe060000ccd0');
      // Every handshake frame is a valid 8-byte AC02 frame with a good checksum.
      for (const w of writes) {
        expect(w).toHaveLength(8);
        expect(w[0]).toBe(0xac);
        expect(w[1]).toBe(0x02);
        expect((w[2] + w[3] + w[4] + w[5] + w[6]) & 0xff).toBe(w[7]);
      }
    });
  });

  describe('parseNotification()', () => {
    it('decodes 84.1 kg from the real stable FFB2 frame (#254)', () => {
      const adapter = makeAdapter();
      // ac02 0349 0000 ca 16 → 0x0349 = 841 → 84.1 kg, STATUS 0xCA (stable)
      const reading = parseOk(adapter, Buffer.from('ac0203490000ca16', 'hex'), {
        weight: 84.1,
        impedance: 0,
      });
      expect(adapter.isComplete(reading)).toBe(true);
    });

    it('ignores measuring (0xCE) frames as progress only', () => {
      // ac02 0348 0000 ce 19 → valid checksum, but STATUS 0xCE = unstable
      expect(makeAdapter().parseNotification(Buffer.from('ac0203480000ce19', 'hex'))).toBeNull();
    });

    it('rejects a frame with a bad checksum', () => {
      expect(makeAdapter().parseNotification(Buffer.from('ac0203490000ca00', 'hex'))).toBeNull();
    });

    it('rejects wrong header / wrong length frames', () => {
      const a = makeAdapter();
      expect(a.parseNotification(Buffer.from('bb0203490000ca16', 'hex'))).toBeNull();
      expect(a.parseNotification(Buffer.from('ac0203490000ca', 'hex'))).toBeNull();
    });
  });

  describe('raw impedance frame (#322)', () => {
    // The one frame posted with its raw bytes: AC 02 FD 01 02 06 CB D1,
    // 0x0206 = 518 ohm, and FD+01+02+06+CB = 0x1D1 -> D1, so it passes this
    // adapter's own checksum.
    const FD01_518 = Buffer.from('ac02fd010206cbd1', 'hex');
    const STABLE_841 = Buffer.from('ac0203490000ca16', 'hex');

    function weighed() {
      const adapter = makeAdapter();
      parseOk(adapter, STABLE_841, { weight: 84.1, impedance: 0 });
      return adapter;
    }

    it('pairs the impedance with the weight this session settled on', () => {
      const adapter = weighed();
      const reading = adapter.parseNotification(FD01_518);
      expect(reading).toEqual({ weight: 84.1, impedance: 518 });
      expect(adapter.isComplete(reading!)).toBe(true);
    });

    it('treats the weight-only frame as complete but not final, and the paired one as final', () => {
      const adapter = makeAdapter();
      const weightOnly = parseOk(adapter, STABLE_841);
      expect(adapter.isFinal(weightOnly)).toBe(false);
      expect(adapter.isFinal(adapter.parseNotification(FD01_518)!)).toBe(true);
    });

    it('does not mistake its own handshake frame for an impedance', () => {
      // ac02fde20101ccad is written by this adapter's handshake. It is 8 bytes,
      // has the AC02 header and passes the checksum, and on the opcode alone it
      // would decode as a plausible 257 ohm.
      const adapter = weighed();
      expect(adapter.parseNotification(Buffer.from('ac02fde20101ccad', 'hex'))).toBeNull();
    });

    it('ignores the FD 00 frames the scale repeats while it measures', () => {
      expect(weighed().parseNotification(Buffer.from('ac02fd000000cbc8', 'hex'))).toBeNull();
    });

    it('ignores the FD FF no-contact sentinel', () => {
      // A failed contact is not a measurement of zero; it must never reach BIA.
      expect(weighed().parseNotification(Buffer.from('ac02fdff0000cbc7', 'hex'))).toBeNull();
    });

    it('ignores an implausible value rather than feeding it to the estimator', () => {
      // 0x0BB8 = 3000 ohm, checksum valid.
      expect(weighed().parseNotification(Buffer.from('ac02fd010bb8cb8c', 'hex'))).toBeNull();
    });

    it('ignores an impedance that arrives before any stable weight', () => {
      expect(makeAdapter().parseNotification(FD01_518)).toBeNull();
    });

    it("never pairs an impedance with the previous session's weight", () => {
      // Adapters are shared singletons: a weigh-in that ends before its
      // impedance arrives must not lend its weight to the next connection.
      const adapter = weighed();
      adapter.onSessionEnd();
      expect(adapter.parseNotification(FD01_518)).toBeNull();
    });

    it('does not pair an impedance with a weight from minutes earlier', () => {
      // The adapter is a shared singleton holding one weight, so two units
      // weighing through the same proxy must not lend each other a body.
      vi.useFakeTimers();
      try {
        const adapter = weighed();
        vi.advanceTimersByTime(30_000);
        expect(adapter.parseNotification(FD01_518)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('holds the link open for the impedance rather than resolving on the weight', () => {
      expect(makeAdapter().completionHoldMs).toBeGreaterThan(0);
    });
  });

  describe('computeMetrics()', () => {
    it('runs BIA when the raw impedance is present', () => {
      const adapter = makeAdapter();
      parseOk(adapter, Buffer.from('ac0203490000ca16', 'hex'));
      const paired = adapter.parseNotification(Buffer.from('ac02fd010206cbd1', 'hex'))!;
      const payload = expectValidMetrics(adapter, paired);
      expect(payload.impedance).toBe(518);
      // The BMI-only estimate for the same body is a different number, so this
      // asserts the impedance actually reached the estimator.
      const bmiOnly = expectValidMetrics(adapter, { weight: 84.1, impedance: 0 });
      expect(payload.bodyFat).not.toBeCloseTo(bmiOnly.bodyFat!, 1);
    });

    it('derives a valid body-composition payload (weight-only → BIA/BMI)', () => {
      const adapter = makeAdapter();
      const reading = parseOk(adapter, Buffer.from('ac0203490000ca16', 'hex'));
      const payload = expectValidMetrics(adapter, reading);
      expect(payload.weight).toBeCloseTo(84.1, 2);
      expect(payload.impedance).toBe(0);
    });
  });
});
