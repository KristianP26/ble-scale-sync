import type { AdvertFixture } from '../../helpers/replay/broadcast.js';

/**
 * Xiaomi Mijia Scale S800 adverts (#232): encrypted MiBeacon v5 in 0xFE95
 * service data, product id 0x51E2. No real frame is in the repo, so all are
 * `characterization`: built as tests/scales/xiaomi-s800.test.ts builds them
 * (FC 0x5958 with the MAC, 0x5948 without; ext counter 01 00 00), encrypted
 * under the dummy bind key 000102..0f with the fake 02:00:00:00:00:01 as the
 * nonce MAC. Objects: the idle 0x5201, and 0x4E16 with 82.40 kg. The adapter
 * keeps no repeat guard; it caches the MAC from a frame that carries it.
 */

const KEY = '000102030405060708090a0b0c0d0e0f';
const IDLE = '5859e2515a01000000000263492b49010000041f5f7a';
const WEIGHT = '5859e2515b01000000000226d226b545cd7ec33c97c7b80100000bb875c8';
const WEIGHT_NO_MAC = '4859e2515cd19c2ddc4b61869088901320010000865eb785';
const WEIGHT_LATER = '5859e2515d010000000002c924bf16eec407da9dfcb4b1010000e9e89407';

export const adverts: AdvertFixture = {
  adapter: 'Xiaomi Mijia Scale S800',
  config: { bindKey: KEY },
  traces: {
    's800-weigh-in': {
      provenance: 'characterization',
      source:
        'xiaomi-s800.test.ts frame layout: idle, the weight frame repeated, the same weight ' +
        'without the MAC (cached), and a new counter after the 30 s dedup window',
      adverts: [
        { atMs: 0, svc: { fe95: IDLE } },
        { atMs: 1000, svc: { fe95: WEIGHT }, repeat: { count: 3, everyMs: 500 } },
        { atMs: 3000, svc: { fe95: WEIGHT_NO_MAC } },
        { atMs: 31_000, svc: { fe95: WEIGHT_LATER } },
      ],
    },
    's800-mac-not-seen-yet': {
      provenance: 'characterization',
      source: 'xiaomi-s800.test.ts frame layout: a frame without the MAC before any with it',
      device: { localName: 'Mijia Scale S800' },
      adverts: [
        { atMs: 0, svc: { fe95: WEIGHT_NO_MAC } },
        { atMs: 1000, svc: { fe95: WEIGHT } },
      ],
    },
    's800-no-bind-key': {
      provenance: 'characterization',
      source: 'xiaomi-s800.test.ts frame layout with no ble.bind_key: warned once',
      config: {},
      adverts: [{ atMs: 0, svc: { fe95: WEIGHT }, repeat: { count: 1, everyMs: 500 } }],
    },
  },
};
