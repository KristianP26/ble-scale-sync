import type { SessionFixture } from '../../helpers/replay/session.js';

/**
 * An ES-WBE28 firmware without the vendor 0xFFE2 write and the profile
 * characteristics (#267 review): consent alone is written, then the
 * measurement subscribes. Frames as in es-wbe28.ts (#267 capture, spacing
 * invented), with the same capture-time clock.
 */
export const session: SessionFixture = {
  adapter: 'Renpho ES-WBE28',
  now: new Date(2026, 6, 4, 12, 26, 10).getTime(),
  chars: ['ffe1', '2a9f', '2a9d', '2a9c'],
  traces: {
    'wbe28-consent-only': {
      provenance: 'derived',
      source: '#267 capture frames 1374 and 1477 (tests/scales/renpho.test.ts); spacing invented',
      steps: [
        { atMs: 1000, dir: 'rx', uuid: '2a9d', hex: '4e6a07ea0707040c1a06aa00000000' },
        { atMs: 1500, dir: 'rx', uuid: '2a9c', hex: '0c02f901f70144000dec00a500290091020600' },
      ],
    },
  },
};
