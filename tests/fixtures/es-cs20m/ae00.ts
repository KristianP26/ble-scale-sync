import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromSnoop, type Trace } from '../../helpers/replay/trace.js';

/**
 * ES-CS20M on a unit with the JieLi AE00 pair (#436): nothing at connect, the
 * Renpho app's 0x91, 0x97, 0x96, 0x90 after every power-on frame, and the
 * accepted 0x18 result held until the power-off (D046).
 *
 * The #436 traces are the Notification lines of the reporter's public DEBUG
 * logs (ESPHome proxy, v1.31.0), with their timing. Rewritten, as in
 * tests/scales/es-cs20m.test.ts: in every 0x18 the scale's BMI and body fat
 * [14..17] are zeroed and the checksum recomputed (health values the adapter
 * does not read). Weight and resistance are as received. The address in
 * those logs is not used; the session does not read it. The profile is made
 * up, with a birth date so the 0x96 does not depend on the clock's year.
 */

const POWER_ON = '55aa11000a010201000000000000001e'; // lb on the display
const POWER_OFF = '55aa11000a000201000000000000001d';
const REPLY_17 = '55aa17000201011a';
const REPLY_16 = '55aa160001091f';
const W_139_10 = '55aa14000700000036560000a6';
const W_136_40 = '55aa1400070000003548000097';
const RESULT_470 = '55aa18000d0101090000365601d60000000092';

const traces: Record<string, Trace> = {
  '436-socks': {
    provenance: 'derived',
    source: '#436 comment 6073310202 (2026-10-08 21:48), 0x18 [14..17] zeroed',
    steps: fromSnoop([
      ['21:48:21.757', 'rx', POWER_ON],
      ['21:48:22.079', 'rx', REPLY_17],
      ['21:48:22.218', 'rx', REPLY_16],
      ['21:48:22.371', 'rx', '55aa14000700000036600000b0'],
      ['21:48:22.472', 'rx', '55aa1000010111'],
      ['21:48:22.520', 'rx', '55aa14000700000036600000b0'],
      ['21:48:22.682', 'rx', '55aa14000700000036600000b0'],
      ['21:48:22.883', 'rx', '55aa14000700000036600000b0'],
      ['21:48:26.899', 'rx', '55aa18000d01010900003660000000000000c5'],
      ['21:48:46.662', 'rx', POWER_OFF],
    ]),
  },
  // The scale never sent the power-off: the 30 s hold completes it.
  '436-barefoot-no-power-off': {
    provenance: 'derived',
    source: '#436 comment 6112383314, first session (2026-10-11 18:35), 0x18 [14..17] zeroed',
    steps: fromSnoop([
      ['18:35:58.267', 'rx', POWER_ON],
      ['18:35:58.590', 'rx', REPLY_17],
      ['18:35:58.803', 'rx', REPLY_16],
      ['18:35:58.803', 'rx', W_139_10],
      ['18:35:58.978', 'rx', '55aa14000700000036600000b0'],
      ['18:35:59.075', 'rx', '55aa1000010111'],
      ['18:35:59.175', 'rx', '55aa14000700000036600000b0'],
      ['18:35:59.312', 'rx', W_139_10],
      ['18:36:10.134', 'rx', RESULT_470],
    ]),
  },
  '436-barefoot-power-off': {
    provenance: 'derived',
    source: '#436 comment 6112383314, second session (2026-10-11 18:38), 0x18 [14..17] zeroed',
    steps: fromSnoop([
      ['18:38:44.346', 'rx', POWER_ON],
      ['18:38:44.652', 'rx', REPLY_17],
      ['18:38:44.760', 'rx', REPLY_16],
      ['18:38:44.875', 'rx', W_136_40],
      ['18:38:44.962', 'rx', '55aa1000010111'],
      ['18:38:44.963', 'rx', '55aa14000700000036c4000014'],
      ['18:38:45.151', 'rx', '55aa140007000000358e0000dd'],
      ['18:38:45.388', 'rx', '55aa14000700000037500000a1'],
      ['18:38:45.491', 'rx', '55aa14000700000035d4000023'],
      ['18:38:45.691', 'rx', '55aa140007000000369c0000ec'],
      ['18:38:45.781', 'rx', '55aa1400070000003732000083'],
      ['18:38:46.322', 'rx', '55aa14000700000035d4000023'],
      ['18:38:46.324', 'rx', '55aa140007000000367e0000ce'],
      ['18:38:46.328', 'rx', '55aa14000700000036740000c4'],
      ['18:38:46.495', 'rx', '55aa14000700000036740000c4'],
      ['18:38:46.687', 'rx', '55aa14000700000036e2000032'],
      ['18:38:46.803', 'rx', '55aa14000700000035b6000005'],
      ['18:38:47.028', 'rx', '55aa14000700000036920000e2'],
      ['18:38:47.302', 'rx', '55aa140007000000369c0000ec'],
      ['18:38:47.314', 'rx', W_139_10],
      ['18:38:47.521', 'rx', W_139_10],
      ['18:38:47.711', 'rx', '55aa140007000000369c0000ec'],
      ['18:38:47.826', 'rx', W_139_10],
      ['18:38:48.033', 'rx', W_139_10],
      ['18:38:48.242', 'rx', W_139_10],
      ['18:38:48.338', 'rx', W_139_10],
      ['18:38:48.481', 'rx', W_139_10],
      ['18:38:48.684', 'rx', W_139_10],
      ['18:38:48.856', 'rx', W_139_10],
      ['18:38:56.430', 'rx', '55aa18000d0101090000365601940000000050'],
      ['18:39:19.352', 'rx', POWER_OFF],
    ]),
  },
  // Each 0x18 below fails one check and leaves the weigh-in to the power-off.
  '436-result-slot-0': {
    provenance: 'derived',
    source: '#436 frames, RESULT_470 with the slot [7] set to 0 (tests/scales/es-cs20m.test.ts)',
    steps: [
      { atMs: 0, dir: 'rx', hex: POWER_ON },
      { atMs: 500, dir: 'rx', hex: W_139_10 },
      { atMs: 11000, dir: 'rx', hex: '55aa18000d0101000000365601d60000000089' },
      { atMs: 30000, dir: 'rx', hex: POWER_OFF },
    ],
  },
  '436-result-not-this-weight': {
    provenance: 'derived',
    source: '#436 frames: a 136.40 kg weight frame, then the 139.10 kg result',
    steps: [
      { atMs: 0, dir: 'rx', hex: POWER_ON },
      { atMs: 500, dir: 'rx', hex: W_136_40 },
      { atMs: 11000, dir: 'rx', hex: RESULT_470 },
      { atMs: 30000, dir: 'rx', hex: POWER_OFF },
    ],
  },
  // Weight frames after the accepted 0x18 do not replace it.
  '436-weight-after-result': {
    provenance: 'derived',
    source: '#436 frames, a weight frame moved after the result',
    steps: [
      { atMs: 0, dir: 'rx', hex: POWER_ON },
      { atMs: 500, dir: 'rx', hex: W_139_10 },
      { atMs: 11000, dir: 'rx', hex: RESULT_470 },
      { atMs: 12000, dir: 'rx', hex: W_136_40 },
      { atMs: 30000, dir: 'rx', hex: POWER_OFF },
    ],
  },
  // A power-off re-arms the app sequence: the second power-on gets it again.
  '436-two-power-ons': {
    provenance: 'derived',
    source: '#436 frames: the scale woken twice in one connection',
    steps: [
      { atMs: 0, dir: 'rx', hex: POWER_ON },
      { atMs: 5000, dir: 'rx', hex: POWER_OFF },
      { atMs: 8000, dir: 'rx', hex: POWER_ON },
      { atMs: 8500, dir: 'rx', hex: W_139_10 },
      { atMs: 20000, dir: 'rx', hex: POWER_OFF },
    ],
  },
};

export const session: SessionFixture = {
  adapter: 'ES-CS20M',
  profile: {
    height: 180,
    age: 30,
    gender: 'male',
    isAthlete: false,
    birthDate: '1996-03-15',
    lastKnownWeight: 80,
  },
  chars: ['2a10', '2a11', 'ae01', 'ae02'],
  identityBound:
    'A-02, an accepted 0x18 reading is tracked in a WeakSet (es-cs20m.ts resultReadings), ' +
    'so a copy loses its BIA body fat',
  traces,
};
