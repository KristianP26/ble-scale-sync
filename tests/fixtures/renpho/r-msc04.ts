import type { SessionFixture } from '../../helpers/replay/session.js';
import { fromDebugLog, type Trace, type TraceStep } from '../../helpers/replay/trace.js';

/**
 * Renpho R-MSC04 sessions (#117, #265, #434). The adapter writes the guest b2
 * and the b3 clock at connect (BLE_RMSC04_HANDSHAKE unset = full, the only mode
 * a fixture can select) and acks every 0x20 status with b0.
 *
 * Sources:
 *  - #117 PacketLogger capture (public, 2026-07-08), the frames
 *    tests/scales/renpho-msc04.test.ts and tests/ble/shared.test.ts replay.
 *  - #434 DEBUG logs, comments 6046234181 and 6031390793: the Notification
 *    lines only, verbatim (they carry no address; the MAC and the
 *    manufacturer data elsewhere in those logs are left out).
 * The profile is made up (PROFILE_187 of the tests: the capture's record was
 * computed for a 187 cm profile). Nothing depends on the address, so the
 * harness uses its fake one.
 */

const IND = '2a12';
const NOTIFY = '2a10';
const rx = (atMs: number, uuid: string, hex: string): TraceStep => ({ atMs, dir: 'rx', uuid, hex });

// #117 capture: the 0x25 record of the second connection in its three fragments.
const REC_1 = 'ad040255aa2500240411000025530a00de0c200b';
const REC_2 = 'ae0401ef08e4092a00ae0ac10a9007e108250100';
const REC_3 = 'af0400ed011101b70008ea';
const FINAL_9555 = '55aa240006011100002553b3';
const STATUS_LOCKED = '55aa200005020901005080'; // state 0x09, 0 stored records
const STATUS_DONE = '55aa200005031101005089'; // state 0x11

const traces: Record<string, Trace> = {
  'msc04-117-weigh-in': {
    provenance: 'derived',
    source:
      '#117 capture, second connection (20:28:09.513 .. 20:28:30.363); spacing as captured ' +
      'from the 0x24 on, the frames before it compressed as in tests/ble/shared.test.ts',
    steps: [
      rx(0, IND, '55aa200005000101005076'),
      rx(0, NOTIFY, '55aa2100050100002558a3'),
      rx(270, NOTIFY, '55aa2100050100002558a3'),
      rx(540, IND, FINAL_9555),
      rx(6705, IND, STATUS_LOCKED),
      rx(16335, IND, STATUS_DONE),
      rx(16470, IND, REC_1),
      rx(16561, IND, REC_2),
      rx(16650, IND, REC_3),
    ],
  },
  'msc04-434-hold-expiry': {
    provenance: 'captured',
    source: '#434 comment 6046234181 (v1.31.0 DEBUG log, 2026-10-07 18:59)',
    steps: fromDebugLog(`
2026-10-07 18:59:33.177 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 23 1e 67]
2026-10-07 18:59:33.210 [BLE:debug] Notification 00002a1200001000800000805f9b34fb: [55 aa 20 00 05 00 01 01 02 46 6e]
2026-10-07 18:59:33.446 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 22 01 49]
2026-10-07 18:59:33.716 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 21 0c 53]
2026-10-07 18:59:33.975 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 20 80 c6]
2026-10-07 18:59:34.245 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 1d 10 53]
2026-10-07 18:59:34.515 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 1e d2 16]
2026-10-07 18:59:34.784 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 1f 86 cb]
2026-10-07 18:59:35.054 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 1f 4f 94]
2026-10-07 18:59:35.324 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 21 8e d5]
2026-10-07 18:59:35.594 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 21 89 d0]
2026-10-07 18:59:35.865 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 1f 9f e4]
2026-10-07 18:59:36.123 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 1f db 20]
2026-10-07 18:59:36.393 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 1f db 20]
2026-10-07 18:59:36.663 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 1f db 20]
2026-10-07 18:59:36.933 [BLE:debug] Notification 00002a1000001000800000805f9b34fb: [55 aa 21 00 05 01 00 00 1f db 20]
2026-10-07 18:59:37.215 [BLE:debug] Notification 00002a1200001000800000805f9b34fb: [55 aa 24 00 06 01 11 00 00 1f db 35]
`),
  },
  'msc04-434-status-only': {
    provenance: 'captured',
    source:
      '#434 comment 6031390793 (v1.31.0 DEBUG log, 2026-10-07 05:08), first connection; ' +
      'the link went at 05:08:44.900 per the same log',
    steps: fromDebugLog(`
2026-10-07 05:08:40.036 [BLE:debug] Notification 00002a1200001000800000805f9b34fb: [55 aa 20 00 05 00 01 01 01 46 6d]
2026-10-07 05:08:42.532 [BLE:debug] Notification 00002a1200001000800000805f9b34fb: [55 aa 20 00 05 01 09 01 01 46 76]
`),
    disconnectAtMs: 4864,
  },
  // D057: a session that connects after the weight locked gets no 0x24; the
  // record after 0x11 is the reading when the session started with 0 stored.
  'msc04-no-final-record': {
    provenance: 'derived',
    source:
      '#117 capture, second connection from weight locked on, its 0x24 left out: the shape ' +
      'of the #434 sessions in comment 6175828320',
    steps: [
      rx(0, IND, STATUS_LOCKED),
      rx(9630, IND, STATUS_DONE),
      rx(9765, IND, REC_1),
      rx(9856, IND, REC_2),
      rx(9945, IND, REC_3),
    ],
  },
  'msc04-stored-at-start-record': {
    provenance: 'derived',
    source:
      '#434 comment 6031390793 status (weight locked, 1 stored record), then the #117 ' +
      'capture statuses and record as above: a record without 0x24 after a start with stored records',
    steps: [
      rx(0, IND, '55aa200005010901014676'),
      rx(9630, IND, STATUS_DONE),
      rx(9765, IND, REC_1),
      rx(9856, IND, REC_2),
      rx(9945, IND, REC_3),
    ],
  },
  'msc04-117-history': {
    provenance: 'derived',
    source:
      '#117 capture, first connection: status with 3 stored records, a stored 0x26 record, ' +
      'the closing 0x04 status; spacing invented',
    steps: [
      rx(0, IND, '55aa20000500050103507d'),
      rx(500, IND, 'ad010255aa2600280111000005ad000025710a00'),
      rx(590, IND, 'ae0101e10c2f0bee090e095000b10acb0a8f0800'),
      rx(680, IND, 'af010008430100f0011201b500086a'),
      rx(2000, IND, '55aa20000504040100507d'),
    ],
  },
  'msc04-record-mismatch': {
    provenance: 'derived',
    source:
      '#434 0x24 at 81.55 kg (comment 6046234181) followed by the #117 record at 95.55 kg: ' +
      'a record that is not this weigh-in, ignored',
    steps: [
      rx(0, IND, '55aa240006011100001fdb35'),
      rx(6000, IND, STATUS_DONE),
      rx(6135, IND, REC_1),
      rx(6226, IND, REC_2),
      rx(6315, IND, REC_3),
    ],
  },
  // Each frame below is dropped: a bad checksum, a truncated frame, an
  // out-of-scope command, a live frame after the settled weight (stepping off)
  // and a record chain with its middle fragment missing.
  'msc04-dropped-frames': {
    provenance: 'characterization',
    source: 'tests/scales/renpho-msc04.test.ts frames (capture-based, edited there)',
    steps: [
      rx(0, NOTIFY, '55aa210005010000255da8'),
      rx(200, IND, '55aa240006011100002553b4'),
      rx(400, NOTIFY, '55aa24000601'),
      rx(600, NOTIFY, '55aa26000212346d'),
      rx(800, IND, FINAL_9555),
      rx(1000, NOTIFY, '55aa210005010000255da8'),
      rx(5000, IND, STATUS_DONE),
      rx(5135, IND, REC_1),
      rx(5300, IND, REC_3),
    ],
  },
};

export const session: SessionFixture = {
  adapter: 'Renpho R-MSC04',
  profile: { height: 187, age: 30, gender: 'male', isAthlete: false },
  traces,
};
