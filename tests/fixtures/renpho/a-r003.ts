import type { SessionFixture } from '../../helpers/replay/session.js';
import { AR003_CHARS, AR003_WEIGH_IN, AR003_WEIGH_IN_NOW } from '../../helpers/renpho-a-r003.js';

/**
 * The Renpho A-R003 of #507: one weigh-in after the consent, frames from
 * tests/helpers/renpho-a-r003.ts (a private DEBUG log, derived). The log has
 * no times on these lines, so the spacing is invented. It keeps the second
 * 0x2A9C packet within the 8 s hold that the first 0x2A9D arms, where the log
 * puts it: its Notification lines print only before the session resolves.
 * The device exposes the 27 characteristics of the issue body log.
 */
const f = AR003_WEIGH_IN;

export const session: SessionFixture = {
  adapter: 'Renpho ES-WBE28',
  now: AR003_WEIGH_IN_NOW,
  chars: AR003_CHARS,
  traces: {
    'ar003-507-weigh-in': {
      provenance: 'derived',
      source:
        'a private DEBUG log (#507, 2026-10-28), bytes rewritten as tests/helpers/renpho-a-r003.ts ' +
        'lists; spacing invented',
      steps: [
        { atMs: 200, dir: 'rx', uuid: 'ffe1', hex: f.vendorAck },
        { atMs: 300, dir: 'rx', uuid: '2a9f', hex: f.consentAccepted },
        ...[1000, 1300, 1600, 1900, 2200, 2500].map((atMs) => ({
          atMs,
          dir: 'rx' as const,
          uuid: '2a9d',
          hex: f.progress,
        })),
        { atMs: 2800, dir: 'rx', uuid: '2a9d', hex: f.final },
        { atMs: 3000, dir: 'rx', uuid: '2a9c', hex: f.bcsPacket1 },
        { atMs: 3100, dir: 'rx', uuid: '2a9c', hex: f.bcsPacket2 },
      ],
    },
  },
};
