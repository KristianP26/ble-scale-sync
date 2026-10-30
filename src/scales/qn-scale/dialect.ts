import type { ScaleReading } from '../../interfaces/scale-adapter.js';
import {
  EXTENDED_INFO_FRAME_LEN,
  PROTO_ECHO_MIN_INFO_FRAME_LEN,
  STORED_UNASSIGNED_SLOT,
} from './constants.js';
import type { QnScaleAdapter } from './index.js';
import type { QnSession } from './session.js';

/**
 * The dialect of a QN session, which only its 0x12 scale-info frame names:
 * `unknown` until one arrives (the divisor is then a guess, C-06), `classic`
 * for the short frame (15 bytes on an ES-CS20M, 17 on the maintainer's unit
 * and #283) and any frame without its own length at [1], and by length for
 * the long frame: `va18` (Renpho ES-26M, Physiq), `va19` (Arboleaf) and
 * `ext20` (20 bytes and up, GE CS 10 G). A classic frame of 18 or 19 bytes is
 * never `va18` or `va19`. Each has a handler in dialects/. A long-frame scale
 * may never send impedance, so its stable R1=R2=0 ES-30M frame is accepted
 * after a grace period; classic ES-30M scales always send the impedance frame.
 */
export type QnDialectKind = 'unknown' | 'classic' | 'va18' | 'va19' | 'ext20';

/** The dialect a 0x12 frame names (see QnDialectKind). */
export function classifyInfoFrame(data: Buffer): QnDialectKind {
  // Every real 0x12 carries its own length at [1] and the MAC at [3..8], the
  // classic ones too; 18 bytes and up are the long frame.
  if (data.length < 18 || data[1] !== data.length) return 'classic';
  if (data.length >= EXTENDED_INFO_FRAME_LEN) return 'ext20';
  return data.length === PROTO_ECHO_MIN_INFO_FRAME_LEN ? 'va19' : 'va18';
}

/**
 * One dialect's own frames. parseFrame answers the frames every dialect
 * shares (0x12, 0x14, 0x21, 0xA1/0xA3) and hands every other frame here first.
 */
export interface QnDialectHandler {
  /**
   * A reading, null when the frame is this dialect's and done with, or
   * undefined to pass it on to the shared live 0x10 path, which logs and drops
   * anything that is not a live frame.
   */
  frame(q: QnScaleAdapter, data: Buffer): ScaleReading | null | undefined;

  /**
   * The link hold for this dialect's weigh-in while one is armed, and whether
   * frames of it are still to come (HoldForComposition). The adapter asks every
   * dialect that has one, whatever the session's dialect is now: the state
   * lives in the session and outlives a later 0x12 (Q-09).
   */
  hold?(s: QnSession): { ms: number; pending: boolean } | undefined;
}

/** Format bytes as hex string for debug logging. */
export const hex = (data: number[] | Buffer): string =>
  [...data].map((b) => b.toString(16).padStart(2, '0')).join(' ');

/** A 0x23 record's slot [5] for the log; 0xf0 is no slot at all (#463). */
export const storedSlotLabel = (slot: number): string =>
  slot === STORED_UNASSIGNED_SLOT ? 'assigned to no user' : `user slot ${slot}`;
