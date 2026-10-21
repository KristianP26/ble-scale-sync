import type { SessionFixture } from '../../helpers/replay/session.js';
import type { SnoopLine } from '../../helpers/replay/trace.js';
import { P181, qnSteps } from './frames.js';

/**
 * #331, an Arboleaf on the 19-byte dialect (no AE00), 20-byte live frames and
 * the 8-electrode result block. Frames byte for byte from the #331 logs of one
 * reporter, who agreed to their use as test data, as
 * tests/scales/qn-va-eight.test.ts has them: the 2026-10-06 weigh-in measured
 * with the link up, 76.85 kg (attachment of comment 6019596187, which also
 * quotes the block inline). The timed log is an attachment, not fetched, so
 * the spacing is set by hand in the log's order. Rewritten: the MAC
 * (frames.ts). No options here; the variants are the arboleaf-r06-*.ts modules.
 */
const HANDSHAKE: readonly SnoopLine[] = [
  ['00:00:00.000', 'rx', '12 13 ff 01 00 00 00 00 02 15 0f 27 00 00 05 03 e0 6f c9'],
  ['00:00:00.300', 'rx', '14 0b ff 01 00 01 00 00 00 00 20'],
  ['00:00:00.550', 'rx', '21 05 ff 01 26'],
  ['00:00:00.830', 'rx', 'a1 06 02 01 01 ab'],
];

/** The result block: three 20-byte parts, 0x15 and 0x16. */
const BLOCK = [
  '10 14 01 02 31 1e 05 0c be 09 9e 0c 72 09 59 09 96 08 79 ec',
  '10 14 09 fa 32 08 ed 01 6a 02 52 0c be 09 9e 0c 72 09 59 5e',
  '10 14 09 96 33 08 79 09 fa 08 ed 01 74 01 4d 00 b4 00 00 e6',
  '15 10 ff 00 eb 02 4f 03 0b 06 30 06 c2 00 ba 26',
  '16 10 ff 00 00 2a 03 34 00 a1 02 12 03 99 04 db',
];

/** Measuring, stable, the scale's "no stored weigh-ins" answer, the result block. */
export const WEIGH_IN_R06: readonly SnoopLine[] = [
  ...HANDSHAKE,
  ['00:00:02.000', 'rx', '10 14 01 00 11 1e 05 00 00 00 00 00 00 00 00 00 00 00 00 59'],
  ['00:00:06.000', 'rx', '10 14 01 01 11 1e 05 00 00 00 00 00 00 00 00 00 00 00 00 5a'],
  ['00:00:09.000', 'rx', '23 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 23'],
  ...BLOCK.map((h, i): SnoopLine => [`00:00:12.${i}00`, 'rx', h]),
];

export const NOW_R06 = Date.parse('2026-10-06T15:10:52Z');

export const session: SessionFixture = {
  adapter: 'QN Scale',
  profile: P181,
  now: NOW_R06,
  persists: {
    keys: ['settled', 'reading', 'payload'],
    why: 'recentLiveResults (#331): a result block with no measurement before it that repeats a result published in the last 10 minutes is the same weigh-in handed over again and is dropped',
  },
  traces: {
    'r06-weigh-in': {
      provenance: 'derived',
      source: '#331 comment 6019596187 and its attachment; spacing set by hand',
      steps: qnSteps(WEIGH_IN_R06),
    },
    // The block alone, soon after the handshake: a weigh-in the scale finished
    // before the link came up. A fresh adapter publishes it; one that has
    // published 76.85 kg drops it as a repeat.
    'r06-block-without-measurement': {
      provenance: 'derived',
      source:
        '#331 comment 6019596187 and its attachment, live frames dropped; spacing set by hand',
      steps: qnSteps([
        ...HANDSHAKE,
        ...BLOCK.map((h, i): SnoopLine => [`00:00:01.${i}00`, 'rx', h]),
      ]),
    },
  },
};
