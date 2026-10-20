import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

/**
 * The advertisement of the Yunmai Mini 2 (M1690) in #474 (ESPHome proxy, DEBUG
 * log 2026-10-19): no name, no service UUIDs, only 0xFE95 service data, the
 * same value in every Advert line of the log. Frame control 0x2031, product id
 * 0x018D (bytes 2-3, little-endian), counter 0, the MAC reversed, capability
 * 0x09. The log masks the MAC bytes [5..8]; here they are those of
 * 0C:1C:00:00:00:01. [0..4] and [9..11] are as logged.
 */
export const M1690_FE95 = Buffer.from('31208d0100010000001c0c09', 'hex');

/** M1690_FE95 with the product id [2..3] changed to 0x018E, a product nobody claims. */
export const M1690_FE95_PID_018E = Buffer.from('31208e0100010000001c0c09', 'hex');

export const M1690_ADDRESS = '0C:1C:00:00:00:01';

/** The #474 record a transport hands over before connecting. */
export const M1690_ADVERT: BleDeviceInfo = {
  localName: '',
  address: M1690_ADDRESS,
  serviceUuids: [],
  serviceData: [{ uuid: 'fe95', data: M1690_FE95 }],
};
