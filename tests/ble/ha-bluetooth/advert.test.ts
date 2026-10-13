import { describe, it, expect, vi } from 'vitest';
import { toBleDeviceInfo } from '../../../src/ble/handler-ha-bluetooth/index.js';
import type { HaAdvertisement } from '../../../src/ble/handler-ha-bluetooth/index.js';

function ad(overrides: Partial<HaAdvertisement>): HaAdvertisement {
  return {
    name: '',
    address: 'AA:BB:CC:DD:EE:FF',
    rssi: -60,
    manufacturer_data: {},
    service_data: {},
    service_uuids: [],
    source: 'hci0',
    connectable: true,
    time: 0,
    ...overrides,
  };
}

describe('toBleDeviceInfo (Home Assistant advertisement)', () => {
  it('maps name, service UUIDs, manufacturer data and service data', () => {
    const info = toBleDeviceInfo(
      ad({
        name: 'MIBFS',
        service_uuids: ['0000181b-0000-1000-8000-00805f9b34fb'],
        manufacturer_data: { '343': '70879eede5e7' },
        service_data: {
          '0000181b-0000-1000-8000-00805f9b34fb': '0224e907081d0a1b21ee0a5432',
          '0000fe95-0000-1000-8000-00805f9b34fb': '1059d53b0a',
        },
      }),
    );
    expect(info.localName).toBe('MIBFS');
    expect(info.serviceUuids).toEqual(['0000181b00001000800000805f9b34fb']);
    expect(info.manufacturerData).toEqual({ id: 0x0157, data: Buffer.from('70879eede5e7', 'hex') });
    expect(info.serviceData).toEqual([
      {
        uuid: '0000181b00001000800000805f9b34fb',
        data: Buffer.from('0224e907081d0a1b21ee0a5432', 'hex'),
      },
      { uuid: '0000fe9500001000800000805f9b34fb', data: Buffer.from('1059d53b0a', 'hex') },
    ]);
  });

  it('treats a name equal to the address as no name', () => {
    expect(toBleDeviceInfo(ad({ name: 'aa:bb:cc:dd:ee:ff' })).localName).toBe('');
    expect(toBleDeviceInfo(ad({ name: 'Xiaomi Scale S400 B67E' })).localName).toBe(
      'Xiaomi Scale S400 B67E',
    );
  });

  it("treats BlueZ's generated alias (the address with dashes) as no name (B-17)", () => {
    // BlueZ answers Alias for a nameless device with its address, colons
    // replaced by dashes. Current bleak filters that out
    // (device_name_from_props), an older one handed it on as the name.
    expect(toBleDeviceInfo(ad({ name: 'AA-BB-CC-DD-EE-FF' })).localName).toBe('');
    expect(toBleDeviceInfo(ad({ name: 'aa-bb-cc-dd-ee-ff' })).localName).toBe('');
    // A different device's address is still a (strange) name, not this one's.
    expect(toBleDeviceInfo(ad({ name: '11-22-33-44-55-66' })).localName).toBe('11-22-33-44-55-66');
  });

  it('omits empty manufacturer and service data', () => {
    const info = toBleDeviceInfo(ad({ manufacturer_data: { '76': '' }, service_data: {} }));
    expect(info.manufacturerData).toBeUndefined();
    expect(info.serviceData).toBeUndefined();
  });

  it('tolerates missing optional collections', () => {
    const partial = { name: 'x', address: 'AA:BB:CC:DD:EE:FF' } as unknown as HaAdvertisement;
    // The address is always carried now: adapters that match on an advertisement
    // echoing its own MAC need it (#376).
    expect(toBleDeviceInfo(partial)).toEqual({
      localName: 'x',
      address: 'AA:BB:CC:DD:EE:FF',
      serviceUuids: [],
    });
  });
});

/*
 * Real advertisements replayed the way Home Assistant builds the dict it sends:
 * every packet is merged into the device's previous manufacturer_data
 * (`{**prev, **new}` in habluetooth), while `raw` is only the newest packet.
 * Each string is the whole advertising payload of one HCI record, byte for byte.
 */

/**
 * openScale #1177 attachment btsnoop_hci.log, an OKOK scale named Yoda0
 * (08:B8:D0:E8:5F:6D), records #546, #614, #715, #849 and #994 in capture
 * order: idle, stable 76.30 kg, stable 82.70 kg, idle, stable 88.20 kg. Its
 * company id rises by one per weigh-in (0x3FC0, 0x40C0, 0x41C0).
 */
const YODA0_PACKETS = [
  '10ffc03f000000000000240000000000000609596f646130',
  '10ffc03f1dce13880000250000000000000609596f646130',
  '10ffc040204e13880000250000000000000609596f646130',
  '10ffc041000000000000240000000000000609596f646130',
  '10ffc041227413880000250000000000000609596f646130',
];

/**
 * openScale #1191 attachment scale_okok_202510171322_btsnoop_hci.log, a
 * nameless OKOK scale (NIX Home, 08:B8:D0:DE:B5:3A), every advert of it from
 * record #348 to #469: idle, settling, the stable 147.00 kg frame (#439), then
 * idle again (#469). Its company id changes on almost every advert.
 */
const NIX_PACKETS = [
  '10ffc003000000000a012408b8d0deb53a',
  '10ffc004000000000a012408b8d0deb53a',
  '10ffc005000000000a012408b8d0deb53a',
  '10ffc005000000000a012408b8d0deb53a',
  '10ffc007395800000a012408b8d0deb53a',
  '10ffc009395800000a012408b8d0deb53a',
  '10ffc00a395800000a012408b8d0deb53a',
  '10ffc00e395d00000a012408b8d0deb53a',
  '10ffc00f395d00000a012408b8d0deb53a',
  '10ffc011396200000a012408b8d0deb53a',
  '10ffc012396200000a012408b8d0deb53a',
  '10ffc013396c00000a012408b8d0deb53a',
  '10ffc015396c00000a012408b8d0deb53a',
  '10ffc016396c00000a012408b8d0deb53a',
  '10ffc017396c00000a012408b8d0deb53a',
  '10ffc018396c00000a012408b8d0deb53a',
  '10ffc019396c00000a012408b8d0deb53a',
  '10ffc01a396c00000a012408b8d0deb53a',
  '10ffc010396c17700a012508b8d0deb53a',
  '10ffc0bf000017700a012408b8d0deb53a',
];

/** Fold packets into HA's merged dict, keyed by decimal company id. */
function mergedManufacturerData(packets: string[]): Record<string, string> {
  let merged: Record<string, string> = {};
  for (const hex of packets) {
    const p = Buffer.from(hex, 'hex');
    // Each packet starts with its manufacturer AD: length, 0xFF, id LE, data.
    expect(p[1]).toBe(0xff);
    const id = p.readUInt16LE(2);
    merged = { ...merged, [String(id)]: p.subarray(4, 1 + p[0]).toString('hex') };
  }
  return merged;
}

describe('toBleDeviceInfo manufacturer data across merged advertisements (#408)', () => {
  const yoda = (raw: string | null | undefined, packets = YODA0_PACKETS) =>
    ad({
      name: 'Yoda0',
      address: '08:B8:D0:E8:5F:6D',
      manufacturer_data: mergedManufacturerData(packets),
      ...(raw !== undefined ? { raw } : {}),
    });
  const nix = (raw: string | null | undefined) =>
    ad({
      address: '08:B8:D0:DE:B5:3A',
      manufacturer_data: mergedManufacturerData(NIX_PACKETS),
      ...(raw !== undefined ? { raw } : {}),
    });

  it('takes the newest packet, not the previous weigh-in (Yoda0, three weigh-ins)', () => {
    const info = toBleDeviceInfo(yoda(YODA0_PACKETS[4]));
    // The dict holds 0x3FC0, 0x40C0 and 0x41C0; the lowest key is the 76.30 kg
    // weigh-in, the newest packet is 88.20 kg.
    expect(info.manufacturerData).toEqual({
      id: 0x41c0,
      data: Buffer.from('22741388000025000000000000', 'hex'),
    });
  });

  it('takes the newest packet of a scale whose company id rotates (NIX Home)', () => {
    const info = toBleDeviceInfo(nix(NIX_PACKETS[NIX_PACKETS.length - 1]));
    expect(info.manufacturerData).toEqual({
      id: 0xbfc0,
      data: Buffer.from('000017700a012408b8d0deb53a', 'hex'),
    });
  });

  it('drops manufacturer data it cannot date: several keys sharing a low byte, no raw', () => {
    const dropped = vi.fn();
    for (const raw of [null, undefined]) {
      expect(toBleDeviceInfo(yoda(raw), dropped).manufacturerData).toBeUndefined();
      expect(toBleDeviceInfo(nix(raw), dropped).manufacturerData).toBeUndefined();
    }
    expect(dropped).toHaveBeenCalledTimes(4);
  });

  it('falls back to a broken raw the same way (truncated, not hex, no manufacturer AD)', () => {
    const dropped = vi.fn();
    // The last packet cut after 10 bytes: its manufacturer AD (17 bytes long)
    // runs past the end.
    expect(
      toBleDeviceInfo(yoda(YODA0_PACKETS[4].slice(0, 20)), dropped).manufacturerData,
    ).toBeUndefined();
    expect(toBleDeviceInfo(yoda('zz'), dropped).manufacturerData).toBeUndefined();
    // Only the name AD of the packet (0609596f646130), no manufacturer AD.
    expect(toBleDeviceInfo(yoda('0609596f646130'), dropped).manufacturerData).toBeUndefined();
    expect(dropped).toHaveBeenCalledTimes(3);
  });

  it('keeps the first entry when several unrelated companies share the dict and raw is absent', () => {
    // Two keys whose low bytes differ (0x0100 and 0xA0AC) are not one rotating
    // counter; which entry a device like that means is unknown, so the old rule
    // stands. Data taken from the Senssun IF_B7 (#423) and Silvergear 108 (#297)
    // fixtures; no single real device sends both.
    const dropped = vi.fn();
    const info = toBleDeviceInfo(
      ad({
        manufacturer_data: {
          '41132': '4fe9916185a0202d07600da1',
          '256': '02031164fb012d925001221a00000190ce',
        },
      }),
      dropped,
    );
    expect(info.manufacturerData?.id).toBe(256);
    expect(dropped).not.toHaveBeenCalled();
  });

  /*
   * Eufy P3 (T9150) units: the high byte of the company id is the first byte
   * of the unit's own address, the low byte changes while it weighs. The dicts
   * are exactly what Home Assistant logged.
   *
   * bdr99/eufylife-ble-client#3, comment 2870205491 (branda92), line 55,
   * 23:19:34.170, CF:E8:07:12:20:9D: 0xCF53 is a live 68.85 kg frame from
   * before the lock, 0xCF5D the locked 68.55 kg frame that `raw` carries.
   */
  const P3_LOCK_68_55 = 'e80712209d0058d6f9610500c71a010000000000000000';
  const p3Branda = (raw: string | null | undefined) =>
    ad({
      name: 'eufy T9150',
      address: 'CF:E8:07:12:20:9D',
      manufacturer_data: {
        '53075': 'e80712209d0055d6f9610100e51a010000000000000000',
        '53085': P3_LOCK_68_55,
      },
      ...(raw !== undefined ? { raw } : {}),
    });

  it('takes the current entry of a Eufy P3 from raw (keys spelling its own address)', () => {
    const raw =
      '0201061aff5dcfe80712209d0058d6f9610500c71a0100000000000000000b0965756679205439313530';
    expect(toBleDeviceInfo(p3Branda(raw)).manufacturerData).toEqual({
      id: 0xcf5d,
      data: Buffer.from(P3_LOCK_68_55, 'hex'),
    });
  });

  it('drops a Eufy P3 entry it cannot date: keys spelling its own address, no raw', () => {
    // The lowest key (0xCF53) is the stale live frame; taking it would never
    // export this weigh-in, and a stale key can hold an earlier weigh-in.
    const dropped = vi.fn();
    for (const raw of [null, undefined]) {
      expect(toBleDeviceInfo(p3Branda(raw), dropped).manufacturerData).toBeUndefined();
    }
    // bdr99/eufylife-ble-client#3, comment 2564412265 (duke-of-jbala), line
    // 15, 19:19:08.600, CF:E7:09:18:28:04. Here the lowest key (0xCF4D) is by
    // chance the current, locked 82.80 kg frame; without raw nothing can tell,
    // so it is dropped too.
    const p3Duke = ad({
      name: 'eufy T9150',
      address: 'CF:E7:09:18:28:04',
      manufacturer_data: {
        '53070': 'e709182804002a4f706701006720000000000000000000',
        '53069': 'e709182804002c4f706705005820000000000000000000',
      },
    });
    expect(toBleDeviceInfo(p3Duke, dropped).manufacturerData).toBeUndefined();
    expect(dropped).toHaveBeenCalledTimes(3);
  });

  it('keeps the first entry when keys share only their high byte, without the address in them', () => {
    // The two manufacturer data values Home Assistant showed for one Eufy P2
    // Pro, CF:E8:12:18:33:EE, in bdr99/eufylife-ble-client#8 (fft1010); the
    // issue gives no company ids. 0xFF48 is the id another P2 Pro sent
    // (#98, comment 4188979134), 0xFF47 is made up: a P2 whose low byte
    // changed. Its data starts with the whole address, so the high byte of the
    // id does not echo it, and it is left as it was before the Eufy C20 / P3
    // rule.
    const dropped = vi.fn();
    const info = toBleDeviceInfo(
      ad({
        name: 'eufy T9149',
        address: 'CF:E8:12:18:33:EE',
        manufacturer_data: {
          '65352': 'cfe8121833eecf51c00e29dcd69700000000e4',
          '65351': 'cfe8121833eecf4cc00e2904032c000000004f',
        },
      }),
      dropped,
    );
    expect(info.manufacturerData).toEqual({
      id: 0xff47,
      data: Buffer.from('cfe8121833eecf4cc00e2904032c000000004f', 'hex'),
    });
    expect(dropped).not.toHaveBeenCalled();
  });

  it('reads a single entry from the dict and never parses raw for it', () => {
    // A raw that names another company must not override the only key: with
    // one key Home Assistant keeps that value current itself.
    const info = toBleDeviceInfo(
      ad({
        address: '08:B8:D0:E8:5F:6D',
        manufacturer_data: { [String(0x41c0)]: '22741388000025000000000000' },
        raw: YODA0_PACKETS[1],
      }),
    );
    expect(info.manufacturerData).toEqual({
      id: 0x41c0,
      data: Buffer.from('22741388000025000000000000', 'hex'),
    });
  });
});
