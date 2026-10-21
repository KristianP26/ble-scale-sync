import type { SessionFixture } from '../../helpers/replay/session.js';
import { qnSteps } from './frames.js';

/**
 * Sessions whose 0x12 never arrives, so the divisor is not known and the
 * fallback handshake runs two seconds in, on protocol byte 0xff. No options;
 * one configured user of 60-90 kg, which decides a weight in doubt (C-06).
 *
 * #336, an ES-CS20M (classic, 15-byte 0x12 with protocol byte 0x15, no AE00):
 * the failing session in the issue body, which logged one 0x14 and nothing
 * else before the scale dropped the link; no timestamps, spacing set by hand.
 * The clock is arbitrary: nothing these traces read depends on it.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { userWeights: [{ weight_range: { min: 60, max: 90 }, last_known_weight: null }] },
  now: Date.parse('2026-08-24T10:00:00Z'),
  traces: {
    '336-no-info-silent': {
      provenance: 'derived',
      source: '#336 issue body, failing session without timestamps; spacing set by hand',
      disconnectAtMs: 8000,
      steps: qnSteps([['00:00:00.000', 'rx', '14 0b 15 00 00 00 00 00 00 00 34']]),
    },
    // The #336 live frame (112.50 kg, R 513) at raw 832 instead, [10]
    // recomputed: 8.32 kg at /100, 83.2 kg at /10; the user's range picks
    // the second.
    'no-info-divisor-from-user': {
      provenance: 'derived',
      source: '#336 issue body frames, live weight [3..4] 2b f2 -> 03 40; spacing set by hand',
      steps: qnSteps([
        ['00:00:00.000', 'rx', '14 0b 15 00 00 00 00 00 00 00 34'],
        ['00:00:05.500', 'rx', '10 0b 15 03 40 01 02 01 01 f8 70'],
      ]),
    },
    // #213's 2026-06-12 stable frames without resistance (es26m-213-grace.ts)
    // with no 0x12 before them: without the dialect a weight-only stable
    // frame is never taken, as an impedance frame is expected to follow.
    'no-info-es30m-without-resistance': {
      provenance: 'derived',
      source: '#213 comment 4691542531, DEBUG log 2026-06-12 13:02:46; its 0x12 dropped',
      steps: qnSteps([
        ['13:02:46.285', 'rx', '14 0b ff 00 00 01 00 00 00 00 1f'],
        ['13:02:46.529', 'rx', '21 05 ff 01 26'],
        ['13:02:46.821', 'rx', 'a1 06 02 01 01 ab'],
        ['13:02:46.919', 'rx', '10 0e ff 01 00 21 4d 00 00 00 00 00 00 8c'],
        ['13:02:48.089', 'rx', '23 13 ff 00 00 00 0e fd 9c 31 00 00 00 00 00 00 00 00 0d'],
        ['13:02:50.772', 'rx', '10 0e ff 01 02 21 4d 00 00 00 00 00 00 8e'],
        ['13:02:51.260', 'rx', '10 0e ff 01 02 21 4d 00 00 00 00 00 00 8e'],
        ['13:02:51.796', 'rx', '10 0e ff 01 02 21 4d 00 00 00 00 00 00 8e'],
        ['13:02:52.283', 'rx', '10 0e ff 01 02 21 4d 00 00 00 00 00 00 8e'],
      ]),
    },
  },
};
