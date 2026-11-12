/**
 * #501, an Arboleaf CS10G on the 20-byte extended dialect over an ESP32
 * proxy: the 0xB1 parts the scale sends in three notifications (45, 45 and 39
 * bytes), byte for byte from the `QN RAW` lines of the reporter's public DEBUG
 * logs. The reporter agreed to the use of the logs on #501 (2026-11-12). The
 * `Notification` lines of those logs are cut at 32 bytes, so only the
 * `QN RAW` lines carry a whole part. Times are the log's own.
 *
 * Captured, every checksum valid and [1] the length of each part:
 * - PAIRS_501: the six parts 2 and 3 that came in single bursts of the log
 *   of 2026-11-09 (comment 6729985263), 00:38 to 01:03. The first part of
 *   those bursts is not in the log, so none of them is a whole triple.
 * - FIRST_PARTS_501: every first part the two logs hold (the second log is
 *   comment 6752711425, the evening of the same day). Neither log has the
 *   parts 2 and 3 of any of them.
 * - LIVE_FINAL_501: the stable live 0x10 frame of the sessions of the first
 *   log that have one, at the weight of the 00:40 weigh-in.
 * - VISIT_ACK_501: the scale's answer to the profile frame of user slot 2.
 *
 * Derived, never captured: COHERENT_501 and MIXED_501 put the first part of
 * one weigh-in together with parts 2 and 3 of another, to run the join and the
 * session with the real bytes. A derived triple says nothing about the order
 * or timing of the parts of one burst; the relations the tests check rest on
 * the captured parts.
 *
 * Rewritten: nothing. No 0xB1 part and no 0x10 frame holds the MAC or any
 * other identifier; the scale's 0x12 and advertisement, which echo the MAC,
 * are not in this module (a fixture that adds them rewrites the MAC as
 * frames.ts says). The values in the frames are the reporter's own: tests
 * compute from the bytes and never repeat them in prose.
 */

const LOG_1 = '#501 comment 6729985263, DEBUG log 2026-11-09';
const LOG_2 = '#501 comment 6752711425, DEBUG log 2026-11-09 (evening)';

const bytes = (hex: string): Buffer => Buffer.from(hex, 'hex');

/** Parts 2 and 3 of one burst, as logged. */
export interface PartsPair {
  provenance: 'captured';
  source: string;
  /** Log time of part 2 (date and time) and of part 3 (time). */
  at2: string;
  at3: string;
  p2: Buffer;
  p3: Buffer;
}

/** A first part, as logged. */
export interface FirstPart {
  provenance: 'captured';
  source: string;
  at: string;
  p1: Buffer;
}

/** A first part with parts 2 and 3 from another weigh-in. */
export interface Triple {
  provenance: 'derived';
  source: string;
  p1: Buffer;
  p2: Buffer;
  p3: Buffer;
}

const pair = (at2: string, at3: string, p2: string, p3: string): PartsPair => ({
  provenance: 'captured',
  source: LOG_1,
  at2,
  at3,
  p2: bytes(p2),
  p3: bytes(p3),
});

const first = (at: string, source: string, p1: string): FirstPart => ({
  provenance: 'captured',
  source,
  at,
  p1: bytes(p1),
});

/** Six pairs of parts 2 and 3, in log order. */
export const PAIRS_501: readonly PartsPair[] = [
  pair(
    '2026-11-09 00:38:25.245',
    '00:38:25.245',
    'b12d030200b600c7000001f8004202f9020730b106b7000028002103b00006025e030456674f0149684f0149fd',
    'b127030308ab020c674f0148654f01b95b4f01b55c4f011a078b036d5b4f0172594f01af0901b3',
  ),
  pair(
    '2026-11-09 00:39:28.241',
    '00:39:28.320',
    'b12d030200b600c7000001f8004202f9020730b106b7000028002103b00006025e030494674f0174684f014966',
    'b127030308a00208674f0125654f01f15b4f01dd5c4f011c078803715b4f0160594f01af0901d2',
  ),
  pair(
    '2026-11-09 00:41:27.922',
    '00:41:27.923',
    'b12d030200b600c7000001f8004202f9020730b106b7000028002103b00006025e03040c684e01c3684e014a2d',
    'b1270303088d0205674e01f0644e015e5c4e01295d4e0120078403805b4e014a594e01af090134',
  ),
  pair(
    '2026-11-09 00:55:03.348',
    '00:55:03.348',
    'b12d030200b700c7000001f8004202f9020730b206b7000028002103b10005025e0304a7684d012a694d014c32',
    'b1270303087602d2664d017f644d01eb5c4d018a5d4d0126077f036d5b4d0106594d01b009010b',
  ),
  pair(
    '2026-11-09 00:59:05.644',
    '00:59:05.645',
    'b12d030200b700c7000001f8004202f9020730b206b7000028002103b00006025e0304e7684d0159694d014da2',
    'b1270303086f02d0664d0174644d01275d4d01b65d4d0128077e03765b4d0108594d01af09016b',
  ),
  pair(
    '2026-11-09 01:02:58.909',
    '01:02:59.006',
    'b12d030200b700c7000001f8004202f9020730b206b7000028002103b10005025e03040a694d0171694d014dde',
    'b1270303086802b6664d014b644d01465d4d01cf5d4d0129077c03695b4d01ef584d01b0090132',
  ),
];

/** The four first parts of the two logs, in log order (the log of the comment 6729985263 first). */
export const FIRST_PARTS_501: readonly FirstPart[] = [
  first(
    '2026-11-09 00:40:28.020',
    LOG_1,
    'b12d030102551e2a0be709f70ac809310a2b09bb09c108aa006000620a3709760a4d094d0a25091a0aef08d44a',
  ),
  first(
    '2026-11-09 21:56:42.691',
    LOG_2,
    'b12d0301023c1eea0aca09160bec09a10a82093d0a2f09a60059008f0a6109990a6f094b0a2b090d0aeb08d555',
  ),
  first(
    '2026-11-09 21:57:10.422',
    LOG_2,
    'b12d0301023c1ef40acf092c0b000aa40a8609500a4009ac005f00920a65099d0a73094e0a2d090f0aee08d5df',
  ),
  first(
    '2026-11-09 21:57:57.547',
    LOG_2,
    'b12d0301023c1edf0ab709160beb09d10aa809270a2609a8005a00920a65099d0a73094e0a2d090f0aee08d589',
  ),
];

/**
 * The stable live frame (0x10, status 01) of the first log's sessions at
 * these log times, all the same bytes, at the weight of the 00:40 weigh-in.
 * User slot 2.
 */
export const LIVE_FINAL_501 = {
  provenance: 'captured' as const,
  source: LOG_1,
  at: [
    '2026-11-09 00:39:14.931',
    '2026-11-09 00:40:13.787',
    '2026-11-09 00:41:13.491',
    '2026-11-09 01:06:54.943',
  ],
  frame: bytes('10140201111e55000000000000000000000000ab'),
};

/**
 * The scale's answer to the profile frame of user slot 2 (`a1 06 02 02 01 ..`,
 * 6 bytes, [4] 01 accepted): the same bytes in every session of the first
 * log, the first at 00:38:12.551.
 */
export const VISIT_ACK_501 = {
  provenance: 'captured' as const,
  source: LOG_1,
  at: ['2026-11-09 00:38:12.551'],
  frame: bytes('a106020201ac'),
};

const pairAt = (at2: string): PartsPair => {
  const found = PAIRS_501.find((p) => p.at2 === at2);
  if (!found) throw new Error(`cs10g-501-parts: no pair of parts 2 and 3 at ${at2}`);
  return found;
};
const firstAt = (at: string): FirstPart => {
  const found = FIRST_PARTS_501.find((p) => p.at === at);
  if (!found) throw new Error(`cs10g-501-parts: no first part at ${at}`);
  return found;
};

const triple = (f: FirstPart, p: PartsPair, source: string): Triple => ({
  provenance: 'derived',
  source,
  p1: f.p1,
  p2: p.p2,
  p3: p.p3,
});

/**
 * The first part of the 00:40:28 weigh-in with parts 2 and 3 of the 00:41:27
 * one: the same user at the same stable weight, a minute apart. Its relations
 * hold, as they should for parts of two weigh-ins at one weight; it is not a
 * triple of one burst.
 */
export const COHERENT_501: Triple = triple(
  firstAt('2026-11-09 00:40:28.020'),
  pairAt('2026-11-09 00:41:27.922'),
  `${LOG_1}: first part of 00:40:28 with parts 2 and 3 of 00:41:27`,
);

/**
 * The first part of an evening weigh-in (another weight) with parts 2 and 3
 * of the 00:39:28 one: a record put together from two weigh-ins that do not
 * agree, which the BMR relation shows.
 */
export const MIXED_501: Triple = triple(
  firstAt('2026-11-09 21:57:10.422'),
  pairAt('2026-11-09 00:39:28.241'),
  `${LOG_2} first part of 21:57:10 with ${LOG_1} parts 2 and 3 of 00:39:28`,
);
