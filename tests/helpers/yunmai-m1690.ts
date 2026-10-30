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

/**
 * The Mini 2's reply to the GET_PROTOCOL_VERSION unlock (#474, DEBUG log
 * 2026-10-20), byte for byte: start, protocol 0x1F, length 5, type 0x05, XOR.
 * After a weigh-in the scale answers every unlock with it and sends nothing else.
 */
export const M1690_PROTOCOL_VERSION_REPLY = Buffer.from('0d1f05051f', 'hex');

/**
 * The reply with [2] set to 6, no longer its own length, and the XOR recomputed:
 * a buffer nobody has seen on a real scale, there only to pin the [2] check.
 */
export const M1690_REPLY_WRONG_LENGTH = Buffer.from('0d1f06051c', 'hex');

/**
 * A live 0x01 frame of the same log (13:34:07.701) with the weight [8..9] replaced
 * by 80.00 kg, so the reporter's number stays out of the repo, and the XOR [10]
 * recomputed. [0..7], the scale clock 0x000ED91B included, are as captured.
 */
export const M1690_LIVE_80KG = Buffer.from('0d1f0b01000ed91b1f4086', 'hex');
