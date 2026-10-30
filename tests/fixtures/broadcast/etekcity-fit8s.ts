import type { AdvertFixture } from '../../helpers/replay/broadcast.js';

/**
 * Etekcity Fit 8S adverts (#408, D052). Frames from the two pcapng
 * captures in oliexdev/openScale#1472 (scale-capture-72.zip, Wireshark frame
 * numbers below) and the frames of a second unit in
 * ronnnnnnnnnnnnn/etekcity_esf551_ble#6, as cited in
 * tests/scales/etekcity-fit8s.test.ts. The tests carry no advert times, so
 * every trace is `derived`: captured frames at assumed times (the stable
 * frame repeats for at least 12 s, the scale is off after 30 s). Rewritten:
 * the unit's address at [1..6] (reversed) is the fake 02:00:00:00:00:01, and
 * [8], which equals the first address byte on both units, is 0x02.
 */

const IDLE = '01010000000002c0020100000000000000020300';
const SETTLING_52_73 = '01010000000002c00201facd0000000000020300';
const SETTLING_72_27 = '01010000000002c002014e1a0100000000020300';
const STABLE_72_27 = '01010000000002c002014e1a010e020100020300';
const SETTLING_72_55 = '01010000000002c00201661b0100000000020300';
const STABLE_72_55 = '01010000000002c00201661b010c020100020300';
const ID = 0x06d0;
/** noble on Linux and Windows, and the proxies: address and services known. */
const NOBLE = { serviceUuids: ['ffd0'] };

export const adverts: AdvertFixture = {
  adapter: 'Etekcity Fit 8S',
  traces: {
    'fit8s-weigh-in': {
      provenance: 'derived',
      source: 'openScale#1472 72.55kg file #1, #3, #19, #36; times assumed',
      device: NOBLE,
      adverts: [
        { atMs: 0, mfr: [ID, IDLE] },
        { atMs: 1000, mfr: [ID, SETTLING_52_73] },
        { atMs: 2000, mfr: [ID, SETTLING_72_55], repeat: { count: 2, everyMs: 500 } },
        { atMs: 4300, mfr: [ID, STABLE_72_55], repeat: { count: 24, everyMs: 500 } },
        { atMs: 20_000, mfr: [ID, IDLE] },
      ],
    },
    'fit8s-same-result-again': {
      provenance: 'derived',
      source:
        'openScale#1472 72.25kg file #9 and #27: a settling frame between two stable phases ' +
        'of the same result frees it; the watcher dedup window drops it within 30 s',
      device: NOBLE,
      adverts: [
        { atMs: 0, mfr: [ID, STABLE_72_27] },
        { atMs: 5000, mfr: [ID, SETTLING_72_27] },
        { atMs: 7300, mfr: [ID, STABLE_72_27] },
        { atMs: 38_000, mfr: [ID, SETTLING_72_27] },
        { atMs: 40_300, mfr: [ID, STABLE_72_27] },
      ],
    },
    'fit8s-hold-expiry': {
      provenance: 'derived',
      source:
        'openScale#1472 72.25kg file #27 seen every 10 s with no settling frame: held back ' +
        'through 60 s after its export, handed out at 60.001 s',
      device: NOBLE,
      adverts: [
        { atMs: 0, mfr: [ID, STABLE_72_27], repeat: { count: 6, everyMs: 10_000 } },
        { atMs: 60_001, mfr: [ID, STABLE_72_27] },
      ],
    },
    'fit8s-second-unit-node-ble': {
      provenance: 'derived',
      source:
        'etekcity_esf551_ble#6 SAMPLE_KG (no impedance) and SAMPLE_KG_WITH_IMPEDANCE; node-ble ' +
        'reports no services before connecting; times assumed',
      adverts: [
        { atMs: 0, mfr: [ID, '01010000000002c00201563a0100000100020300'] },
        { atMs: 1000, mfr: [ID, '01010000000002c002017c3c0119020100020300'] },
      ],
    },
    'fit8s-macos-no-address': {
      provenance: 'derived',
      source: 'openScale#1472 72.55kg file #19 and #36 without an address (noble on macOS)',
      device: { ...NOBLE, address: null },
      adverts: [
        { atMs: 0, mfr: [ID, SETTLING_72_55] },
        { atMs: 2300, mfr: [ID, STABLE_72_55], repeat: { count: 2, everyMs: 500 } },
      ],
    },
    'fit8s-undecoded-bytes': {
      provenance: 'derived',
      source:
        'openScale#1472 72.25kg file #27 with [15] 0x01 -> 0x02, [0] 0x01 -> 0x11, [16] 0x00 -> ' +
        '0x03: each warned once; the unknown unit is still read as grams',
      device: NOBLE,
      adverts: [
        { atMs: 0, mfr: [ID, '01010000000002c002014e1a010e020200020300'] },
        { atMs: 500, mfr: [ID, '01010000000002c002014e1a010e020200020300'] },
        { atMs: 1000, mfr: [ID, '11010000000002c002014e1a010e020100020300'] },
        { atMs: 1500, mfr: [ID, '11010000000002c002014e1a010e020100020300'] },
        { atMs: 2000, mfr: [ID, '01010000000002c002014e1a010e020103020300'] },
      ],
    },
  },
};
