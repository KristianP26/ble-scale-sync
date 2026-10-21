import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromSnoop, type Trace, type TraceStep } from '../../helpers/replay/trace.js';
import {
  ALPHA_LOCK_D6,
  ALPHA_LOCK_D6_NO_IMPEDANCE,
  ALPHA_NO_WRITE,
  ALPHA_PLATEAU_THEN_LOCK,
  ALPHA_STORED,
  ISSUE_458_DUMP_1,
  ISSUE_458_DUMP_2,
  OPENSCALE_1358,
  parseDump,
} from '../../helpers/ac27-captures.js';

/**
 * AC 27 sessions from the captures in tests/helpers/ac27-captures.ts (sources
 * and redaction there), replayed with the #458 reporter's profile. The `tx`
 * lines are the vendor app's writes, kept for reference only. No MAC: the
 * sessions do not depend on the address, so the harness uses its fake one.
 */

/** #458 dump lines at their one-second timestamps. */
const fromDump = (text: string): TraceStep[] =>
  parseDump(text).map((f) => ({ atMs: f.atS * 1000, dir: 'rx', hex: f.frame.toString('hex') }));

const PR_1534 = 'openScale PR #1534';

const traces: Record<string, Trace> = {
  'issue-458-dump-1': {
    provenance: 'captured',
    source: '#458 comment 6087319348',
    steps: fromDump(ISSUE_458_DUMP_1),
  },
  'issue-458-dump-2': {
    provenance: 'captured',
    source: '#458 comment 6087548493',
    steps: fromDump(ISSUE_458_DUMP_2),
  },
  'openscale-1358': {
    provenance: 'captured',
    source: 'openScale issue #1358 log',
    steps: fromSnoop(OPENSCALE_1358),
  },
  'alpha-no-write': {
    provenance: 'captured',
    source: `${PR_1534} capture 2, 00:09:59`,
    steps: fromSnoop(ALPHA_NO_WRITE),
  },
  'alpha-no-write-dropped-in-hold': {
    provenance: 'derived',
    source: `${PR_1534} capture 2, 00:09:59; link dropped at the last frame, inside the hold`,
    steps: fromSnoop(ALPHA_NO_WRITE),
    disconnectAtMs: 6220,
  },
  'alpha-plateau-then-lock': {
    provenance: 'captured',
    source: `${PR_1534} capture 2, 00:13:58`,
    steps: fromSnoop(ALPHA_PLATEAU_THEN_LOCK),
  },
  'alpha-lock-d6-no-impedance': {
    provenance: 'captured',
    source: `${PR_1534} capture 1, 23:32:04`,
    steps: fromSnoop(ALPHA_LOCK_D6_NO_IMPEDANCE),
  },
  'alpha-lock-d6': {
    provenance: 'captured',
    source: `${PR_1534} capture 1, 23:49:28`,
    steps: fromSnoop(ALPHA_LOCK_D6),
  },
  'alpha-stored': {
    provenance: 'captured',
    source: `${PR_1534} capture 2, 00:08:31`,
    steps: fromSnoop(ALPHA_STORED),
  },
};

export const session: SessionFixture = {
  adapter: 'Active Era BS-06',
  profile: { height: 175, age: 49, gender: 'male', isAthlete: false },
  traces,
};
