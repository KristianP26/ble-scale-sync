import type { SessionFixture } from '../../helpers/replay/session.js';
import type { TraceStep } from '../../helpers/replay/trace.js';
import {
  AR003_CHARS,
  AR003_COMPOSITION,
  AR003_LIVE,
  AR003_NO_COMPOSITION_PACKET2,
  AR003_OTHER_PROFILE_FINAL,
  AR003_WEIGH_IN,
  AR003_WEIGH_IN_NOW,
} from '../../helpers/renpho-a-r003.js';

/**
 * The Renpho A-R003 of #507, frames from tests/helpers/renpho-a-r003.ts
 * (private DEBUG logs, derived). The device exposes the 27 characteristics of
 * the issue body log.
 *
 * The 2026-10-28 log has no times on its lines, so the spacing of the weigh-in
 * traces is invented. It keeps the second 0x2A9C packet within the 8 s hold
 * that the first 0x2A9D arms, where the log puts it: its Notification lines
 * print only before the session resolves.
 */
const f = AR003_WEIGH_IN;

const rx = (atMs: number, uuid: string, hex: string): TraceStep => ({ atMs, dir: 'rx', uuid, hex });

/** The consent, six progress frames and the final 0x2A9D, then the two 0x2A9C packets. */
const weighIn = (final: string, packet1: string, packet2: string): TraceStep[] => [
  rx(200, 'ffe1', f.vendorAck),
  rx(300, '2a9f', f.consentAccepted),
  ...[1000, 1300, 1600, 1900, 2200, 2500].map((atMs) => rx(atMs, '2a9d', f.progress)),
  rx(2800, '2a9d', final),
  rx(3000, '2a9c', packet1),
  rx(3100, '2a9c', packet2),
];

/**
 * Stepping on after the connection, timed like the 2026-10-29 log relative to
 * the first weight above 0 (t0 = 1000 ms): rise and settle within 2.66 s, 2.76 s
 * of silence, then six 0x4E frames from t0 + 5.42 s to t0 + 7.88 s, the steps
 * of the log. That log ends 8.0 s after t0 with neither the final 0x2A9D nor a
 * 0x2A9C; their times here are made up, after t0 + 8.0 s.
 */
const stepOnAfterConnect: TraceStep[] = [
  rx(200, 'ffe1', f.vendorAck),
  rx(300, '2a9f', f.consentAccepted),
  ...[350, 600, 850].map((atMs) => rx(atMs, '2a9d', AR003_LIVE.empty)),
  rx(1000, '2a9d', AR003_LIVE.stepOn),
  ...AR003_LIVE.rising.map((hex, i) => rx(1200 + i * 250, '2a9d', hex)),
  ...[2230, 2540, 2800, 3050, 3290, 3660].map((atMs) => rx(atMs, '2a9d', AR003_LIVE.settled)),
  ...[6420, 6830, 7340, 7860, 8370, 8880].map((atMs) => rx(atMs, '2a9d', AR003_LIVE.measuring)),
  rx(9400, '2a9d', f.final),
  rx(9500, '2a9c', AR003_COMPOSITION.bcsPacket1),
  rx(9600, '2a9c', AR003_COMPOSITION.bcsPacket2),
];

const SOURCE_1028 =
  'a private DEBUG log (#507, 2026-10-28), bytes rewritten as tests/helpers/renpho-a-r003.ts ' +
  'lists; spacing invented';
const SOURCE_1029 =
  'the frame shapes of private DEBUG logs (#507, 2026-10-29), values made up as ' +
  'tests/helpers/renpho-a-r003.ts lists';

export const session: SessionFixture = {
  adapter: 'Renpho ES-WBE28',
  now: AR003_WEIGH_IN_NOW,
  chars: AR003_CHARS,
  traces: {
    'ar003-507-weigh-in': {
      provenance: 'derived',
      source: SOURCE_1028,
      steps: weighIn(f.final, f.bcsPacket1, f.bcsPacket2),
    },
    'ar003-507-scale-composition': {
      provenance: 'derived',
      source: `${SOURCE_1029}; spacing invented`,
      steps: weighIn(f.final, AR003_COMPOSITION.bcsPacket1, AR003_COMPOSITION.bcsPacket2),
    },
    'ar003-507-no-composition': {
      provenance: 'derived',
      source: `${SOURCE_1029}; spacing invented`,
      steps: weighIn(f.final, f.bcsPacket1, AR003_NO_COMPOSITION_PACKET2),
    },
    'ar003-507-other-profile': {
      provenance: 'derived',
      source: `${SOURCE_1029}, the final 0x2A9D echoing another profile; spacing invented`,
      steps: weighIn(
        AR003_OTHER_PROFILE_FINAL,
        AR003_COMPOSITION.bcsPacket1,
        AR003_COMPOSITION.bcsPacket2,
      ),
    },
    'ar003-507-step-on-after-connect': {
      provenance: 'derived',
      source: `${SOURCE_1029}; spacing of the 2026-10-29 log up to its end, then made up`,
      steps: stepOnAfterConnect,
    },
  },
};
