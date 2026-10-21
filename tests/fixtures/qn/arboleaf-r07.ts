import type { SessionFixture } from '../../helpers/replay/session.js';
import type { SnoopLine } from '../../helpers/replay/trace.js';
import { P181, qnSteps } from './frames.js';

/**
 * #331, the Arboleaf of arboleaf-r06.ts with `ble.qn_weight_ack: true`, the
 * 2026-10-07 session (attachment of comment 6045858322): the scale answers the
 * 0x22 with an 8-electrode stored record of a weigh-in 199 s before the
 * connect (76.55 kg at 19:57:25), then with this session's result block.
 * Frames byte for byte as tests/scales/qn-va-eight.test.ts has them (the
 * reporter agreed to their use as test data); the timed log is an attachment,
 * not fetched, so the spacing is set by hand in its order. Rewritten: the MAC
 * (frames.ts). The clock is the session's own 0x20 time. The block's BMI (23.1)
 * does not fit the 181 cm the profile frame sends, so the scale's own
 * composition is not used.
 */
const HANDSHAKE: readonly SnoopLine[] = [
  ['00:00:00.000', 'rx', '12 13 ff 01 00 00 00 00 02 15 0f 27 00 01 05 03 e0 6f ca'],
  ['00:00:00.300', 'rx', '14 0b ff 01 00 01 00 00 00 00 20'],
  ['00:00:00.550', 'rx', '21 05 ff 01 26'],
  ['00:00:00.830', 'rx', 'a1 06 02 01 01 ab'],
];

const STORED: readonly SnoopLine[] = [
  ['00:00:05.000', 'rx', '23 01 01 01 31 a5 60 59 32 1d e7 0e 3d 0c ad 0d e4 0c 54 40'],
  ['00:00:05.050', 'rx', '23 09 14 01 32 08 18 09 e2 08 f7 01 75 02 8d 00 00 00 00 82'],
  ['00:00:05.100', 'rx', '23 00 00 01 33 00 00 00 00 00 00 00 00 00 00 00 00 00 00 57'],
  ['00:00:05.150', 'rx', '24 13 ff 00 e7 00 00 00 00 00 00 00 00 00 00 00 00 00 1d'],
  ['00:00:05.200', 'rx', '25 0f ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
];

export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnWeightAck: true },
  profile: P181,
  now: Date.parse('2026-10-07T20:00:44Z'),
  persists: {
    keys: ['settled', 'reading', 'payload'],
    why: 'storedMark (dedupMark, #331): a stored record handed over once is never reported again, also in a later session',
  },
  traces: {
    'r07-stored-then-live': {
      provenance: 'derived',
      source: '#331 comment 6045858322 attachment; spacing set by hand',
      steps: qnSteps([
        ...HANDSHAKE,
        ...STORED,
        ['00:00:08.000', 'rx', '10 14 01 02 31 1d e7 0e 1e 0c 8e 0d bf 0c 2f 09 3f 08 4e c7'],
        ['00:00:08.050', 'rx', '10 14 09 6b 32 08 70 01 7c 02 88 0e 1e 0c 8e 0d bf 0c 2f 16'],
        ['00:00:08.100', 'rx', '10 14 09 3f 33 08 4e 09 6b 08 70 01 86 01 72 00 ae 00 00 89'],
        ['00:00:08.150', 'rx', '15 10 ff 00 e7 02 54 03 10 06 2f 06 c7 00 bb 31'],
        ['00:00:08.200', 'rx', '16 10 ff 00 00 2a 03 3a 00 9b 02 15 03 a9 04 ee'],
      ]),
    },
    // The stored record and nothing after it: the fresh record is held for a
    // live result that does not come, and goes out with its own time.
    'r07-stored-only': {
      provenance: 'derived',
      source: '#331 comment 6045858322 attachment, result block dropped; spacing set by hand',
      steps: qnSteps([...HANDSHAKE, ...STORED]),
    },
  },
};
