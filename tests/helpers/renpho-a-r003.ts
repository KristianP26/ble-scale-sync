import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';

/**
 * The Renpho A-R003 of #507, over an ESPHome proxy. Two sources:
 *
 * - The advertisement and the characteristics come from the DEBUG log in the
 *   issue body (ble-scale-sync v1.36.0). Every Advert line of that log is the
 *   same: no name, service 0x181D, and 17 bytes of manufacturer data under
 *   company 0xFFFF that carry the scale's own address little-endian at
 *   [9..14].
 * - The weigh-in frames (AR003_WEIGH_IN) come from a private DEBUG log (#507,
 *   2026-10-28) and are derived from it; their comments list every byte that
 *   differs from the log.
 *
 * Rewritten: the scale's address is the fake 02:00:00:00:00:01 here, in the
 * address and in its echo at [9..14] of the manufacturer data, which therefore
 * reads `01 00 00 00 00 02`. [0..8] and [15..16] are as logged. No checksum is
 * known over the payload, so nothing else changes.
 */
export const AR003_ADDRESS = '02:00:00:00:00:01';

export const AR003_MSD = Buffer.from('04bd080100333200000100000000020032', 'hex');

/** The record a transport that reports advertised services hands over before connecting. */
export const AR003_ADVERT: BleDeviceInfo = {
  localName: '',
  address: AR003_ADDRESS,
  serviceUuids: ['181d'],
  manufacturerData: { id: 0xffff, data: AR003_MSD },
};

/**
 * The same advertisement as node-ble reads it: BlueZ exposes no advertised
 * services. Derived from the log, not seen in it.
 */
export const AR003_ADVERT_NODE_BLE: BleDeviceInfo = { ...AR003_ADVERT, serviceUuids: [] };

/**
 * The 27 `ESPHome GATT char` lines of the log, in order: the 16-bit UUID, the
 * value handle and the GATT properties byte (0x02 read, 0x08 write, 0x10
 * notify, 0x20 indicate).
 */
export const AR003_GATT_CHARS: ReadonlyArray<{ code: number; handle: number; props: number }> = [
  { code: 0x2a05, handle: 0x03, props: 0x20 },
  { code: 0x2a00, handle: 0x16, props: 0x02 },
  { code: 0x2a01, handle: 0x18, props: 0x02 },
  { code: 0x2aa6, handle: 0x1a, props: 0x02 },
  { code: 0x2a9d, handle: 0x2a, props: 0x30 },
  { code: 0x2a9e, handle: 0x2d, props: 0x02 },
  { code: 0x2a9c, handle: 0x30, props: 0x30 },
  { code: 0x2a9b, handle: 0x33, props: 0x02 },
  { code: 0xffe1, handle: 0x35, props: 0x12 },
  { code: 0xffe2, handle: 0x38, props: 0x08 },
  { code: 0x2a24, handle: 0x3b, props: 0x02 },
  { code: 0x2a25, handle: 0x3d, props: 0x02 },
  { code: 0x2a26, handle: 0x3f, props: 0x02 },
  { code: 0x2a27, handle: 0x41, props: 0x02 },
  { code: 0x2a28, handle: 0x43, props: 0x02 },
  { code: 0x2a29, handle: 0x45, props: 0x02 },
  { code: 0x2a2b, handle: 0x48, props: 0x1a },
  { code: 0xfff1, handle: 0x4b, props: 0x12 },
  { code: 0xfff2, handle: 0x4e, props: 0x08 },
  { code: 0x2a19, handle: 0x51, props: 0x02 },
  { code: 0x2a8c, handle: 0x54, props: 0x0a },
  { code: 0x2a80, handle: 0x56, props: 0x0a },
  { code: 0x2a85, handle: 0x58, props: 0x0a },
  { code: 0x2a8e, handle: 0x5a, props: 0x0a },
  { code: 0x2a99, handle: 0x5c, props: 0x1a },
  { code: 0x2a9f, handle: 0x5f, props: 0x38 },
  { code: 0x2aff, handle: 0x62, props: 0x0a },
];

/** The characteristic UUIDs as the ESPHome proxy logs them (128-bit, dashless). */
export const AR003_CHARS: string[] = AR003_GATT_CHARS.map((c) => uuid16(c.code));

/** The log's characteristics without the ones listed, for partial discoveries. */
export const ar003CharsWithout = (...codes: number[]): string[] =>
  AR003_GATT_CHARS.filter((c) => !codes.includes(c.code)).map((c) => uuid16(c.code));

/**
 * The characteristics as an ESP32 mqtt-proxy `connected` payload lists them,
 * with the property names the firmware sends for the logged properties byte.
 * Derived from the log, not seen in it.
 */
export const ar003MqttChars = (): Array<{ uuid: string; properties: string[] }> =>
  AR003_GATT_CHARS.map(({ code, props }) => ({
    uuid: uuid16(code),
    properties: [
      [0x02, 'read'],
      [0x04, 'write-without-response'],
      [0x08, 'write'],
      [0x10, 'notify'],
      [0x20, 'indicate'],
    ]
      .filter(([bit]) => props & (bit as number))
      .map(([, label]) => label as string),
  }));

/**
 * hypothesis: the GATT services. The log lists characteristics only; these are
 * the services their handles imply (Generic Attribute, Generic Access, Weight
 * Scale, Body Composition, the vendor 0xFFE0 around 0xFFE1/0xFFE2, Device
 * Information, Current Time, 0xFFF0 around 0xFFF1/0xFFF2, Battery, User Data
 * with 0x2AFF).
 */
export const AR003_SERVICES: string[] = [
  0x1801, 0x1800, 0x181d, 0x181b, 0xffe0, 0x180a, 0x1805, 0xfff0, 0x180f, 0x181c,
].map(uuid16);

/**
 * One weigh-in after the consent, from the private log: the vendor and
 * consent answers, the 0x2A9D the scale sends six times while the weight
 * settles, the final 0x2A9D and the two 0x2A9C packets. The weight (82.30 kg,
 * public in #507) and the scale's clock (2026-10-28 10:53:30 on the first
 * 0x2A9D, 10:53:41 after it) are as logged; user 170 is the fixed consent
 * index.
 */
export const AR003_WEIGH_IN = {
  /** 0xFFE1 handshake answer, as logged. */
  vendorAck: '20030124',
  /** 0x2A9F consent accepted, as logged. */
  consentAccepted: '200201',
  /** 0x2A9D flags 0x4E, BMI and height 0, as logged. */
  progress: '4e6e06ea070a1c0a351eaa00000000',
  /**
   * 0x2A9D flags 0x2E. The BMI and height at [11..14] are not the logged
   * ones but what the scale would echo for the fixture profile: 183 cm
   * (`b7 00`) and 82.30 / 1.83^2 = 24.6 (`f6 00`). The height is in cm, the
   * echo of the 0x2A8E the adapter writes, not the 0.001 m of a SIG Weight
   * Measurement; the log shows the same unit.
   */
  final: '2e6e06ea070a1c0a3529aaf600b700',
  /**
   * 0x2A9C packet 1: flags 0x537E, Time Stamp 2026-10-28 10:53:41 and user
   * 170 as logged; the body fat at [2..3] and every field after the user zeroed.
   */
  bcsPacket1: '7e530000ea070a1c0a3529aa0000000000000000',
  /**
   * 0x2A9C packet 2, 19 bytes in the layout of the logged one, with made-up
   * values: water 45.8 % (`ca 01`) at [0..1], resistances 480 and 476 at
   * [2..5], the rest 0. Read as SIG flags, [0..1] is 0x01CA, which claims a
   * Time Stamp at [4..10] whose year (476) is not a date. Unmodified, this is
   * the only fixture packet that reaches the Time Stamp check of
   * describesPacket (renpho.ts); the logged packet 2 does too (#507).
   */
  bcsPacket2: 'ca01e001dc0100000000000000000000000000',
} as const;

/** A clock 4 s after the weigh-in, so its frames read as live in any zone. */
export const AR003_WEIGH_IN_NOW = new Date(2026, 9, 28, 10, 53, 45).getTime();
