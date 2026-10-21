import { bleLog } from '../../../ble/types.js';
import { hex, type QnDialectHandler } from '../dialect.js';

/**
 * The classic dialect (a 15- or 17-byte 0x12): its weigh-in comes on the
 * shared live 0x10 path, and its 0x23 is not read at all. Classic firmware
 * lays the record out one byte earlier, as the vendor's published SDK reads
 * it (#283's record is the live weight of its session that way, 61.70 kg),
 * and nothing here decodes that layout. Read through the long layout, a
 * classic weight of 130.56 kg or more put the record's time in the future,
 * past the freshness check, and it went out with the wrong weight. Every
 * classic weigh-in in our logs came live (D068).
 */
export const classic: QnDialectHandler = {
  frame(q, data) {
    if (data[0] !== 0x23) return undefined;
    bleLog.debug(
      `QN: 0x23 on the classic dialect is not decoded (#461 S3), not read: [${hex(data)}] (#463)`,
    );
    // The re-query stays, as for every 0x23 not read.
    q.scheduleStoredDataRetry();
    return null;
  },
};
