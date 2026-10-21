import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, ADDRESS, P182_ATHLETE, qnSteps } from './frames.js';

/**
 * #463, the #461 Physiq with `ble.qn_user_key: 1000`: the DEBUG log of comment
 * 6297779708, session of 2026-10-20 17:58:11 (every `Notification` line). The
 * 0x22 goes out as the scale accepts the profile, and the answer is a weigh-in
 * kept for no user (slot 0xf0) from 17:58:08, 4 s before the connection: this
 * session's weigh-in, 71.10 kg, R50 4329 unscrambled with the advertisement's
 * flag (17:57:58). Rewritten: the MAC (frames.ts); the record carries no body
 * fat.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnUserKey: 1000 },
  profile: P182_ATHLETE,
  chars: AE00_CHARS,
  now: Date.parse('2026-10-20T17:58:11.552Z'),
  traces: {
    '463-1758-fresh-record': {
      provenance: 'captured',
      source: '#463 comment 6297779708, DEBUG log 2026-10-20 17:58:11',
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
        ['17:58:11.552', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 04 05 9f 32 30'],
        ['17:58:11.732', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 04 05 9f 32 30'],
        ['17:58:11.928', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 04 05 9f 32 30'],
        ['17:58:12.073', 'rx', '14 0b ff 01 00 01 09 03 00 00 2c'],
        ['17:58:12.171', 'rx', '00 d3 76 d8 39 2f ab 02 ca ca 14 93 4a 3e 9d 1a 5d'],
        ['17:58:12.268', 'rx', '02 70 61 73 73'],
        ['17:58:12.317', 'rx', '21 05 ff 01 26'],
        ['17:58:12.609', 'rx', 'a1 06 02 01 01 ab'],
        ['17:58:12.951', 'rx', '23 14 ff 01 01 f0 30 68 6a 32 1b c6 10 e9 10 cf 00 00 00 15'],
      ]),
    },
  },
};
