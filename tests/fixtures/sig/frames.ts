/**
 * SIG Weight Measurement (0x2A9D) and Body Composition Measurement (0x2A9C)
 * frames shared by the Standard GATT and Sanitas SBF72/73 fixtures, which
 * pair the two the same way (SigMeasurementPairing).
 *
 * Captured frames, as cited in tests/scales/standard-gatt.test.ts and
 * tests/scales/beurer-bf720.test.ts:
 *  - #168 openScale HCI snoop of a Beurer SIG scale: 79.96 kg for user 1, then
 *    fat 19.4 %, 452.0 ohm and no weight field.
 *  - #229 BF788 HCI snoop: 117.92 kg for user 1, and the zeroed composition
 *    stub 35 of its 36 composition frames were.
 * Rewritten: the 0x2A9D Time Stamp year 2026 (ea 07) is 2000 (d0 07), a clock
 * never set. A SIG stamp is local time and the harness does not pin the time
 * zone, so a trusted stamp would make `reading.timestamp` zone dependent;
 * 2000 is before MIN_TRUSTED_YEAR, so the reading has none. The stored-record
 * branch (stamp older than 5 minutes -> history) is not pinned for that reason.
 *
 * Characterization frames are built from the SIG layout, as the adapter tests
 * build them.
 */

export const WSS_168 = '0e783ed007050c12353601ee002607';
export const BCS_168 = '9803c200df1a9701cc2fca21a811';
export const WSS_229 = '0e205cd007070e1729200140018007';
export const BCS_229_ZEROED = '9803000096230000000000000000';

/** Flags 0x0600 (impedance, weight): fat 22.5 %, 500.0 ohm, 80.00 kg. */
export const BCS_WITH_WEIGHT = '0006e1008813803e';
/** Flags 0: fat 19.4 % and nothing else, no weight. */
export const BCS_FAT_ONLY = '0000c200';
/** Weight 0xFFFF, "Measurement Unsuccessful". */
export const WSS_UNSUCCESSFUL = '00ffff';
/** Flags 0x01 (pounds): 176.37 lb = 80.00 kg. */
export const WSS_LB = '01e544';

export const WSS = '2a9d';
export const BCS = '2a9c';

export const at = (atMs: number, uuid: string, hex: string) => ({
  atMs,
  dir: 'rx' as const,
  uuid,
  hex,
});
