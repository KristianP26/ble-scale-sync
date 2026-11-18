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
 * #501, the 23:40 session of cs10g-501.ts, in a module of its own for its own
 * clock. No 0x12 in the whole session, so the fallback sends openScale's
 * frames for user slot 1, and the scale takes the ready-time A2 (`a3 04 01`).
 * Nothing answers the profile frame or START, and the session ends without a
 * weigh-in when the scale drops the link.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  profile: P180_501,
  chars: AE00_CHARS,
  now: NOW_501_2340,
  traces: {
    '501-cs10g-no-info-after-reading': {
      provenance: 'captured',
      source: '#501 issue body, DEBUG log 2026-10-25 23:40:16',
      steps: qnSteps(SESSION_501_2340).map((s) => ({
        ...s,
        atMs: s.atMs + SESSION_501_2340_START_MS,
      })),
      disconnectAtMs: SESSION_501_2340_DISCONNECT_MS,
    },
  },
};
