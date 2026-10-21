import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, ADDRESS, P182_ATHLETE, qnSteps } from './frames.js';

/**
 * #463, the #461 Physiq with `ble.qn_user_key: 1000`: the DEBUG log of comment
 * 6220373939, session of 2026-10-13 18:03:57 (every `Notification` line). The
 * scale accepts the profile, measures, hands over a weigh-in it kept for user
 * slot 1 from 17:59:38 (259 s before), then sends this session's 71.60 kg. The
 * kept one goes out as history, the live one as the reading. Its
 * advertisement (18:03:55) flags the resistance scrambled.
 * Rewritten: the MAC (frames.ts), and the scale's own body fat zeroed with the
 * checksum recomputed, as tests/scales/qn-scale.test.ts has these frames: 0x23
 * [16..17], live 0x10 [11..12], and the record's 0x24/0x25 payload. Nothing
 * reads them.
 */
export const ADVERT_1013 = {
  localName: 'QN-Scale',
  address: ADDRESS,
  serviceUuids: ['ffe0'],
  manufacturerData: { id: 0xffff, data: Buffer.from('08140100010100000000026108010015', 'hex') },
};

export const SESSION_1013 = qnSteps([
  ['18:03:57.543', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 01 05 9f 32 2d'],
  ['18:03:57.737', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 01 05 9f 32 2d'],
  ['18:03:58.129', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 01 05 9f 32 2d'],
  ['18:03:58.275', 'rx', '14 0b ff 01 00 01 09 03 00 00 2c'],
  ['18:03:58.373', 'rx', '00 ec c2 03 cb d2 5a 98 42 fe ed 40 1d f8 b7 03 75'],
  ['18:03:58.519', 'rx', '02 70 61 73 73'],
  ['18:03:58.521', 'rx', '21 05 ff 01 26'],
  ['18:03:58.811', 'rx', 'a1 06 02 01 01 ab'],
  ['18:03:59.152', 'rx', '10 0f ff 01 01 1b f8 00 00 00 00 00 00 00 33'],
  ['18:03:59.592', 'rx', '10 0f ff 01 01 1b f8 00 00 00 00 00 00 00 33'],
  ['18:03:59.933', 'rx', '23 14 ff 01 01 01 0a 2e 61 32 1b f3 10 d9 10 fe 00 00 00 09'],
  ['18:04:00.080', 'rx', '24 10 ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['18:04:00.226', 'rx', '25 0f ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['18:04:00.907', 'rx', '10 0f ff 01 02 1b f8 10 fb 10 f9 00 00 00 48'],
]);

export const NOW_1013 = Date.parse('2026-10-13T18:03:57.543Z');

export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnUserKey: 1000 },
  profile: P182_ATHLETE,
  chars: AE00_CHARS,
  now: NOW_1013,
  persists: {
    keys: ['history'],
    why: 'storedMark (dedupMark, #463): a kept weigh-in reported once is never reported again, also in a later session',
  },
  traces: {
    '463-1013-kept-slot-1-then-live': {
      provenance: 'derived',
      source: '#463 comment 6220373939, DEBUG log 2026-10-13 18:03:57; body fat zeroed',
      advert: ADVERT_1013,
      steps: SESSION_1013,
    },
  },
};
