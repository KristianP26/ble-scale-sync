import type { SessionFixture } from '../../helpers/replay/session.js';
import type { SnoopLine } from '../../helpers/replay/trace.js';
import { AE00_CHARS, qnSteps, splitB1 } from './frames.js';
import { P170_331, SESSION_331_1517 } from './cs10e-331.js';

/**
 * #501, D103: the #331 CS10E session of 15:17 (cs10e-331.ts) with its one-part
 * 119-byte 0xB1 cut into the three parts the CS10G sends (45, 45 and 39
 * bytes), the first at the captured time and the others 30 and 61 ms after it.
 * DERIVED: no scale was seen to send this split, and the CS10G parts of the
 * issue never came as a whole triple. It exercises the real session (hold,
 * join, release) with the profile frame the CS10E's options send.
 */
const lastLine = SESSION_331_1517[SESSION_331_1517.length - 1];
const record = Buffer.from(lastLine[2].replace(/ /g, ''), 'hex');

const [p1, p2, p3] = splitB1(record, [40, 40, 34]);
const hex = (b: Buffer): string => b.toString('hex');
const upToResult: readonly SnoopLine[] = SESSION_331_1517.slice(0, -1);

const joined: readonly SnoopLine[] = [
  ...upToResult,
  ['15:18:08.338', 'rx', hex(p1)],
  ['15:18:08.368', 'rx', hex(p2)],
  ['15:18:08.399', 'rx', hex(p3)],
];
const firstOnly: readonly SnoopLine[] = [...upToResult, ['15:18:08.338', 'rx', hex(p1)]];

export const session: SessionFixture = {
  adapter: 'QN Scale',
  profile: P170_331,
  config: { qnUserKey: 1000, qnConfigLong: true, qnTimeSyncLong: true, qnWeightAck: true },
  chars: AE00_CHARS,
  now: Date.parse('2026-11-04T15:17:48.728Z'),
  traces: {
    '501-split-b1-joined': {
      provenance: 'derived',
      source: '#331 CS10E session of 2026-11-04 15:17, its 0xB1 cut into three parts (D103)',
      steps: qnSteps(joined),
    },
    '501-split-b1-link-drop': {
      provenance: 'derived',
      source:
        '#331 CS10E session of 2026-11-04 15:17, its 0xB1 cut into three parts, only the ' +
        'first one received, the link drops 1 s later (D103)',
      steps: qnSteps(firstOnly),
      // 19610 ms to the first part (15:17:48.728 -> 15:18:08.338), plus 1 s.
      disconnectAtMs: 20_610,
    },
  },
};
