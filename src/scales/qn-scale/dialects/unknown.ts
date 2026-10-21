import type { QnDialectHandler } from '../dialect.js';

/**
 * A session without a 0x12 (D068): its live frames are read by their shape
 * on the shared 0x10 path, and its 0x23 in the VA layout, which every real
 * record we have uses.
 */
export const unknown: QnDialectHandler = {
  frame: (q, data) => (data[0] === 0x23 ? q.storedRecord(data) : undefined),
};
