import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromSnoop } from '../../helpers/replay/trace.js';
import { ALPHA_HANDSHAKE } from '../../helpers/ac27-captures.js';

/**
 * The ALPHA handshake connection (openScale PR #1534, capture 2, 23:55:02)
 * with the fake profile its tester entered in FitDays and the clock FitDays
 * sent, so our D0 writes can be held against the captured `tx` lines.
 */
export const session: SessionFixture = {
  adapter: 'Active Era BS-06',
  profile: { height: 165, age: 31, gender: 'female', isAthlete: false },
  now: 0x6ab05637 * 1000,
  traces: {
    'alpha-handshake': {
      provenance: 'captured',
      source: 'openScale PR #1534 capture 2, 23:55:02',
      steps: fromSnoop(ALPHA_HANDSHAKE),
    },
  },
};
