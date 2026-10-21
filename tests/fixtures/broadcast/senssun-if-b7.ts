import type { AdvertFixture } from '../../helpers/replay/broadcast.js';

/**
 * Senssun IF_B7 adverts (#423, sold as Grifema GA2001). Frames from the #423
 * reporter's ESPHome export (comment 2026-09-29T16:52:27Z, its timestamps) and
 * from custom-components/ble_monitor test_senssun_parser.py, as cited in
 * tests/scales/senssun-if-b7.test.ts. Rewritten: the unit's address, echoed
 * forward at [3..8], is the fake 02:00:00:00:00:01; the checksum at [16] covers
 * [9..15] only. The adapter keeps no repeat guard: every finished frame is a
 * reading, and only the watcher's dedup window stops the repeats.
 */

const ID = 0x0100;
const IF_B7 = { localName: 'IF_B7' };
const KG_FINISHED_FIRST = '02031102000000000101226a0000a1d1ff';

export const adverts: AdvertFixture = {
  adapter: 'Senssun IF_B7',
  traces: {
    'ifb7-423-kg': {
      provenance: 'captured',
      source: '#423 ESPHome export, 16:37:23.467Z to 16:37:25.208Z (display kg, app 88.1 kg)',
      device: IF_B7,
      adverts: [
        { atMs: 0, mfr: [ID, '02031102000000000101226a000001d05e'] },
        { atMs: 408, mfr: [ID, KG_FINISHED_FIRST] },
        { atMs: 732, mfr: [ID, '02031102000000000101226a0000a1d200'] },
        { atMs: 1741, mfr: [ID, '02031102000000000101226a0089a1d78e'] },
      ],
    },
    'ifb7-423-lb': {
      provenance: 'captured',
      source: '#423 ESPHome export, 16:55:30.448Z to 16:55:32.392Z (display lb, [10..11] still kg)',
      device: IF_B7,
      adverts: [
        { atMs: 0, mfr: [ID, '0203110200000000010122380000027edb'] },
        { atMs: 408, mfr: [ID, '0203110200000000010122380000a27f7c'] },
        { atMs: 1944, mfr: [ID, '02031102000000000101223800caa2864d'] },
      ],
    },
    'ifb7-423-weighing': {
      provenance: 'derived',
      source: '#423 issue log and comment: two weighing frames (87.30, 84.20 kg); times assumed',
      device: IF_B7,
      adverts: [
        { atMs: 0, mfr: [ID, '02031102000000000101221a00000190ce'] },
        { atMs: 1000, mfr: [ID, '0203110200000000010120e40000011c22'] },
      ],
    },
    'ifb7-ble-monitor': {
      provenance: 'captured',
      source: 'ble_monitor test_senssun_parser.py, a second unit, finished 67.25 kg',
      device: IF_B7,
      adverts: [{ atMs: 0, mfr: [ID, '020311020000000001021a4500b4a1ab61'] }],
    },
    'ifb7-macos-by-name': {
      provenance: 'derived',
      source: '#423 export 16:37:23.875Z without an address (noble on macOS): claimed by name',
      device: { ...IF_B7, address: null },
      adverts: [{ atMs: 0, mfr: [ID, KG_FINISHED_FIRST] }],
    },
    'ifb7-undecoded': {
      provenance: 'derived',
      source:
        '#423 export 16:55:30.856Z with [14] 0xA2 -> 0xA3 (unknown unit, warned once) and ' +
        '16:37:23.875Z with [14] 0xA1 -> 0xE1 (unknown state, debug only); checksum recomputed',
      device: IF_B7,
      adverts: [
        {
          atMs: 0,
          mfr: [ID, '0203110200000000010122380000a37f7d'],
          repeat: { count: 1, everyMs: 400 },
        },
        { atMs: 1000, mfr: [ID, '02031102000000000101226a0000e1d13f'] },
      ],
    },
  },
};
