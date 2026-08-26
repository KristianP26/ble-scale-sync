// Detection for a bond the scale has discarded while this host still holds it
// (#290, #335). Diagnostics only: nothing here deletes a bond.
//
// #335 is the cleaner reproduction and the one the user-facing message points
// at: a BF915 on a Pi 5 with fresh batteries, eight consecutive sessions, every
// one connecting once and then locking the host out until `bluetoothctl remove`
// was run by hand. #290 is where the mechanism was decoded, below, but that
// issue is titled after a GATT acquisition timeout under Docker, so sending
// people there to read about their pairing was a wrong turn.
//
// The BF950 HCI capture (bf950.btsnoop, 384 records) shows the mechanism
// exactly. Six LE connections, every one status=0x00, and zero L2CAP traffic in
// the whole file, so no SMP exchange happens at all. Each attempt is:
//
//   HCI_LE_Start_Encryption  (same Rand, same EDIV 0xB96B, same LTK, six times)
//     -> 584 ms later, exactly 3 connection intervals, so an active reject
//   HCI Encryption Change  status=0x06 "PIN or Key Missing"
//     -> 9 ms later
//   HCI_Disconnect  reason=0x05 Authentication Failure   (the HOST gives up)
//   Disconnection Complete  reason=0x16 Terminated By Local Host
//
// BlueZ renders that last step on D-Bus as `le-connection-abort-by-local`.
// Status 0x06 comes from the peripheral and means it no longer holds a key
// matching the EDIV/Rand we offered: it has forgotten the bond. bluetoothd is
// told AUTH_FAILURE but never invalidates the key, so the dead LTK is replayed
// forever and `removeDevice`'s bonded guard keeps ours alive.

import { errMsg } from '../types.js';

/**
 * True when the string is a BlueZ authentication-class connect failure.
 *
 * THE STRING ALONE IS NOT SUFFICIENT EVIDENCE of a stale bond, which is why
 * this module deliberately stops at diagnosis. BlueZ emits
 * `le-connection-abort-by-local` for any kernel ECONNABORTED, including the
 * well-known "connect issued while discovery was still active" abort that this
 * codebase already comments on in scan.ts, and including the case where a
 * second D-Bus client (for example the Home Assistant Bluetooth integration on
 * the same adapter) holds a discovery session our stop cannot release. For
 * those users six aborts in a row are normal.
 */
export function isAuthClassConnectFailure(err: unknown): boolean {
  const msg = errMsg(err).toLowerCase();
  return (
    msg.includes('le-connection-abort-by-local') ||
    msg.includes('authentication failed') ||
    msg.includes('authenticationfailed')
  );
}

/**
 * Consecutive authentication-class failures before the pattern is worth
 * reporting as a probable stale bond. #290 shows six out of six.
 */
export const STALE_BOND_EVIDENCE_ATTEMPTS = 3;

/** Actionable replacement for the bare `le-connection-abort-by-local`. */
export function staleBondMessage(mac: string, attempts: number, lastError: string): string {
  return (
    `Connection failed after ${attempts} attempts: ${mac} is bonded on this host but ` +
    'rejected the stored pairing key on every attempt, so the link was dropped during ' +
    'encryption before any GATT traffic. The scale has most likely forgotten its half of ' +
    'the pairing while this host still holds it. Clear it and pair again: run ' +
    `sudo bluetoothctl, then "remove ${mac}", put the scale into pairing mode, then ` +
    `"pair ${mac}". See #335. Last error: ${lastError}`
  );
}
