import { describe, it, expect } from 'vitest';
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

  it('omits empty manufacturer and service data', () => {
    const info = toBleDeviceInfo(ad({ manufacturer_data: { '76': '' }, service_data: {} }));
    expect(info.manufacturerData).toBeUndefined();
    expect(info.serviceData).toBeUndefined();
  });

  it('tolerates missing optional collections', () => {
    const partial = { name: 'x', address: 'AA:BB:CC:DD:EE:FF' } as unknown as HaAdvertisement;
    expect(toBleDeviceInfo(partial)).toEqual({ localName: 'x', serviceUuids: [] });
  });
});
