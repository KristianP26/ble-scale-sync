import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';

/**
 * Renpho ES-WBE28 sessions: vendor handshake on 0xFFE2, UCP consent, profile
 * writes, then the 0x2A9D/0x2A9C subscribes, and the weigh-in held up to 8 s
 * for the impedance.
 *
 * The two real frames are the ones in tests/scales/renpho.test.ts, from the
 * #267 btsnoop of the physical scale: weight frame 1374 (94.9 kg, SIG Date
 * Time 2026-07-04 12:26:06) and body-composition packet 2, frame 1477
 * (332.8 ohm). Their spacing is not in the repo, so every trace that uses
 * them is `derived`. The clock is the capture's local time, so the stamp
 * reads as live in any zone. The device exposes every characteristic the
 * #267 capture lists; nothing depends on the address.
 */

const WSS = '4e6a07ea0707040c1a06aa00000000';
const BCS_PACKET2 = '0c02f901f70144000dec00a500290091020600';
// WSS without its flags' time bit: 94.9 kg, no SIG Date Time.
const WSS_NO_TIME = '006a07';

const traces: Record<string, Trace> = {
  'wbe28-live-weigh-in': {
    provenance: 'derived',
    source: '#267 capture frames 1374 and 1477 (tests/scales/renpho.test.ts); spacing invented',
    steps: [
      { atMs: 1000, dir: 'rx', uuid: '2a9d', hex: WSS },
      { atMs: 1500, dir: 'rx', uuid: '2a9c', hex: BCS_PACKET2 },
    ],
  },
  // A stored record is buffered as history, the impedance after it joins it
  // in place, and the disconnect hands it over (D027).
  'wbe28-stored-record': {
    provenance: 'derived',
    source: '#267 capture frames 1374 and 1477, the weight stamp day 04 -> 01 (three days old)',
    steps: [
      { atMs: 1000, dir: 'rx', uuid: '2a9d', hex: '4e6a07ea0707010c1a06aa00000000' },
      { atMs: 1500, dir: 'rx', uuid: '2a9c', hex: BCS_PACKET2 },
    ],
  },
  'wbe28-weight-only': {
    provenance: 'derived',
    source: '#267 capture frame 1374 alone: no impedance arrives, the hold ends weight-only',
    steps: [{ atMs: 1000, dir: 'rx', uuid: '2a9d', hex: WSS }],
  },
  'wbe28-imperial': {
    provenance: 'characterization',
    source: 'tests/scales/renpho.test.ts: flags 0x01, 2000 x 0.1 lb; UCP success first',
    steps: [
      { atMs: 300, dir: 'rx', uuid: '2a9f', hex: '200201' },
      { atMs: 1000, dir: 'rx', uuid: '2a9d', hex: '01d007' },
    ],
  },
  // A weight without a time is dated by the Time Stamp of the 0x2A9C packet.
  'wbe28-bcs-time-stamp': {
    provenance: 'characterization',
    source:
      'made up: 94.9 kg without time, then a 0x2A9C with Time Stamp 2026-07-04 12:26:08 ' +
      'and impedance 0x0d00 (flags 0x0202)',
    steps: [
      { atMs: 1000, dir: 'rx', uuid: '2a9d', hex: WSS_NO_TIME },
      { atMs: 1500, dir: 'rx', uuid: '2a9c', hex: '0202f901ea0707040c1a08000d' },
    ],
  },
  'wbe28-bcs-truncated': {
    provenance: 'characterization',
    source:
      'tests/scales/renpho.test.ts: a 0x2A9C whose flags claim body water and impedance ' +
      'that do not fit, after a UCP refusal (result 0x05)',
    steps: [
      { atMs: 300, dir: 'rx', uuid: '2a9f', hex: '200205' },
      { atMs: 1000, dir: 'rx', uuid: '2a9d', hex: WSS_NO_TIME },
      { atMs: 1500, dir: 'rx', uuid: '2a9c', hex: '00031201' },
    ],
  },
};

export const session: SessionFixture = {
  adapter: 'Renpho ES-WBE28',
  now: new Date(2026, 6, 4, 12, 26, 10).getTime(),
  chars: ['ffe1', 'ffe2', '2a9f', '2a9d', '2a9c', '2a8c', '2a8e', '2a85', '2a80', '2aff'],
  traces,
};
