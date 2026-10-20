// Detection for a bond the scale has discarded while this host still holds it
// (#290, #335, #471). Nothing here deletes a bond; connect.ts decides that.
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
//
// The string proves nothing on its own (#471, D066). Every BlueZ (5.66 to
// 5.86 and master) turns any failed ATT connect into -ECONNABORTED in
// att_connect_cb(), so a weak radio link gives exactly the same
// `le-connection-abort-by-local`: a good BF788 bond in #229 aborted six times
// in a row, and in #471 three aborts on a good BF915 bond, minutes after a
// session that worked, had the opt-in delete it. What tells the two apart is
// the link (link-observer.ts): BlueZ 5.83 and later name the reason in
// Device1.Disconnected (org.bluez.Reason.Authentication is the kernel's mark
// for Encryption Change 0x06), and on any BlueZ a connection the host ends
// over a refused key outlives the error by about one connection interval
// (#290: 74-95 ms), while a lost link goes down with it (#229, #471: 4-22 ms).

import { errMsg } from '../types.js';
import type { AttemptLinkView } from './link-observer.js';

/**
 * True when the string is a BlueZ authentication-class connect failure.
 *
 * THE STRING ALONE IS NOT SUFFICIENT EVIDENCE of a stale bond: it only says
 * the attempt is worth judging, and classifyAttempt() judges it on what the
 * link did. Every BlueZ gives it for a weak radio link too (#471), and emits
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

/** BlueZ's reason for a connection ended over Encryption Change 0x06 (5.83 and later). */
export const AUTH_FAILURE_REASON = 'org.bluez.Reason.Authentication';
/** Below this the connection went down with the error, as a lost radio link does (#229: 4-22 ms). */
export const LINK_OUTLIVED_ERROR_MIN_MS = 40;
/**
 * Above this something else ended the connection: the kernel's own idle
 * disconnect (HCI_DISCONN_TIMEOUT) and BlueZ's DISCONNECT_TIMER are both 2 s.
 */
export const LINK_OUTLIVED_ERROR_MAX_MS = 1_500;
/** How long the last attempt waits for its connection to go down before it is judged. */
export const LINK_SETTLE_MS = LINK_OUTLIVED_ERROR_MAX_MS;

/**
 * What one failed connect attempt says about the stored key:
 * - `refused`: BlueZ named org.bluez.Reason.Authentication.
 * - `outlived`: auth-class error, and the connection stayed up 40 ms to 1.5 s
 *   after it, as it does when this host gives up on a refused key.
 * - `dropped`: auth-class error, and the connection went down with it, or
 *   BlueZ named the radio link (Timeout) or the scale (Remote).
 * - `lingered`: auth-class error, and the connection was not seen going down
 *   within 1.5 s of it.
 * - `never-up`: auth-class error, and the connection never came up.
 * - `other`: not an auth-class error.
 */
export type AttemptEvidence =
  'refused' | 'outlived' | 'dropped' | 'lingered' | 'never-up' | 'other';

const LINK_REASONS = new Set(['org.bluez.Reason.Timeout', 'org.bluez.Reason.Remote']);

export function classifyAttempt(err: unknown, link: AttemptLinkView | undefined): AttemptEvidence {
  if (link?.reason === AUTH_FAILURE_REASON) return 'refused';
  if (!isAuthClassConnectFailure(err)) return 'other';
  if (!link?.linkUp) return 'never-up';
  if (link.reason !== undefined && LINK_REASONS.has(link.reason)) return 'dropped';
  const d = link.downAfterErrorMs;
  if (d === undefined || d > LINK_OUTLIVED_ERROR_MAX_MS) return 'lingered';
  return d < LINK_OUTLIVED_ERROR_MIN_MS ? 'dropped' : 'outlived';
}

/**
 * Whether the last attempt should wait for its connection to go down before
 * it is judged. A retry attempt need not: BlueZ sends Connected=false, and
 * from 5.83 the reason, before it answers that attempt's Disconnect.
 */
export function shouldSettle(err: unknown, link: AttemptLinkView | undefined): boolean {
  return (
    isAuthClassConnectFailure(err) && link?.linkUp === true && link.downAfterErrorMs === undefined
  );
}

const REASON_MEANINGS: Record<string, string> = {
  'org.bluez.Reason.Timeout': 'the radio link timed out',
  'org.bluez.Reason.Remote': 'the scale closed it',
  'org.bluez.Reason.Local': 'this host closed it',
  'org.bluez.Reason.Unknown': 'no specific reason',
  'org.bluez.Reason.Suspend': 'this host was suspending',
};

/** `org.bluez.Reason.Timeout (the radio link timed out)`, or the bare name of one we do not know. */
export function describeReason(reason: string): string {
  const meaning = REASON_MEANINGS[reason];
  return meaning ? `${reason} (${meaning})` : reason;
}

function describeDown(d: number | undefined): string {
  if (d === undefined) return 'was not seen going down after the error';
  if (d < 0) return `went down ${-d} ms before the error`;
  return `went down ${d} ms after the error`;
}

/**
 * The debug line for one failed attempt, or undefined when it adds nothing to
 * the error itself (not auth-class, no connection, no reason).
 */
export function describeAttempt(opts: {
  attempt: number;
  total: number;
  ms: number;
  error: string;
  outcome: AttemptEvidence;
  link: AttemptLinkView | undefined;
}): string | undefined {
  const { attempt, total, ms, error, outcome, link } = opts;
  if (outcome === 'other' && !link?.linkUp && link?.reason === undefined) return undefined;
  const up = link?.linkUp
    ? `the connection came up after ${link.linkUpAfterMs} ms`
    : 'the connection never came up';
  const reasonTail =
    link?.reason !== undefined && link.reason !== AUTH_FAILURE_REASON
      ? `; BlueZ: ${describeReason(link.reason)}`
      : '';
  let detail: string;
  switch (outcome) {
    case 'refused':
      detail =
        `${link?.linkUp ? up : 'BlueZ never reported the connection as up'}; ` +
        `BlueZ: ${AUTH_FAILURE_REASON}, the scale refused the stored pairing key`;
      break;
    case 'outlived':
      detail =
        `${up} and stayed up ${link?.downAfterErrorMs} ms after the error, as it does when ` +
        `this host gives up on a refused pairing key${reasonTail}`;
      break;
    case 'never-up':
      detail = `${up}${reasonTail}`;
      break;
    default:
      detail = link?.linkUp
        ? `${up} and ${describeDown(link.downAfterErrorMs)}${reasonTail}`
        : `${up}${reasonTail}`;
  }
  return `Connect attempt ${attempt}/${total} failed after ${ms} ms (${error}): ${detail}`;
}
