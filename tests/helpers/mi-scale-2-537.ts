/**
 * Mi Scale 2 frames of #537 (esphome-proxy, v1.41.0), verbatim from the issue's
 * debug log. Both decode to 74.25 kg / 444 ohm; the second is the stable
 * weigh-in the reporter's ha-bluetooth run read. The issue's log line for it
 * says 70.00 kg while the adapter decodes 74.25 kg; not reconciled, so traces
 * built from these frames are `derived`, never `captured`. The MAC is not used:
 * tests pick their own.
 */

/** The advert that opened the GATT connect: stable + impedance + load removed, nameless. */
export const MI2_537_REMOVED = '02a6ea070b10171106bc01023a';

/** The stable weigh-in: 74.25 kg, 444 ohm, load not removed. */
export const MI2_537_WEIGH_IN = '0226ea070b10173427bc01023a';
