import type { AdvertFixture } from '../../helpers/replay/broadcast.js';
import { FAKE_ADDRESS } from '../../helpers/replay/session.js';

/**
 * Xiaomi Body Composition Scale S400 adverts: encrypted MiBeacon v5 in 0xFE95
 * service data, product id 0x3BD5. The four measurement frames are the public
 * vectors of Home Assistant's xiaomi-ble test-suite (Apache-2.0,
 * tests/test_parser.py, test_Xiaomi_Scale_S400_*), as cited in
 * tests/scales/xiaomi-s400.test.ts, decrypted with their keys and addresses and
 * encrypted again, byte for byte the same plaintext, counter and ext counter,
 * under the dummy bind key 000102..0f with the fake 02:00:00:00:00:01 as the
 * nonce MAC, so no real key or address is in git. The idle beacon (FC 0x5A30,
 * MAC + capability) is built as the tests build it. Plaintexts: barefoot
 * 69.9 kg 543.2 ohm 92 bpm, then 497.6 ohm at 250 kHz; socks 74.7 kg; step-off.
 */

const KEY = '000102030405060708090a0b0c0d0e0f';
const BARE_WEIGHT = '4859d53b0a64133f4c6c201fd23be09325000000b6465d85';
const BARE_HIGH = '4859d53b0b56142e9263fea3e35a9204150000009481fece';
const SOCKS = '4859d53b713846be401fb7c03245438d8f00000026767076';
const RESET = '4859d53b7258d227c7a56796ca1b5ecc99000000e7aa5d8e';
const IDLE_BEACON = '305ad53b0001000000000208';

export const adverts: AdvertFixture = {
  adapter: 'Xiaomi Body Composition Scale S400',
  config: { bindKey: KEY, scaleMac: FAKE_ADDRESS },
  traces: {
    's400-barefoot': {
      provenance: 'derived',
      source: 'xiaomi-ble test_Xiaomi_Scale_S400 barefoot vectors, re-encrypted; times assumed',
      adverts: [
        { atMs: 0, svc: { fe95: BARE_WEIGHT }, repeat: { count: 2, everyMs: 300 } },
        { atMs: 1500, svc: { fe95: BARE_HIGH }, repeat: { count: 1, everyMs: 300 } },
      ],
    },
    's400-socks-then-step-off': {
      provenance: 'derived',
      source: 'xiaomi-ble test_Xiaomi_Scale_S400 socks and reset vectors, re-encrypted',
      device: { localName: 'Xiaomi Scale S400' },
      adverts: [
        { atMs: 0, svc: { fe95: SOCKS } },
        { atMs: 2000, svc: { fe95: RESET } },
      ],
    },
    's400-mac-from-idle-beacon': {
      provenance: 'derived',
      source:
        'no ble.scale_mac: the idle beacon gives the nonce MAC, then the barefoot weight decrypts',
      config: { bindKey: KEY },
      adverts: [
        { atMs: 0, svc: { fe95: IDLE_BEACON } },
        { atMs: 1000, svc: { fe95: BARE_WEIGHT } },
      ],
    },
    's400-mac-unknown': {
      provenance: 'derived',
      source:
        'no ble.scale_mac and no idle beacon yet: warned once, then the beacon arrives and the ' +
        'same frame decrypts',
      config: { bindKey: KEY },
      adverts: [
        { atMs: 0, svc: { fe95: BARE_WEIGHT }, repeat: { count: 1, everyMs: 300 } },
        { atMs: 1000, svc: { fe95: IDLE_BEACON } },
        { atMs: 1300, svc: { fe95: BARE_WEIGHT } },
      ],
    },
    's400-wrong-scale-mac': {
      provenance: 'derived',
      source: 'ble.scale_mac one byte off the nonce MAC: decryption fails, warned once',
      config: { bindKey: KEY, scaleMac: '02:00:00:00:00:02' },
      adverts: [{ atMs: 0, svc: { fe95: BARE_WEIGHT }, repeat: { count: 1, everyMs: 300 } }],
    },
    's400-no-bind-key': {
      provenance: 'derived',
      source: 'no ble.bind_key: warned once',
      config: {},
      adverts: [{ atMs: 0, svc: { fe95: SOCKS }, repeat: { count: 1, everyMs: 300 } }],
    },
  },
};
