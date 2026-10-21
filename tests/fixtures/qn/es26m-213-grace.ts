import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, qnSteps } from './frames.js';

/**
 * #213, the #253 unit (18-byte dialect, ES-30M layout), no options: the DEBUG
 * log of comment 4691542531, session of 2026-06-12 13:02:45 (every `QN RAW`
 * line). Its stable frames carry no resistance at all, so the weight-only
 * reading is taken once IMPEDANCE_GRACE_MS has passed since the first (85.25
 * kg / 0 Ohm in the log). Rewritten: the MAC (frames.ts); the AE02 challenge
 * kept once, as in es26m-253.ts.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  chars: AE00_CHARS,
  now: Date.parse('2026-06-12T13:02:45.844Z'),
  traces: {
    '213-weight-only-after-grace': {
      provenance: 'captured',
      source: '#213 comment 4691542531, DEBUG log 2026-06-12 13:02:45',
      steps: qnSteps([
        ['13:02:45.844', 'rx', '12 12 ff 01 00 00 00 00 02 01 17 09 00 00 05 9f 30 1b'],
        ['13:02:46.088', 'rx', '12 12 ff 01 00 00 00 00 02 01 17 09 00 00 05 9f 30 1b'],
        ['13:02:46.285', 'rx', '14 0b ff 00 00 01 00 00 00 00 1f'],
        ['13:02:46.431', 'rx', 'a3 04 01 a8'],
        ['13:02:46.432', 'rx', '00 92 64 3d 89 26 a9 77 2d 87 54 7c 6f e1 82 a1 76'],
        ['13:02:46.529', 'rx', '21 05 ff 01 26'],
        ['13:02:46.626', 'rx', 'a1 06 04 fe 01 aa'],
        ['13:02:46.821', 'rx', 'a1 06 02 01 01 ab'],
        ['13:02:46.919', 'rx', '10 0e ff 01 00 21 4d 00 00 00 00 00 00 8c'],
        ['13:02:47.016', 'rx', '10 0e ff 01 00 21 4d 00 00 00 00 00 00 8c'],
        ['13:02:48.089', 'rx', '23 13 ff 00 00 00 0e fd 9c 31 00 00 00 00 00 00 00 00 0d'],
        ['13:02:50.772', 'rx', '10 0e ff 01 02 21 4d 00 00 00 00 00 00 8e'],
        ['13:02:51.260', 'rx', '10 0e ff 01 02 21 4d 00 00 00 00 00 00 8e'],
        ['13:02:51.796', 'rx', '10 0e ff 01 02 21 4d 00 00 00 00 00 00 8e'],
        ['13:02:52.283', 'rx', '10 0e ff 01 02 21 4d 00 00 00 00 00 00 8e'],
      ]),
    },
  },
};
