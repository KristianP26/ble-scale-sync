/**
 * Mi Scale 2 frames of #422 (comment 5961349470, ESP32 proxy, v1.30.0). Both
 * captured frames carry the load-removed bit, so neither is a weigh-in. The two
 * stable frames below are derived from them (#526). #537 adds a stable frame
 * from a reporter's log whose weight line does not match the bytes (tests/
 * helpers/mi-scale-2-537.ts), so no stable frame in the repo is a verified
 * capture.
 */

/** Captured idle advert: 97.80 kg, impedance 586 ohm, load removed. */
export const MI2_422_IDLE = '02a6b207010402371b4a02684c';

/** Captured step-off advert: 1.60 kg, load removed. */
export const MI2_422_STEP_OFF = '06a4b207010403032200004001';

/**
 * MI2_422_STEP_OFF with the removed bit 7 of [1] cleared: a stable 1.60 kg
 * frame, the kind #422 exported weight only (its log has the weight, not the
 * frame; v1.30.0 already refused the removed bit).
 */
export const MI2_LIGHT_STABLE = '0624b207010403032200004001';

/**
 * MI2_422_IDLE with bits 7 (removed) and 1 (impedance present) of [1] cleared:
 * a stable 97.80 kg weigh-in still waiting for its impedance.
 */
export const MI2_WEIGH_IN = '0224b207010402371b4a02684c';

/** The characteristic the #422 unit exposed for the Mi vendor protocol (notify + write). */
export const MI2_422_NOTIFY_CHAR = '00002a2f0000351221180009af100700';

/**
 * The reporter's exact 18-entry characteristic list of #422, duplicate 2a04
 * included, as discovery printed it.
 */
export const MI2_422_CHAR_UUIDS = [
  '00002a2500001000800000805f9b34fb',
  '00002a2800001000800000805f9b34fb',
  '00002a2700001000800000805f9b34fb',
  '00002a2300001000800000805f9b34fb',
  '00002a5000001000800000805f9b34fb',
  '00002a0500001000800000805f9b34fb',
  '00002a0000001000800000805f9b34fb',
  '00002a0100001000800000805f9b34fb',
  '00002a0400001000800000805f9b34fb',
  '00002a2b00001000800000805f9b34fb',
  '00002a9b00001000800000805f9b34fb',
  '00002a9c00001000800000805f9b34fb',
  MI2_422_NOTIFY_CHAR,
  '000015310000351221180009af100700',
  '000015320000351221180009af100700',
  '00002a0400001000800000805f9b34fb',
  '000015420000351221180009af100700',
  '000015430000351221180009af100700',
];
