import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, qnSteps } from './frames.js';

/**
 * #213, the #253 unit (18-byte dialect), no options: the DEBUG log of comment
 * 4631363928, session of 2026-06-05 09:17:24 (every `QN RAW` line). The scale
 * answers the 0x22 with this session's weigh-in as a stored record, kept for
 * no user (slot 0xf0) 3 s before the connection, then with "no stored
 * weigh-ins", and drops the link; the next log line ("disconnected before
 * reading completed", the failure #213 is about) is at 09:17:33.663, which
 * bounds the drop. Today the record ends the session: 84.95 kg, R 504 as sent.
 * Rewritten: the MAC (frames.ts); the AE02 challenge kept once, as in
 * es26m-253.ts.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  chars: AE00_CHARS,
  now: Date.parse('2026-06-05T09:17:24.787Z'),
  traces: {
    '213-record-ends-session': {
      provenance: 'captured',
      source: '#213 comment 4631363928, DEBUG log 2026-06-05 09:17:24',
      disconnectAtMs: 8876,
      steps: qnSteps([
        ['09:17:24.787', 'rx', '12 12 ff 01 00 00 00 00 02 01 17 09 00 01 05 9f 30 1c'],
        ['09:17:24.981', 'rx', '12 12 ff 01 00 00 00 00 02 01 17 09 00 01 05 9f 30 1c'],
        ['09:17:25.318', 'rx', '14 0b ff 00 00 01 00 00 00 00 1f'],
        ['09:17:25.416', 'rx', 'a3 04 01 a8'],
        ['09:17:25.465', 'rx', '00 0e e1 87 91 ac 7e 3b 9f de c1 6f 75 29 28 3d a6'],
        ['09:17:25.513', 'rx', '21 05 ff 01 26'],
        ['09:17:25.611', 'rx', 'a1 06 04 fe 01 aa'],
        ['09:17:25.854', 'rx', 'a1 06 02 01 01 ab'],
        ['09:17:26.294', 'rx', '23 13 ff 01 01 f0 a1 50 b5 31 21 2f 01 f8 01 f6 00 00 3e'],
        ['09:17:26.781', 'rx', '23 13 ff 00 00 00 25 38 9a 31 00 00 00 00 00 00 00 00 5d'],
      ]),
    },
  },
};
