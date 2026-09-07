import type { Characteristic } from '@stoprocent/noble';
import type { BleChar } from '../shared.js';
import { bleLog, errMsg, withTimeout } from '../types.js';

/**
 * Upper bound on enabling notifications (#283).
 *
 * @abandonware/noble promisifies subscribe over a single `once('notify')` with
 * no error path, and its WinRT binding has several branches that emit nothing
 * at all: the device-not-connected guard, a failed characteristic lookup, and a
 * CCCD write that comes back as anything other than AsyncStatus::Completed
 * (the reporter's log shows `BLEManager::OnNotify: status: 3`). On those paths
 * subscribeAsync never settles, so the whole reading hangs on a promise that
 * can only be ended by the scale dropping the link, and the user sees a
 * misleading "disconnected before reading completed".
 */
const NOTIFY_ENABLE_TIMEOUT_MS = 10_000;

/**
 * Client Characteristic Configuration descriptor, and the value that turns
 * notifications on.
 */
const CCCD_UUID = '2902';
const CCCD_NOTIFY_ON = Buffer.from([0x01, 0x00]);
const CCCD_OFF = Buffer.from([0x00, 0x00]);

/**
 * Upper bound on the direct CCCD fallback below. Shorter than the subscribe it
 * backs up: by the time it runs the session has already spent that budget once,
 * and this path either works quickly or not at all.
 */
const CCCD_WRITE_TIMEOUT_MS = 5_000;

/**
 * Minimal descriptor surface. Both drivers expose it; the cast is contained
 * here rather than widening the shared Characteristic type.
 */
interface NobleDescriptor {
  uuid: string;
  writeValueAsync(data: Buffer): Promise<void>;
}
interface DescriptorCapable {
  discoverDescriptorsAsync?(): Promise<NobleDescriptor[]>;
}

/**
 * Enable notifications by writing the CCCD directly, bypassing subscribeAsync.
 *
 * Why this exists: `subscribeAsync` is promisified over a single `once('notify')`
 * with no error path, and the WinRT binding has branches that emit nothing at
 * all, including a CCCD write returning anything other than Completed (the #283
 * reporter's log shows `BLEManager::OnNotify: status: 3`). The subscribe then
 * never settles and the session is dead. Writing the descriptor goes through
 * `writeValue` instead of the notify machinery, so it fails loudly or succeeds,
 * rather than hanging.
 *
 * Returns a function that turns notifications back off, or null when the
 * descriptor is not reachable, in which case the caller keeps the original
 * subscribe error as the thing worth reporting.
 */
async function enableViaCccd(char: Characteristic): Promise<(() => void) | null> {
  const cap = char as unknown as DescriptorCapable;
  if (typeof cap.discoverDescriptorsAsync !== 'function') return null;
  const descriptors = await withTimeout(
    cap.discoverDescriptorsAsync(),
    CCCD_WRITE_TIMEOUT_MS,
    `Descriptor discovery on ${char.uuid} timed out`,
  );
  // Drivers report a descriptor UUID either short ('2902') or in full 128-bit
  // form. The 16-bit value sits at the START of the expanded form, after the
  // four zero nibbles, so matching on a suffix finds nothing.
  const cccd = descriptors.find((d) => {
    const u = d.uuid.toLowerCase().replace(/-/g, '');
    return u === CCCD_UUID || u.startsWith(`0000${CCCD_UUID}`);
  });
  if (!cccd) return null;
  await withTimeout(
    cccd.writeValueAsync(CCCD_NOTIFY_ON),
    CCCD_WRITE_TIMEOUT_MS,
    `CCCD write on ${char.uuid} timed out`,
  );
  return () => {
    // Best effort: the link is usually gone by the time this runs.
    void cccd.writeValueAsync(CCCD_OFF).catch(() => {});
  };
}

export function wrapChar(char: Characteristic): BleChar {
  return {
    subscribe: async (onData) => {
      const listener = (data: Buffer) => onData(data);
      // Attach before the CCCD write so a scale that notifies the instant
      // notifications are enabled cannot beat the listener.
      char.on('data', listener);
      const startedAt = Date.now();
      let cccdOff: (() => void) | null = null;
      try {
        await withTimeout(
          char.subscribeAsync(),
          NOTIFY_ENABLE_TIMEOUT_MS,
          `Enabling notifications on ${char.uuid} did not complete within ${NOTIFY_ENABLE_TIMEOUT_MS}ms (the CCCD write was never acknowledged)`,
        );
      } catch (subscribeErr: unknown) {
        // Fall back to writing the CCCD ourselves before giving the session up.
        // On the paths that bring us here the subscribe has already failed, so
        // this can only improve the outcome: it either enables notifications
        // through a different code path in the binding, or it fails and we
        // report the original error, which is the more informative one.
        bleLog.debug(
          `Subscribe on ${char.uuid} failed (${errMsg(subscribeErr)}); trying a direct CCCD write`,
        );
        try {
          cccdOff = await enableViaCccd(char);
        } catch (cccdErr: unknown) {
          bleLog.debug(`Direct CCCD write on ${char.uuid} failed: ${errMsg(cccdErr)}`);
          cccdOff = null;
        }
        if (!cccdOff) {
          // Leaving the listener attached would leak one per failed cycle.
          char.removeListener('data', listener);
          throw subscribeErr;
        }
        bleLog.info(
          `Notifications on ${char.uuid} were enabled by writing the CCCD directly, ` +
            `after the driver's subscribe failed (#283).`,
        );
      }
      bleLog.debug(`Notifications enabled on ${char.uuid} in ${Date.now() - startedAt}ms`);
      return () => {
        char.removeListener('data', listener);
        if (cccdOff) cccdOff();
      };
    },
    write: (data, withResponse) => char.writeAsync(data, !withResponse),
    read: () => char.readAsync(),
  };
}
