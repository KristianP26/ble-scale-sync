import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace, TraceStep } from '../../helpers/replay/trace.js';
import { REC_1, REC_2, REC_3, STATUS_DONE, STATUS_LOCKED, session as msc04 } from './r-msc04.js';

/**
 * Renpho R-MSC04 sessions with ble.rmsc04_profile_byte set (#434, D079): the
 * guest b2 carries the configured byte at [11], and the scale's body fat and
 * visceral fat are exported only when every gate passes.
 *
 * Sources:
 *  - #117 PacketLogger capture (public, 2026-07-08): the statuses, the 0x24 and
 *    the 0x25 record, shared with r-msc04.ts.
 *  - The scale's answers to our writes are constructed: an owner's DEBUG log on
 *    #434 (comment 6175828320) shows the scale answering our b2 "with 09" and
 *    our b3, before the 0x11 status, and the #117 capture's answers
 *    (55aa220002010125, 55aa220002050129) carry the seq of the write at [5].
 *    So 0x22 is 55aa22000200092c (seq 00, slot 09) and 0x23 55aa2300030107012e
 *    (seq 01). The second 0x11 (seq 04) is STATUS_DONE with another seq.
 * The profile byte 9e and the profile are made up (187 cm fits the record).
 * Nothing depends on the address, so the harness uses its fake one.
 */

const IND = '2a12';
const rx = (atMs: number, uuid: string, hex: string): TraceStep => ({ atMs, dir: 'rx', uuid, hex });

const REPLY_B2 = '55aa22000200092c';
const REPLY_B3 = '55aa2300030107012e';
const STATUS_DONE_AGAIN = '55aa20000504110100508a';

const traces: Record<string, Trace> = {
  'msc04-byte-weigh-in': {
    provenance: 'derived',
    source:
      'msc04-117-weigh-in of r-msc04.ts (#117 capture, second connection) with the ' +
      'constructed 0x22 answer to our b2 at 100 ms',
    steps: [...msc04.traces['msc04-117-weigh-in'].steps, rx(100, IND, REPLY_B2)].sort(
      (a, b) => a.atMs - b.atMs,
    ),
  },
  'msc04-byte-weight-locked': {
    provenance: 'derived',
    source:
      '#117 capture, second connection from weight locked on (the shape of the #434 sessions ' +
      'in comment 6175828320), with the constructed 0x22 and 0x23 answers before the 0x11',
    steps: [
      rx(0, IND, STATUS_LOCKED),
      rx(100, IND, REPLY_B2),
      rx(190, IND, REPLY_B3),
      rx(9630, IND, STATUS_DONE),
      rx(9765, IND, REC_1),
      rx(9856, IND, REC_2),
      rx(9945, IND, REC_3),
    ],
  },
  // A session that connects after the measurement finished: its record is the
  // reading (D057), but the 0x11 came before the scale answered our b2, so a
  // second 0x11 does not make the scale's figures ours.
  'msc04-byte-answer-after-complete': {
    provenance: 'derived',
    source:
      '#117 capture 0x11 status and record, the constructed 0x22 answer after it and a ' +
      'second 0x11 (seq 04); spacing as in msc04-no-final-record',
    steps: [
      rx(0, IND, STATUS_DONE),
      rx(100, IND, REPLY_B2),
      rx(200, IND, STATUS_DONE_AGAIN),
      rx(335, IND, REC_1),
      rx(426, IND, REC_2),
      rx(515, IND, REC_3),
    ],
  },
  'msc04-byte-no-answer': {
    provenance: 'derived',
    source: 'msc04-no-final-record of r-msc04.ts (#117 capture): the scale never answers our b2',
    steps: [
      rx(0, IND, STATUS_LOCKED),
      rx(9630, IND, STATUS_DONE),
      rx(9765, IND, REC_1),
      rx(9856, IND, REC_2),
      rx(9945, IND, REC_3),
    ],
  },
};

export const session: SessionFixture = {
  adapter: 'Renpho R-MSC04',
  profile: { height: 187, age: 30, gender: 'male', isAthlete: false },
  config: { rmsc04ProfileByte: '9e' },
  traces,
};
