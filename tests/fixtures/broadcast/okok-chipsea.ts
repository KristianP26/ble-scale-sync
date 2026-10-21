import type { AdvertFixture } from '../../helpers/replay/broadcast.js';

/**
 * OKOK / Chipsea broadcast adverts (#408, D044), both dialects. Frames from the
 * public captures cited in tests/scales/okok-chipsea.test.ts (record numbers
 * are btsnoop record numbers there), each under the company id it was sent
 * with: the C0 dialect's id high byte is a counter, not an address. Advert
 * times are not in the tests, so the traces are `derived` (captured frames,
 * assumed times) unless a source says otherwise. Rewritten: the unit's own
 * address, which C0 echoes at [7..12] and 2.0 at [13..18], is the fake
 * 02:00:00:00:00:01; the 2.0 checksum at [12] does not cover it. The adapter
 * keeps no repeat guard of its own: only the watcher's dedup window stops a
 * stable frame that repeats.
 */

const NIX_STABLE_147_00 = '396c17700a0125020000000001';
const V20 = 0x20ca;

export const adverts: AdvertFixture = {
  adapter: 'OKOK (Chipsea broadcast)',
  traces: {
    'okok-c0-four-weigh-ins': {
      provenance: 'derived',
      source:
        'openScale#1191 NIX Home records #348, #431, #439, #957, #1717, #1993; stable frames ' +
        'at the seconds the vendor CSV records them, the rest assumed',
      adverts: [
        { atMs: 0, mfr: [0x03c0, '000000000a0124020000000001'] },
        { atMs: 1000, mfr: [0x1ac0, '396c00000a0124020000000001'] },
        { atMs: 2000, mfr: [0x10c0, NIX_STABLE_147_00], repeat: { count: 5, everyMs: 1000 } },
        { atMs: 34_000, mfr: [0x11c0, '3a6b17700a0125020000000001'] },
        { atMs: 66_000, mfr: [0x12c0, '3a1617700a0125020000000001'] },
        { atMs: 89_000, mfr: [0x13c0, '399e17700a0125020000000001'] },
      ],
    },
    'okok-c0-repeat-past-dedup': {
      provenance: 'derived',
      source:
        'openScale#1191 record #439 repeated every 5 s for 35 s: dropped by the watcher ' +
        'within 30 s, queued again at 30 s',
      adverts: [{ atMs: 0, mfr: [0x10c0, NIX_STABLE_147_00], repeat: { count: 7, everyMs: 5000 } }],
    },
    'okok-c0-step-off': {
      provenance: 'derived',
      source:
        'openScale#950 records #1039 (idle under 0x00C0), #1212 (stable 81.50), #2221 (step-off ' +
        'after another weigh-in, 50.75 kg, live only)',
      adverts: [
        { atMs: 0, mfr: [0x00c0, '000000000a0124020000000001'] },
        { atMs: 1000, mfr: [0xb1c0, '1fd617700a0125020000000001'] },
        { atMs: 3000, mfr: [0x08c0, '13d317700a0124020000000001'] },
      ],
    },
    'okok-c0-yoda0': {
      provenance: 'derived',
      source: 'openScale#1177 records #546 and #614: zeros for a MAC, claimed by the name Yoda0',
      device: { localName: 'Yoda0' },
      adverts: [
        { atMs: 0, mfr: [0x3fc0, '00000000000024000000000000'] },
        { atMs: 1000, mfr: [0x3fc0, '1dce1388000025000000000000'] },
      ],
    },
    'okok-c0-one-decimal': {
      provenance: 'derived',
      source: 'ble_monitor#537 Xiaogui TZC4 rows "intermediate weight" and "constant weight"',
      adverts: [
        { atMs: 0, mfr: [0x8fc0, '027a0000000220020000000001'] },
        { atMs: 1000, mfr: [0xa3c0, '0276138b000221020000000001'] },
      ],
    },
    'okok-20-weigh-in': {
      provenance: 'derived',
      source:
        'openScale#410 01btsnoop_hci.log record #54 (idle), 03btsnoop_hci.log #65 (settling ' +
        '68.70) and #77 (final 68.65)',
      device: { localName: 'ADV' },
      adverts: [
        { atMs: 0, mfr: [V20, '0b41af2f81010400000000006e020000000001'] },
        { atMs: 1000, mfr: [V20, '0b41af2f810104011ad60000a3020000000001'] },
        {
          atMs: 2000,
          mfr: [V20, '0b41af2f810105071ad11770c4020000000001'],
          repeat: { count: 2, everyMs: 500 },
        },
      ],
    },
    'okok-20-one-decimal-by-name': {
      provenance: 'derived',
      source:
        'openScale#496 comment of 2020-09-09 (EB8217, 95.0 kg); no address, so the exact name ' +
        'ADV claims it',
      device: { localName: 'ADV', address: null },
      adverts: [{ atMs: 0, mfr: [V20, '0b000000000101eb03b6138aec020000000001'] }],
    },
    'okok-undecoded-properties': {
      provenance: 'derived',
      source:
        '#1191 record #439 with [6] 0x25 -> 0x35 (warned once); #410 records with [6] 0x04 -> ' +
        '0x00 (debug only) and 0x05 -> 0x15 (warned), checksum recomputed; #410 record #76 ' +
        'with [12] 0x87 -> 0x86, which no adapter claims',
      adverts: [
        {
          atMs: 0,
          mfr: [0x10c0, '396c17700a0135020000000001'],
          repeat: { count: 1, everyMs: 500 },
        },
        {
          atMs: 1000,
          mfr: [V20, '0b41af2f810100011ad60000a7020000000001'],
          repeat: { count: 1, everyMs: 500 },
        },
        { atMs: 2000, mfr: [V20, '0b41af2f810115051a90177097020000000001'] },
        { atMs: 3000, mfr: [V20, '0b41af2f810105051a90177086020000000001'] },
      ],
    },
  },
};
