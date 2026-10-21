import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';

/**
 * ES-CS20M on a unit without the AE00 pair (#376 and the renpho-escs20m
 * MB1 / R-A016 units): the kg command 0x90 [01 00 00 00] without response at
 * connect and once more on the first power-on frame.
 *
 * Frames byte for byte as in tests/scales/es-cs20m.test.ts:
 *  - #376 report (v1.24.0, ESPHome, public);
 *  - the zero-current session of the #376 unit from
 *    x55aa_recover_20260910_095524.log on renpho-escs20m issue #10;
 *  - MB1 and R-A016 frames from tests/test_x55aa_protocol.py in
 *    https://github.com/ronnnnnnnnnnnnn/renpho-escs20m.
 * None of those sources has usable timing, so the spacing is invented.
 */

const traces: Record<string, Trace> = {
  '376-v1.24-session': {
    provenance: 'derived',
    source: '#376 report frames (power-on, 103.50 kg settling, power-off); spacing invented',
    steps: [
      { atMs: 100, dir: 'rx', hex: '55aa11000a0101010000550000000072' },
      { atMs: 2000, dir: 'rx', hex: '55aa140007000000286e0000b0' },
      { atMs: 4000, dir: 'rx', hex: '55aa11000a0001010000550000000071' },
    ],
  },
  // Status 0x10 is a settling frame in zero-current mode: only the power-off completes.
  '376-zero-current': {
    provenance: 'derived',
    source: 'renpho-escs20m#10 recover log, the #376 unit; frames in log order, 200 ms apart',
    steps: [
      '55aa11000a0101010000440000000061',
      '55aa1400071000000424000052',
      '55aa1400071000000424000052',
      '55aa1400071000001da10000e8',
      '55aa14000710000026b1000001',
      '55aa14000710000027ba00000b',
      '55aa1400071000002738000089',
      '55aa1400071000002724000075',
      '55aa140007100000272e00007f',
      '55aa1400071000002738000089',
      '55aa14000710000027880000d9',
      '55aa1400071000002742000093',
      '55aa140007100000274c00009d',
      '55aa14000710000027a60000f7',
      '55aa14000710000027b0000001',
      '55aa14000710000027a60000f7',
      '55aa140007100000279c0000ed',
      ...Array<string>(16).fill('55aa14000710000027880000d9'),
      '55aa11000a0001010000440000000060',
    ].map((hex, i) => ({ atMs: 100 + i * 200, dir: 'rx' as const, hex })),
  },
  // The stored 0x15 record's resistance stays out of the live weigh-in.
  'mb1-stored-record': {
    provenance: 'derived',
    source: 'renpho-escs20m test_x55aa_protocol.py: MB1 power-on and 0x15, R-A016 0x11 final',
    steps: [
      { atMs: 100, dir: 'rx', hex: '55aa11000501010107001f' },
      { atMs: 300, dir: 'rx', hex: '55aa15000c000017cf0369000002670000db' },
      { atMs: 2000, dir: 'rx', hex: '55aa14000711000023b9000007' },
    ],
  },
  'r-a016-normal-final': {
    provenance: 'derived',
    source:
      'renpho-escs20m test_x55aa_protocol.py: R-A016 settling 0x10, then final 0x01 with 785 ohm',
    steps: [
      { atMs: 1000, dir: 'rx', hex: '55aa14000710000023b9000006' },
      { atMs: 1200, dir: 'rx', hex: '55aa14000701000023b903110b' },
    ],
  },
  // No guest profile went out, so the 0x18 is not taken (D046).
  'result-without-ae00': {
    provenance: 'derived',
    source: '#436 frames (0x18 [14..17] zeroed) on a unit without AE00',
    steps: [
      { atMs: 100, dir: 'rx', hex: '55aa11000a010201000000000000001e' },
      { atMs: 500, dir: 'rx', hex: '55aa14000700000036560000a6' },
      { atMs: 11000, dir: 'rx', hex: '55aa18000d0101090000365601d60000000092' },
      { atMs: 30000, dir: 'rx', hex: '55aa11000a000201000000000000001d' },
    ],
  },
};

export const session: SessionFixture = {
  adapter: 'ES-CS20M',
  traces,
};
