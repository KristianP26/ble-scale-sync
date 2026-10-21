import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromSnoop } from '../../helpers/replay/trace.js';
import { ISSUE_466_RAMP, ISSUE_466_REPEAT_1, OPENSCALE_1358 } from '../../helpers/ac27-captures.js';

/**
 * MGB (Swan/Icomon/YG) on FFB2. Its own frames have no capture: Frame1
 * (`ac 02|03 ff`, weight BE/10 at [12], fat BE/10 at [16]) and Frame2
 * (`01 00`, muscle, bone, water LE/10) are synthetic from
 * tests/scales/mgb.test.ts. The AC 27 traces are real captures of AC 27 scales
 * that reached this adapter (tests/helpers/ac27-captures.ts): it decodes none
 * of them and logs the force_scale_adapter hint once per session (#466).
 *
 * onConnected writes the date and time in LOCAL time (`fd`/`fc`), so these
 * goldens depend on the TZ the suite runs in; they were written with TZ=UTC.
 */
const FRAME1_FAT = 'ac03ff0000000000000000000320000000e10000'; // 80.0 kg, fat 22.5 %
const FRAME1_NO_FAT = 'ac03ff0000000000000000000320000000000000';
const FRAME2 = '01009001000023002602'; // muscle 40.0, bone 3.5, water 55.0

export const session: SessionFixture = {
  adapter: 'MGB (Swan/Icomon/YG)',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  now: Date.UTC(2026, 0, 15, 7, 30, 5),
  traces: {
    'mgb-composition-first': {
      provenance: 'characterization',
      source: 'mgb.test.ts: Frame2 before any weight, then Frame1 (0x02) with fat',
      steps: [
        { atMs: 500, dir: 'rx', hex: FRAME2 },
        { atMs: 1000, dir: 'rx', hex: 'ac02ff0000000000000000000320000000e10000' },
      ],
    },
    'mgb-weight-then-fat-in-hold': {
      provenance: 'characterization',
      source:
        'mgb.test.ts: Frame1 (0x03) without fat holds, a short frame is dropped, Frame1 with fat ends it',
      steps: [
        { atMs: 1000, dir: 'rx', hex: FRAME1_NO_FAT },
        { atMs: 1500, dir: 'rx', hex: 'ac02ff000000000000' },
        { atMs: 2000, dir: 'rx', hex: FRAME2 },
        { atMs: 3000, dir: 'rx', hex: FRAME1_FAT },
      ],
    },
    'mgb-weight-only-hold-expires': {
      provenance: 'characterization',
      source: 'mgb.test.ts: Frame1 without fat, the 8 s hold runs out (D028)',
      steps: [{ atMs: 1000, dir: 'rx', hex: FRAME1_NO_FAT }],
    },
    'mgb-ac27-openscale-1358': {
      provenance: 'captured',
      source: 'openScale issue #1358 log (ac27-captures.ts): an AC 27 scale under an MGB init',
      steps: fromSnoop(OPENSCALE_1358),
    },
    'mgb-ac27-issue-466': {
      provenance: 'derived',
      source:
        '#466 issue body D5 frames (ac27-captures.ts), 500 ms apart, the repeat sent three times',
      steps: [...ISSUE_466_RAMP, ISSUE_466_REPEAT_1, ISSUE_466_REPEAT_1, ISSUE_466_REPEAT_1].map(
        (f, i) => ({ atMs: 500 * (i + 1), dir: 'rx' as const, hex: f.toString('hex') }),
      ),
      disconnectAtMs: 6000,
    },
  },
};
