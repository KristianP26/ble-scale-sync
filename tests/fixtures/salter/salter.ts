import type { SessionFixture } from '../../helpers/replay/session.js';
import type { TraceStep } from '../../helpers/replay/trace.js';

/**
 * Salter SA00656-BK on FFC1. The scale only answers what it is asked, so each
 * trace is the reply chain to the writes the adapter makes: the sweep at 0 ms
 * (`0b 00`, `02`), then one reply per ack, 60 ms apart. The records, ping and
 * clock-write ack are the verbatim captures in tests/scales/salter.test.ts
 * (scratchpad client and iOS PacketLogger trace of the Salter Health app, no
 * issue); the clock replies and `08 <slot> <count>` answers are composed to
 * place each record at the age the trace is about. Only the first sweep is
 * answered; the 3 s re-sweeps go unanswered.
 */
const replies = (...hex: string[]): TraceStep[] =>
  hex.map((h, i) => ({ atMs: 60 * (i + 1), dir: 'rx', hex: h }));

const PING = '0b00';
const REC_897_SLOT2 = '0200fa148a6a81033801e40162012100f4063601';
const REC_74_SLOT6 = '06004c148a6a4a00000000000000000000000000';
const REC_888_SLOT7 = '070067148a6a78033501e50164012000ea063301';
const REC_886_POS0 = '0100d7048e6a76030401fe018c01220032070601';
const REC_892_POS1 = '010109078e6a7c030601fd018a01220039070801';
const REC_880_SLOT1 = '010083108a6a7003000000000000000000000000';
const SLOT0_UNSET = '0000ffffffffffff000000000000000000000000';

export const session: SessionFixture = {
  adapter: 'Salter',
  profile: { height: 183, age: 30, gender: 'male', isAthlete: false },
  traces: {
    'salter-sweep-newest-wins': {
      provenance: 'derived',
      source: 'salter.test.ts records in slots 2, 6, 7; clock 10 s after the newest (89.7 kg)',
      steps: replies(
        PING,
        '0204158a6a',
        '080000',
        '080100',
        '080201',
        REC_897_SLOT2,
        '080300',
        '080400',
        '080500',
        '080601',
        REC_74_SLOT6,
        '080701',
        REC_888_SLOT7,
      ),
    },
    'salter-backlog-slot': {
      provenance: 'derived',
      source:
        'salter.test.ts vendor-app pair (positions 1 and 0 of slot 1); clock 5 s after position 1',
      steps: replies(
        PING,
        '020e078e6a',
        '080000',
        '080102',
        REC_892_POS1,
        REC_886_POS0,
        '080200',
        '080300',
        '080400',
        '080500',
        '080600',
        '080700',
      ),
    },
    'salter-stale-and-future-records': {
      provenance: 'derived',
      source:
        'salter.test.ts: unset slot 0, a record 600 s old (slot 1), one 543 s ahead of the clock (slot 2)',
      steps: replies(
        PING,
        '02db128a6a',
        '080001',
        SLOT0_UNSET,
        '080101',
        REC_880_SLOT1,
        '080201',
        REC_897_SLOT2,
        '080300',
        '080400',
        '080500',
        '080600',
        '080700',
      ),
      disconnectAtMs: 4000,
    },
    'salter-unset-clock': {
      provenance: 'derived',
      source:
        'salter.test.ts: clock 28 s (new batteries) -> clock write -> `01 00`; slot 0 record restamped to the set clock',
      steps: replies(
        PING,
        '021c000000',
        '0100',
        '0201b95569',
        '080001',
        '000000b9556978033501e50164012000ea063301',
        '080100',
        '080200',
        '080300',
        '080400',
        '080500',
        '080600',
        '080700',
      ),
    },
    'salter-clock-write-not-taken': {
      provenance: 'derived',
      source:
        'salter.test.ts: the clock still reads 28 s after the write; walked anyway, no second write',
      steps: replies(PING, '021c000000', '0100', '021d000000', '080000', '080100'),
      disconnectAtMs: 2000,
    },
  },
};
