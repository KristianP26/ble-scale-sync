import type { SessionFixture } from '../../helpers/replay/session.js';
import { qnSteps } from './frames.js';
import { LINES_283, NOW_283 } from './classic-283.js';

/**
 * The #283 session (classic-283.ts) with `ble.qn_report_byte: 254`: the A00D
 * user-delete frame with mask 0xfe goes out on the 0x21, as every build before
 * v1.32.0 sent it and as the #283 log shows it (`a0 0d 04 fe ...`, #461).
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnReportByte: 0xfe },
  now: NOW_283,
  traces: {
    'classic-283-report-byte': {
      provenance: 'derived',
      source: '#283 issue body, DEBUG log without timestamps; spacing set by hand',
      steps: qnSteps(LINES_283),
    },
  },
};
