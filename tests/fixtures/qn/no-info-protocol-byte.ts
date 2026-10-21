import type { SessionFixture } from '../../helpers/replay/session.js';
import { qnSteps } from './frames.js';

/**
 * #336, an ES-CS20M (classic, protocol byte 0x15, no AE00) whose 0x12 is lost,
 * with `ble.qn_protocol_byte: 21`, the reporter's fix: every write, the
 * unlock config and the fallback handshake included, carries 0x15, and the
 * scale streams. The ready frame is from the failing session in the issue
 * body, the live frame (112.50 kg, R 513) from the working one; no
 * timestamps, spacing set by hand. The clock is arbitrary.
 */
export const session: SessionFixture = {
  adapter: 'QN Scale',
  config: { qnProtocolByte: 0x15 },
  now: Date.parse('2026-08-24T10:00:00Z'),
  traces: {
    '336-protocol-byte-without-info': {
      provenance: 'derived',
      source: '#336 issue body, frames of two sessions without timestamps; spacing set by hand',
      steps: qnSteps([
        ['00:00:00.000', 'rx', '14 0b 15 00 00 00 00 00 00 00 34'],
        ['00:00:05.500', 'rx', '10 0b 15 2b f2 01 02 01 01 f8 4a'],
      ]),
    },
  },
};
