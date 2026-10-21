import type { SessionFixture } from '../../helpers/replay/session.js';
import type { SnoopLine } from '../../helpers/replay/trace.js';
import { qnSteps } from './frames.js';

/**
 * #283, a classic QN scale (17-byte 0x12, no AE00), no options: the
 * successful session in the issue body's DEBUG log (every `QN RAW` line).
 * The scale sends an unstable frame, its 0x23 in the classic layout (not
 * decoded), then 61.70 kg / R 502. That log has no timestamps, so the spacing
 * is set by hand in the order it shows. Rewritten: the MAC (frames.ts). The
 * clock is set so the 0x20 at the ready frame carries the log's time.
 */
export const LINES_283: readonly SnoopLine[] = [
  ['00:00:00.000', 'rx', '12 11 ff 01 00 00 00 00 02 0a 03 19 00 04 05 07 5b'],
  ['00:00:00.600', 'rx', '14 0b ff 00 00 01 00 00 00 00 1f'],
  ['00:00:00.900', 'rx', '21 04 ff 01 25'],
  ['00:00:03.000', 'rx', '10 0b ff 18 1a 00 00 00 00 00 4c'],
  ['00:00:03.500', 'rx', '23 13 ff 04 01 09 11 ef 31 18 1a 01 fc 01 f8 00 00 00 9c'],
  ['00:00:05.000', 'rx', '10 0b ff 18 1a 01 01 f6 01 f7 3c'],
];

/** 600 ms before the log's 0x20 (`20 08 ff f5 11 ef 31 4d`, 04:41:25). */
export const NOW_283 = Date.parse('2026-07-19T04:41:24.400Z');

export const session: SessionFixture = {
  adapter: 'QN Scale',
  now: NOW_283,
  traces: {
    'classic-283': {
      provenance: 'derived',
      source: '#283 issue body, DEBUG log without timestamps; spacing set by hand',
      steps: qnSteps(LINES_283),
    },
  },
};
