import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, ADDRESS, P182_ATHLETE, qnSteps } from './frames.js';

/**
 * #463, the #461 Physiq with `ble.qn_user_key: 1000`: the DEBUG log of comment
 * 6272500020, session of 2026-10-19 16:38:13 (every `Notification` line). The
 * scale accepts the profile and sends its final live frame 49 ms later,
 * before it has answered any 0x22. The log ends there, because that build
 * ended the session on it; today the weigh-in is held for the answer, which
 * never comes, and goes out when the wait runs out. The advertisement (16:38:11)
 * flags the resistance scrambled. Rewritten: the MAC (frames.ts); the final
 * frame carries no body fat.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnUserKey: 1000 },
  profile: P182_ATHLETE,
  chars: AE00_CHARS,
  now: Date.parse('2026-10-19T16:38:13.613Z'),
  traces: {
    '463-1019-final-before-answer': {
      provenance: 'captured',
      source: '#463 comment 6272500020, DEBUG log 2026-10-19 16:38:13',
      advert: {
        localName: 'QN-Scale',
        address: ADDRESS,
        serviceUuids: ['ffe0'],
        manufacturerData: {
          id: 0xffff,
          data: Buffer.from('08140100030100000000026108020015', 'hex'),
        },
      },
      steps: qnSteps([
        ['16:38:13.613', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 03 05 9f 32 2f'],
        ['16:38:13.807', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 03 05 9f 32 2f'],
        ['16:38:14.017', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 03 05 9f 32 2f'],
        ['16:38:14.163', 'rx', '14 0b ff 01 00 01 09 03 00 00 2c'],
        ['16:38:14.310', 'rx', '00 f1 6c 32 ab e3 0c 56 4e 3b 2e 99 3d 6f 6c 08 e8'],
        ['16:38:14.406', 'rx', '02 70 61 73 73'],
        ['16:38:14.412', 'rx', '21 05 ff 01 26'],
        ['16:38:14.699', 'rx', 'a1 06 02 01 01 ab'],
        ['16:38:14.748', 'rx', '10 0f ff 01 02 1b cb 10 db 10 d9 00 00 00 db'],
      ]),
    },
  },
};
