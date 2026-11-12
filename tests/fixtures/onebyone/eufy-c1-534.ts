import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromSnoop, type SnoopLine } from '../../helpers/replay/trace.js';

/**
 * Eufy C1 (T9146) weigh-ins of #534 and #533: the 0xCF frames on FFF4. The real
 * frames are byte for byte from the two issues; the ones marked "Made up" are
 * not. Every frame was checked: byte [10] is the XOR of [0..9]. No address is
 * in any of them. The frames carry no time, so the F1 clock write in the
 * goldens is the harness clock (2026-01-01), not the reporter's.
 *
 * What the frames show (log, one scale, two weigh-ins):
 *  - [9] = 01 on every frame of the #534 session up to a silence of about 5 s,
 *    from the first frame on; then one frame with [9] = 00 and the impedance,
 *    7.988 s after the first. No other value was seen;
 *  - the silence is why the hold has to cover the gap: the latest frame is
 *    still a 01 one;
 *  - [1..2] of that frame read as an impedance with the x0.1 factor, inside the
 *    150-1200 ohm band; [5..7] mean nothing we know.
 *
 * The #534 weigh-in is `captured`, in full: every Notification fff4 line of the
 * session, from the reporter's comment of 2026-11-12, with the f1 00 ack at its
 * real offset (13.6 s before the first 0xCF frame, which keeps the hold windows
 * as the scale produced them). The #533 trace is `derived`: its times are made up.
 */

/** First frame of the #534 session: the scale reports the weight from stepping on. */
export const C1_STEP_ON = 'cf0000ae1a00000000017a';
/** The weight moves while the person settles. */
export const C1_SETTLING = 'cf0000801b000000000155';
/** The settled weight, still measuring ([9] = 01). */
export const C1_SETTLED = 'cf0000351b0000000001e0';
/** The frame with the impedance of #534: [9] = 00. */
export const C1_FINAL_534 = 'cf0212351bf2f771000085';
/** The first frame of #533 after the F1 write: already the final one. */
export const C1_FINAL_533 = 'cfe411351b1d1409000014';
/** The ack of the F1 clock write. */
export const C1_CLOCK_ACK = 'f100';

/** Made up: the settled weight with [9] = 00 and no impedance, a socks weigh-in. */
export const C1_SOCKS = 'cf0000351b0000000000e1';
/** Made up: step-off, a light frame and a lighter one, then 0 kg with [9] still 01. */
export const C1_STEP_OFF_A = 'cf000018100000000001c6';
export const C1_STEP_OFF_B = 'cf000036010000000001f9';
export const C1_EMPTY_MEASURING = 'cf000000000000000001ce';

/** Every Notification fff4 line of the #534 session of 2026-11-12 (UTC), as the reporter posted them. */
const C1_534_SESSION: SnoopLine[] = [
  ['18:11:13.957', 'rx', C1_CLOCK_ACK],
  ['18:11:27.531', 'rx', C1_STEP_ON],
  ['18:11:27.793', 'rx', C1_STEP_ON],
  ['18:11:28.056', 'rx', C1_SETTLING],
  ['18:11:28.281', 'rx', C1_SETTLED],
  ['18:11:28.544', 'rx', C1_SETTLED],
  ['18:11:28.807', 'rx', C1_SETTLED],
  ['18:11:29.031', 'rx', C1_SETTLED],
  ['18:11:29.294', 'rx', C1_SETTLED],
  ['18:11:29.519', 'rx', C1_SETTLED],
  ['18:11:29.781', 'rx', C1_SETTLED],
  ['18:11:30.044', 'rx', C1_SETTLED],
  ['18:11:30.268', 'rx', C1_SETTLED],
  ['18:11:30.494', 'rx', C1_SETTLED],
  ['18:11:35.519', 'rx', C1_FINAL_534],
];

/** Offset of the first 0xCF frame of the #534 session from the f1 00 ack, in ms. */
export const C1_534_FIRST_FRAME_MS = 13574;

const traces: SessionFixture['traces'] = {
  'eufy-c1-534-weigh-in': {
    provenance: 'captured',
    source:
      '#534 body and the reporter comment of 2026-11-12 19:37 UTC: every Notification fff4 line of the session of 18:11:13.957 UTC, f1 00 at its real offset, no frame left out',
    steps: fromSnoop(C1_534_SESSION),
  },
  'eufy-c1-533-final-frame': {
    provenance: 'derived',
    source:
      '#533 btmon: the F1 ack, then a final frame ([9] = 00, impedance) as the first one of the session; the times are made up',
    steps: [
      { atMs: 300, dir: 'rx', hex: C1_CLOCK_ACK },
      { atMs: 500, dir: 'rx', hex: C1_FINAL_533 },
    ],
  },
  'eufy-c1-534-step-off': {
    provenance: 'derived',
    source:
      'eufy-c1-534-weigh-in up to its frame at 18:11:30.494, then made-up step-off frames (lighter, lighter, 0 kg with [9] = 01 twice) and no final frame',
    steps: [
      ...fromSnoop(C1_534_SESSION.slice(0, -1)),
      { atMs: C1_534_FIRST_FRAME_MS + 3213, dir: 'rx', hex: C1_STEP_OFF_A },
      { atMs: C1_534_FIRST_FRAME_MS + 3463, dir: 'rx', hex: C1_STEP_OFF_B },
      { atMs: C1_534_FIRST_FRAME_MS + 3713, dir: 'rx', hex: C1_EMPTY_MEASURING },
      { atMs: C1_534_FIRST_FRAME_MS + 3963, dir: 'rx', hex: C1_EMPTY_MEASURING },
    ],
  },
};

export const session: SessionFixture = {
  adapter: '1byone (Eufy)',
  traces,
};
