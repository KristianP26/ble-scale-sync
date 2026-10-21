import type { UserProfile } from '../../../src/interfaces/scale-adapter.js';
import { fromSnoop, type SnoopLine, type TraceStep } from '../../helpers/replay/trace.js';

/**
 * What the QN fixtures share. Every real MAC is the harness's fake one
 * (02:00:00:00:00:01): the scale echoes its MAC little-endian at 0x12 [3..8]
 * and at [5..10] of its advertisement, so those bytes read `01 00 00 00 00 02`
 * and the 0x12's sum checksum is recomputed. Nothing in the adapter reads them
 * apart from the advertisement's MAC check, which `ADDRESS` passes.
 */

/** The fake MAC as transports hand it to the session, so qnAdvertTraits checks it. */
export const ADDRESS = '020000000001';

/** A unit with the AE00 service (the JieLi challenge and the AE01 writes). */
export const AE00_CHARS = ['fff1', 'fff2', 'ae01', 'ae02'];

/**
 * Snoop lines as trace steps. The JieLi challenge (17 bytes led by 0x00) and
 * the scale's echo of our `pass` frame arrive on AE02 in every log that names
 * the characteristic (#461, #463), so they go there; every other frame on
 * `notify`.
 */
export const qnSteps = (lines: readonly SnoopLine[], notify = 'fff1'): TraceStep[] =>
  fromSnoop(lines).map((s) => ({
    ...s,
    uuid:
      (s.hex.length === 34 && s.hex.startsWith('00')) || s.hex === '0270617373' ? 'ae02' : notify,
  }));

/**
 * The 19-byte fixtures' profile, the height the #331 visit frame carried. The
 * age is the fixtures' own; the scale's body age and BMR in the frames are
 * exported as sent, not checked against it (D078).
 */
export const P181: UserProfile = {
  height: 181,
  age: 40,
  gender: 'male',
  isAthlete: false,
  lastKnownWeight: 76,
};

/** The `ble.qn_user_key` fixtures' profile: athlete, so the 18-byte visit frame's step is set. */
export const P182_ATHLETE: UserProfile = {
  height: 182,
  age: 51,
  gender: 'male',
  isAthlete: true,
};
