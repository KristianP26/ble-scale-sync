/**
 * Mi Scale 2 frames of #422 (comment 5961349470, ESP32 proxy, v1.30.0): the only
 * real 0x181B service data in the repo. Both captured frames carry the
 * load-removed bit, so neither is a weigh-in. The two stable frames below are
 * derived from them, as no capture has a stable frame (#526).
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
