import type { SessionFixture } from '../../helpers/replay/session.js';
import type { SnoopLine } from '../../helpers/replay/trace.js';
import { AE00_CHARS, qnSteps } from './frames.js';

/**
 * #235, a GE CS 10 G "Fit Plus" on the 20-byte extended dialect with the JieLi
 * AE00 gate, no options. No log of one whole session is public, so each trace
 * puts real frames of that unit together, spacing set by hand:
 *  - the 0x12 of the 2026-08-19 log attached to #235 (as in
 *    tests/scales/qn-scale.test.ts), MAC rewritten (frames.ts);
 *  - ready, `a3`, AE00 challenge, config request and the scale's refusal of
 *    openScale's profile frame from the DEBUG log of comment 4710137730;
 *  - a live 20-byte 0x10 from the reporter's vendor-app capture (78.70 kg),
 *    which this dialect leaves undecoded;
 *  - the 0xB4/0xB1 result frames of the 2026-08-19 log: a 0xB4 history record
 *    of 2026-08-13, one stamped at the previous connect (18:03:34) and the
 *    live 0xB1 records (75.25 and 75.20 kg).
 * The clock is that log's third connect, 18:06:32.
 */
export const HANDSHAKE_235: readonly SnoopLine[] = [
  ['00:00:00.000', 'rx', '12 14 ff 01 00 00 00 00 02 14 0f 42 00 02 05 03 e0 6f 2b 11'],
  ['00:00:00.300', 'rx', '14 0c ff 01 00 01 00 00 00 01 fd 1f'],
  ['00:00:00.400', 'rx', 'a3 04 01 a8'],
  ['00:00:00.450', 'rx', '00 21 14 4a 0c 08 a1 50 62 99 2e c6 1f c8 74 31 fe'],
  ['00:00:00.600', 'rx', '21 07 ff 01 62 2c b6'],
  ['00:00:00.900', 'rx', 'a1 06 02 01 00 aa'],
  ['00:00:04.000', 'rx', '10 14 01 00 11 1e be 00 00 00 00 00 00 00 00 00 00 00 00 12'],
];

const B4_2026_08_13 =
  'b42c0401f01001121b1032361a000000000000000000000000000000000000000000000000000000000000a5';
const B4_PREVIOUS_CONNECT =
  'b42c040101010176ac1832601dd20b7c0ab50b560a0c0ad608bd099f0828015a01530bfa092a0bc6099a0a42';
const B1_7525 =
  'b12c030101651d030bbb09ac0a4f09790a4f09b3095a081b011601440bea091a0bb509a90a7d09480a090932';
const B1_7520 =
  'b12c030101601dd20b7c0ab50b560a0c0ad608bd099f0828015a01530bfa092a0bc6099a0a6d093a0afe0890';
/** B4_PREVIOUS_CONNECT stamped 18:06:30, two seconds before this connect; [7..10] and [43] changed. */
const B4_THIS_CONNECT =
  'b42c040101010126ad1832601dd20b7c0ab50b560a0c0ad608bd099f0828015a01530bfa092a0bc6099a0af3';

export const B4_THEN_B1_235: readonly SnoopLine[] = [
  ...HANDSHAKE_235,
  ['00:00:20.000', 'rx', B4_2026_08_13],
  ['00:00:20.100', 'rx', B4_2026_08_13],
  ['00:00:20.200', 'rx', B4_PREVIOUS_CONNECT],
  ['00:00:20.300', 'rx', B1_7525],
  ['00:00:20.400', 'rx', B1_7520],
];

export const NOW_235 = Date.parse('2026-08-19T18:06:32Z');

export const session: SessionFixture = {
  adapter: 'QN Scale',
  chars: AE00_CHARS,
  now: NOW_235,
  traces: {
    'ge-235-b4-history-then-b1': {
      provenance: 'derived',
      source:
        '#235 comment 4710137730 and the 2026-08-19 log; frames combined, spacing set by hand',
      steps: qnSteps(B4_THEN_B1_235),
    },
    'ge-235-b4-this-connect': {
      provenance: 'derived',
      source: '#235 2026-08-19 log, 0xB4 restamped to this connect; spacing set by hand',
      steps: qnSteps([
        ...HANDSHAKE_235,
        ['00:00:20.000', 'rx', B4_THIS_CONNECT],
        ['00:00:20.100', 'rx', B1_7520],
      ]),
    },
  },
};
