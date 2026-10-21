import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, qnSteps } from './frames.js';

/**
 * #253, a Renpho ES-26M on the 18-byte dialect with AE00 and the 14-byte
 * ES-30M live layout, no options: the DEBUG log of comment 4935889463,
 * session of 2026-07-10 13:28:35 (every `QN RAW` line). Two "no stored
 * weigh-ins" 0x23 (19 bytes), three unstable frames, then 84.80 kg / R 501.
 * No advertisement reached the session. Rewritten: the MAC (frames.ts). That
 * build dispatched each AE02 frame to four listeners (#75), so the challenge's
 * four identical lines are the one notification it was.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  chars: AE00_CHARS,
  now: Date.parse('2026-07-10T13:28:35.174Z'),
  traces: {
    '253-es30m-live': {
      provenance: 'captured',
      source: '#253 comment 4935889463, DEBUG log 2026-07-10 13:28:35',
      steps: qnSteps([
        ['13:28:35.174', 'rx', '12 12 ff 01 00 00 00 00 02 01 17 09 00 00 05 9f 30 1b'],
        ['13:28:35.370', 'rx', '12 12 ff 01 00 00 00 00 02 01 17 09 00 00 05 9f 30 1b'],
        ['13:28:35.687', 'rx', '14 0b ff 00 00 01 00 00 00 00 1f'],
        ['13:28:35.784', 'rx', 'a3 04 01 a8'],
        ['13:28:35.786', 'rx', '00 06 5b b0 9a 76 57 43 63 69 9d 59 17 48 eb cc ba'],
        ['13:28:35.881', 'rx', '21 05 ff 01 26'],
        ['13:28:36.027', 'rx', 'a1 06 04 fe 01 aa'],
        ['13:28:36.174', 'rx', 'a1 06 02 01 01 ab'],
        ['13:28:36.662', 'rx', '23 13 ff 00 00 00 04 b0 e3 30 00 00 00 00 00 00 00 00 fc'],
        ['13:28:38.758', 'rx', '10 0e ff 01 01 21 20 00 00 00 00 00 00 60'],
        ['13:28:39.246', 'rx', '10 0e ff 01 01 21 20 00 00 00 00 00 00 60'],
        ['13:28:39.733', 'rx', '10 0e ff 01 01 21 20 00 00 00 00 00 00 60'],
        ['13:28:40.080', 'rx', '23 13 ff 00 00 00 23 d4 9f 31 00 00 00 00 00 00 00 00 fc'],
        ['13:28:40.807', 'rx', '10 0e ff 01 02 21 20 01 f5 01 f3 00 f1 3c'],
      ]),
    },
  },
};
