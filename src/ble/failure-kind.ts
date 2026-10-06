/**
 * Classifies a continuous-mode poll failure so the #154 watchdog counts only
 * failures that signal a genuinely unhealthy BLE stack, not the normal "nobody
 * is standing on the scale" idle case (#213).
 *
 *  - 'idle'          the scan found no scale but the radio is alive (it saw
 *                    other devices advertise). Neutral: do NOT count.
 *  - 'wedge-suspect' a GATT connect/read failure, or no BLE activity at all
 *                    (zombie-discovery wedge). Count toward the watchdog.
 *  - 'blocked'       the scale was found but a precondition we set ourselves
 *                    refused the connect (`ble.adapter_privacy` not active,
 *                    #417). The radio is fine, so do NOT count; but unlike
 *                    'idle' the discovery timeout has not necessarily elapsed,
 *                    so the cycle takes the normal failure backoff.
 *
 * Scales like Renpho only advertise while in use, so a `Device not found`
 * timeout is the EXPECTED idle state. The watchdog previously counted every such
 * timeout and restarted the process after N of them on a healthy radio (#213).
 */
export type BleFailureKind = 'idle' | 'wedge-suspect' | 'blocked';

interface TaggedError {
  bleFailureKind?: BleFailureKind;
}

/** Attach a failure kind to an error. Idempotent: never overwrites an existing tag. */
export function tagBleFailure<E>(err: E, kind: BleFailureKind): E {
  if (err !== null && typeof err === 'object') {
    const tagged = err as TaggedError;
    if (tagged.bleFailureKind === undefined) tagged.bleFailureKind = kind;
  }
  return err;
}

/** Read the failure kind off an error, or undefined if untagged / not an object. */
export function bleFailureKind(err: unknown): BleFailureKind | undefined {
  if (err !== null && typeof err === 'object') {
    return (err as TaggedError).bleFailureKind;
  }
  return undefined;
}

/**
 * Whether a poll failure should increment the watchdog counter. Untagged errors
 * (non-node-ble handlers, infra errors) count, preserving prior behavior; only
 * an explicit 'idle' or 'blocked' tag is treated as neutral.
 */
export function shouldCountAsWatchdogFailure(err: unknown): boolean {
  const kind = bleFailureKind(err);
  return kind !== 'idle' && kind !== 'blocked';
}
