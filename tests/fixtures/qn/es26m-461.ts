import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';
import { AE00_CHARS, ADDRESS, qnSteps } from './frames.js';

/**
 * #461, a Physiq on the 18-byte dialect with AE00, v1.31.0 without options:
 * the DEBUG log in the issue body, session of 2026-10-10 09:23:03 (every
 * `Notification` line). The scale refuses openScale's profile frame, answers
 * five 0x22 with "no stored weigh-ins" and the sixth with the weigh-in, 71.65
 * kg at 09:23:19, R50 4303. Its advertisement (09:23:01) flags the resistance
 * scrambled. Rewritten: the MAC (frames.ts). The clock starts at the first
 * notification.
 */
export const SESSION_461 = qnSteps([
  ['09:23:03.688', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 00 05 9f 32 2c'],
  ['09:23:03.929', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 00 05 9f 32 2c'],
  ['09:23:04.083', 'rx', '12 12 ff 01 00 00 00 00 02 13 07 16 00 00 05 9f 32 2c'],
  ['09:23:04.326', 'rx', '14 0b ff 01 00 01 09 03 00 00 2c'],
  ['09:23:04.423', 'rx', 'a3 04 01 a8'],
  ['09:23:04.427', 'rx', '00 83 6e 2e b4 73 1f b6 b6 a2 46 5a d3 a2 78 54 80'],
  ['09:23:04.520', 'rx', '02 70 61 73 73'],
  ['09:23:04.525', 'rx', '21 05 ff 01 26'],
  ['09:23:04.619', 'rx', 'a1 06 04 fc 01 a8'],
  ['09:23:04.813', 'rx', 'a1 06 02 01 00 aa'],
  ['09:23:05.302', 'rx', '23 14 ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['09:23:05.399', 'rx', '24 10 ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['09:23:05.545', 'rx', '25 0f ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['09:23:09.495', 'rx', '23 14 ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['09:23:09.641', 'rx', '24 10 ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['09:23:09.788', 'rx', '25 0f ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['09:23:12.810', 'rx', '23 14 ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['09:23:12.956', 'rx', '24 10 ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['09:23:13.103', 'rx', '25 0f ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['09:23:16.125', 'rx', '23 14 ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['09:23:16.271', 'rx', '24 10 ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['09:23:16.419', 'rx', '25 0f ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['09:23:19.440', 'rx', '23 14 ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 36'],
  ['09:23:19.586', 'rx', '24 10 ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['09:23:19.733', 'rx', '25 0f ff 00 00 00 00 00 00 00 00 00 00 00 00 33'],
  ['09:23:22.755', 'rx', '23 14 ff 01 01 f0 87 c0 5c 32 1b fd 10 cf 10 cd 00 00 00 d1'],
]);

/** The #461 advertisement: model 129, impedance scrambled. */
export const ADVERT_461 = {
  localName: 'QN-Scale',
  address: ADDRESS,
  serviceUuids: ['ffe0'],
  manufacturerData: { id: 0xffff, data: Buffer.from('08140100000100000000026108010015', 'hex') },
};

export const NOW_461 = Date.parse('2026-10-10T09:23:03.688Z');

const traces: Record<string, Trace> = {
  '461-stored-after-requeries': {
    provenance: 'captured',
    source: '#461 issue body, DEBUG log 2026-10-10 09:23:03',
    advert: ADVERT_461,
    steps: SESSION_461,
  },
  // Without the advertisement the record's 4303 is read unscrambled all the
  // same, as only a scrambled body gives it (D071).
  '461-stored-no-advert': {
    provenance: 'derived',
    source: '#461 issue body, DEBUG log 2026-10-10 09:23:03; advertisement dropped',
    steps: SESSION_461,
  },
};

export const session: SessionFixture = {
  adapter: 'QN Scale',
  chars: AE00_CHARS,
  now: NOW_461,
  traces,
};
