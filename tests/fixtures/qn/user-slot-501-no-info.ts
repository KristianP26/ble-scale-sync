import type { SessionFixture } from '../../helpers/replay/session.js';
import { AE00_CHARS, qnSteps } from './frames.js';
import {
  NOW_501_2340,
  P180_501,
  SESSION_501_2340,
  SESSION_501_2340_DISCONNECT_MS,
  SESSION_501_2340_START_MS,
} from './cs10g-501.js';

/**
 * The #501 23:40 session without a 0x12 (cs10g-501-no-info.ts) replayed with
 * `ble.qn_user_key: 1000` and `ble.qn_user_slot: 2`, which it did not run.
 * Every frame and its time is as captured; the scale's `a3` now answers no
 * A2 of ours. Without a 0x12 nothing that names a user slot goes out: no A2,
 * no A00D frame and no 0x22, only the AE01 init, the 0x13, the 0x20, `pass`
 * and the answer to the AE00 challenge.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnUserKey: 1000, qnUserSlot: 2 },
  profile: P180_501,
  chars: AE00_CHARS,
  now: NOW_501_2340,
  traces: {
    '501-user-slot-2-no-info': {
      provenance: 'derived',
      source:
        '#501 issue body, DEBUG log 2026-10-25 23:40:16; replayed with ble.qn_user_key and ' +
        'ble.qn_user_slot 2',
      steps: qnSteps(SESSION_501_2340).map((s) => ({
        ...s,
        atMs: s.atMs + SESSION_501_2340_START_MS,
      })),
      disconnectAtMs: SESSION_501_2340_DISCONNECT_MS,
    },
  },
};
