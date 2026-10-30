import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, ADDRESS, P182_ATHLETE, qnSteps } from './frames.js';

/**
 * #463, the #461 Physiq with `ble.qn_user_key: 1000`: the DEBUG log of comment
 * 6300071433, session of 2026-10-20 19:39:50 (every `Notification` line). The
 * scale measures, hands over a weigh-in it kept for no user (slot 0xf0) from
 * 19:28:16, eleven minutes before, and then sends this session's 72.55 kg.
 * The kept one goes out as history. The advertisement (19:39:47) carried no
 * manufacturer data, so R50 4317 is read unscrambled for its high byte
 * (D071). Rewritten: the MAC (frames.ts), and the scale's own body fat in the
 * final frame [11..12] zeroed with [14] recomputed, as
 * tests/scales/qn-scale.test.ts has it; nothing reads it.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnUserKey: 1000 },
  profile: P182_ATHLETE,
  chars: AE00_CHARS,
  now: Date.parse('2026-10-20T19:39:50.389Z'),
  persists: {
    keys: ['history'],
    why: 'storedMark (dedupMark, #463): a kept weigh-in reported once is never reported again, also in a later session',
  },
  traces: {
    '463-1939-kept-unassigned-then-live': {
      provenance: 'derived',
      source: '#463 comment 6300071433, DEBUG log 2026-10-20 19:39:50; body fat zeroed',
      advert: { localName: 'QN-Scale', address: ADDRESS, serviceUuids: ['ffe0'] },
      steps: qnSteps([
        ['19:39:50.389', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 04 05 9f 32 30'],
        ['19:39:50.698', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 04 05 9f 32 30'],
        ['19:39:50.844', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 04 05 9f 32 30'],
        ['19:39:51.283', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 04 05 9f 32 30'],
        ['19:39:51.379', 'rx', '14 0b ff 01 00 01 09 03 00 00 2c'],
        ['19:39:51.477', 'rx', '00 a0 1a 5c 1c 80 6a 70 71 d9 72 c0 86 14 e0 07 25'],
        ['19:39:51.574', 'rx', '02 70 61 73 73'],
        ['19:39:51.623', 'rx', '21 05 ff 01 26'],
        ['19:39:51.916', 'rx', 'a1 06 02 01 01 ab'],
        ['19:39:52.257', 'rx', '10 0f ff 01 01 1c 57 00 00 00 00 00 00 00 93'],
        ['19:39:52.648', 'rx', '23 14 ff 01 01 f0 50 7d 6a 32 1c 5c 10 cf 10 cd 00 00 00 c5'],
        ['19:39:52.795', 'rx', '24 10 ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
        ['19:39:52.941', 'rx', '25 0f ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
        ['19:39:53.185', 'rx', '10 0f ff 01 01 1c 57 00 00 00 00 00 00 00 93'],
        ['19:39:54.062', 'rx', '10 0f ff 01 02 1c 57 10 dd 10 db 00 00 00 6c'],
      ]),
    },
  },
};
