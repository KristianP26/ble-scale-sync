import type { Advert, AdvertFixture } from '../../helpers/replay/broadcast.js';

/**
 * PICOOC Mini Lite adverts (#408, D054). Frames of one unit from the nRF
 * Connect log its owner attached to oliexdev/openScale#1512 (comment
 * 5552649285, 252 lines, two weigh-ins) and from openScale's
 * PicoocBroadcastHandlerTest.kt (packets A-C, same unit), as cited in
 * tests/scales/picooc-mini-lite.test.ts. Rewritten: the unit's address, which
 * is the company id (two bytes) plus [0..3], is the fake 02:00:00:00:00:01
 * (company id 0x0002, [0..3] 00 00 00 01), and the checksum [13] is
 * recomputed so the 16 bytes still sum to 0xFF.
 */

const ID = 0x0002;
const PICOOC = { localName: 'PICOOC-L' };
const NRF_82_00 = '00000001391f066813b0871000dc';
const NRF_86_30 = '00000001391f06be13ba876e001e';

/** Milliseconds between consecutive lines of the nRF log, oldest first (test file NRF_GAPS_MS). */
const NRF_GAPS_MS =
  '51 101 48 50 50 49 50 51 60 51 50 49 102 49 50 50 48 50 13 49 50 50 50 50 49 50 50 52 48 ' +
  '11 52 101 47 50 50 150 50 12 99 50 50 100 49 100 51 61 49 51 50 49 50 50 100 50 11 100 50 ' +
  '100 99 52 48 160 52 47 50 100 50 50 53 8 51 49 100 50 101 48 50 61 53 48 50 100 50 50 49 ' +
  '50 61 52 48 150 49 51 49 101 11 102 48 50 50 99 103 47 11 53 48 50 50 52 197 50 61 50 49 ' +
  '51 50 49 101 99 10927 49 49 51 51 98 50 51 48 15 50 48 50 101 51 97 50 50 12 50 100 50 49 ' +
  '100 49 50 52 10 52 49 49 49 51 49 101 49 50 11 50 51 51 48 50 50 50 50 49 49 63 48 50 50 ' +
  '50 100 49 51 111 50 50 49 51 53 46 52 48 49 12 54 48 48 49 51 49 51 100 49 62 102 48 100 ' +
  '50 49 53 47 63 49 50 50 99 50 50 50 50 12 50 50 50 49 101 50 49 49 51 11 51 49 51 49 51 98 ' +
  '100 51 11 51 49 51 50 49 54 46 51 50 49 11 50 100 50 49 52 48 51 49 50';

/** The 252 lines: 119 of 82.00 kg, then 133 of 86.30 kg after the 10 927 ms gap. */
let at = 0;
const NRF_LOG: Advert[] = [0, ...NRF_GAPS_MS.split(' ').map(Number)].map((gap, i) => ({
  atMs: (at += gap),
  mfr: [ID, i < 119 ? NRF_82_00 : NRF_86_30],
}));

export const adverts: AdvertFixture = {
  adapter: 'PICOOC Mini Lite',
  traces: {
    'picooc-nrf-two-weigh-ins': {
      provenance: 'captured',
      source: 'openScale#1512 comment 5552649285 nRF log, all 252 lines with their spacing',
      device: PICOOC,
      adverts: NRF_LOG,
    },
    'picooc-sliding-window': {
      provenance: 'derived',
      source:
        'openScale#1512 nRF line 252 seen again at 59.999 s and 120.001 s: held back while ' +
        'the window slides, handed out 60.002 s after it was last seen',
      device: PICOOC,
      adverts: [
        { atMs: 0, mfr: [ID, NRF_82_00] },
        { atMs: 59_999, mfr: [ID, NRF_82_00] },
        { atMs: 120_001, mfr: [ID, NRF_82_00] },
      ],
    },
    'picooc-openscale-packets': {
      provenance: 'derived',
      source:
        'openScale PicoocBroadcastHandlerTest.kt packetA-C (81.50, 81.60, 82.70 kg); times assumed',
      device: { ...PICOOC, address: null },
      adverts: [
        { atMs: 0, mfr: [ID, '00000001391f065e13388704006a'] },
        { atMs: 10_000, mfr: [ID, '00000001391f066013748706002a'] },
        { atMs: 20_000, mfr: [ID, '00000001391f067613608720000e'] },
      ],
    },
    'picooc-undecoded': {
      provenance: 'derived',
      source:
        'openScale#1512 nRF line 252 with [12] 0x00 -> 0x01 (read, warned), [4] 0x39 -> 0x3D ' +
        '(refused, warned) and [10] 0x87 -> 0x83 (fields disagree, warned); checksum recomputed',
      device: PICOOC,
      adverts: [
        { atMs: 0, mfr: [ID, '00000001391f066813b0871001db'] },
        {
          atMs: 1000,
          mfr: [ID, '000000013d1f066813b0871000d8'],
          repeat: { count: 1, everyMs: 500 },
        },
        { atMs: 2000, mfr: [ID, '00000001391f066813b0831000e0'] },
      ],
    },
  },
};
