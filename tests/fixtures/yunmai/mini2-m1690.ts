import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromSnoop, type Trace } from '../../helpers/replay/trace.js';

/**
 * Yunmai Mini 2 (M1690) sessions (#474): GET_PROTOCOL_VERSION written every
 * 5 s without response, its 0x05 reply a status frame (D070), and the hold
 * decided by the final frame just parsed (D061, #406).
 *
 * Sources, all rewritten the way tests/scales/yunmai.test.ts and
 * tests/helpers/yunmai-m1690.ts rewrite them so the reporter's numbers stay
 * out of the repo:
 *  - #474 comment 6292365225 (DEBUG log 2026-10-20, ESPHome proxy): every live
 *    0x01 frame with its weight [8..9] set to 80.00 kg and the XOR recomputed;
 *    the final frame with user id, weight, resistance and body fat set to
 *    0x1234, 80.00 kg, 470 and 25.50 % and the XOR recomputed. Scale clock,
 *    status replies and timing as logged.
 *  - #474 comment 6292365225, the reconnect after it: the 0x05 replies alone,
 *    byte for byte.
 *  - the M1690 frames of tests/scales/yunmai.test.ts (#474 log 2026-10-18,
 *    derived there) and the length and version edits made from them there.
 * No address is used: the session does not read it.
 */

const FINAL = '0d1f140200000c51ef000012341f4001d609f6ea';
const NO_RESISTANCE = '0d1f140200000c51ef000012341f40000009f63d';
const LIVE_80 = '0d1f0b01000ed91b1f4086';

const traces: Record<string, Trace> = {
  '474-live-then-final': {
    provenance: 'derived',
    source:
      '#474 comment 6292365225 (2026-10-20 13:34:07 .. 13:34:16.820), personal values replaced',
    steps: fromSnoop([
      ['13:34:07.701', 'rx', LIVE_80],
      ['13:34:07.903', 'rx', LIVE_80],
      ['13:34:08.112', 'rx', '0d1f0b01000ed91c1f4081'],
      ['13:34:08.311', 'rx', '0d1f0b01000ed91c1f4081'],
      ['13:34:08.517', 'rx', '0d1f0b01000ed91c1f4081'],
      ['13:34:08.725', 'rx', '0d1f0b01000ed91c1f4081'],
      ['13:34:08.860', 'rx', '0d1f0b01000ed91c1f4081'],
      ['13:34:09.062', 'rx', '0d1f0b01000ed91d1f4080'],
      ['13:34:09.265', 'rx', '0d1f0b01000ed91d1f4080'],
      ['13:34:09.468', 'rx', '0d1f0b01000ed91d1f4080'],
      ['13:34:09.680', 'rx', '0d1f0b01000ed91d1f4080'],
      ['13:34:09.884', 'rx', '0d1f0b01000ed91d1f4080'],
      ['13:34:10.085', 'rx', '0d1f0b01000ed91e1f4083'],
      ['13:34:10.267', 'rx', '0d1f0b01000ed91e1f4083'],
      ['13:34:10.465', 'rx', '0d1f05051f'],
      ['13:34:10.491', 'rx', '0d1f0b01000ed91e1f4083'],
      ['13:34:10.684', 'rx', '0d1f0b01000ed91e1f4083'],
      ['13:34:10.874', 'rx', '0d1f0b01000ed91e1f4083'],
      ['13:34:14.969', 'rx', '0d1f05051f'],
      ['13:34:15.079', 'rx', '0d1f0b01000ed9231f40be'],
      ['13:34:15.275', 'rx', '0d1f0b01000ed9231f40be'],
      ['13:34:15.487', 'rx', '0d1f0b01000ed9231f40be'],
      ['13:34:15.687', 'rx', '0d1f0b01000ed9231f40be'],
      ['13:34:15.890', 'rx', '0d1f0b01000ed9231f40be'],
      ['13:34:16.029', 'rx', '0d1f0b01000ed9241f40b9'],
      ['13:34:16.233', 'rx', '0d1f0b01000ed9241f40b9'],
      ['13:34:16.434', 'rx', '0d1f0b01000ed9241f40b9'],
      ['13:34:16.820', 'rx', '0d1f140200000ed924000012341f4001d609f6ab'],
    ]),
  },
  // After a weigh-in the scale answers each unlock and sends nothing else.
  '474-replies-only': {
    provenance: 'captured',
    source: '#474 comment 6292365225, the reconnect at 2026-10-20 13:34:19 (first six replies)',
    steps: fromSnoop([
      ['13:34:19.887', 'rx', '0d1f05051f'],
      ['13:34:24.904', 'rx', '0d1f05051f'],
      ['13:34:29.919', 'rx', '0d1f05051f'],
      ['13:34:34.937', 'rx', '0d1f05051f'],
      ['13:34:39.954', 'rx', '0d1f05051f'],
      ['13:34:44.971', 'rx', '0d1f05051f'],
    ]),
  },
  'm1690-hold-then-resistance': {
    provenance: 'derived',
    source:
      'tests/ble/shared.test.ts #474: a final with its resistance zeroed, the full one 3 s later',
    steps: [
      { atMs: 500, dir: 'rx', hex: NO_RESISTANCE },
      { atMs: 3500, dir: 'rx', hex: FINAL },
    ],
  },
  'm1690-hold-expiry': {
    provenance: 'derived',
    source: 'tests/scales/yunmai.test.ts M1690_NO_RESISTANCE alone: the 4 s hold ends weight-only',
    steps: [{ atMs: 500, dir: 'rx', hex: NO_RESISTANCE }],
  },
  'm1690-no-user': {
    provenance: 'derived',
    source: 'tests/scales/yunmai.test.ts M1690_NO_USER: user id 0 is still a weigh-in',
    steps: [{ atMs: 500, dir: 'rx', hex: '0d1f140200000c51e8000000001d4c020809608e' }],
  },
  // [2] does not match the length: weight only, no hold.
  'm1690-declares-19': {
    provenance: 'characterization',
    source: 'tests/scales/yunmai.test.ts M1690_DECLARES_19',
    steps: [{ atMs: 500, dir: 'rx', hex: '0d1f130200000c51ef000012341f4001d609f6ed' }],
  },
  // 19 bytes: resistance, no body fat field.
  'm1690-19-bytes': {
    provenance: 'characterization',
    source: 'tests/scales/yunmai.test.ts M1690_19_BYTES',
    steps: [{ atMs: 500, dir: 'rx', hex: '0d1f130200000c51ef000012341f4001d6091b' }],
  },
  // Protocol 0x1D: the body fat field is not read below 0x1E.
  'm1690-proto-1d': {
    provenance: 'characterization',
    source:
      'tests/scales/yunmai.test.ts M1690_PROTO_1D, after a measuring-type and a zero-weight frame',
    steps: [
      { atMs: 300, dir: 'rx', hex: '0d1f140100000c51ef000012341f4001d609f6e9' },
      { atMs: 400, dir: 'rx', hex: '0d1f140200000c51ef00001234000001d609f6b5' },
      { atMs: 500, dir: 'rx', hex: '0d1d140200000c51ef000012341f4001d609f6e8' },
    ],
  },
};

export const session: SessionFixture = {
  adapter: 'Yunmai',
  traces,
};
