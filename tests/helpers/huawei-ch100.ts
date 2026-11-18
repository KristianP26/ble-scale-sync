import { uuid16 } from '../../src/scales/body-comp-helpers.js';

/**
 * The Huawei CH100 of #503, as node-ble reported it (#503).
 *
 * - CH100_PADDED_NAME: derived from the reporter's DEBUG log of 2026-11-01
 *   (v1.38.0, node-ble). It logged `CH100` followed by 15 spaces, 20
 *   characters in all, and the scale was then matched as Standard GATT instead
 *   of Huawei. Built from the observed length here, not copied from the log.
 * - CH100_SERVICES and CH100_CHARS: a SUBSET of the AH100 V1 capture of
 *   oliexdev/openScale#547 (issue body): the services it lists and the two
 *   vendor characteristics. SIG characteristics are left out, the capture's
 *   vendor app never touches them. That a CH100 has the same GATT is a
 *   hypothesis; that BlueZ showed it the SIG body composition service follows
 *   from the log line `Matched adapter: Standard GATT (BCS/WSS)`.
 */
export const CH100_PADDED_NAME = 'CH100' + ' '.repeat(15);

/** Primary services of the V1 capture (0x1800, 0x180A, 0x181B, 0x181D, 0x181C, 0x180F, 0x1805, 0xFAA0). */
export const CH100_SERVICES: string[] = [
  0x1800, 0x180a, 0x181b, 0x181d, 0x181c, 0x180f, 0x1805, 0xfaa0,
].map(uuid16);

/** The vendor write and notify characteristics (FAA1, FAA2). */
export const CH100_CHARS: string[] = [0xfaa1, 0xfaa2].map(uuid16);
