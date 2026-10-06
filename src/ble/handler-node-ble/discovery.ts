import type { ScaleAdapter, BleDeviceInfo } from '../../interfaces/scale-adapter.js';
import { resolveAdapter } from '../../scales/resolve.js';
import {
  bleLog,
  formatMac,
  sleep,
  abortableSleep,
  errMsg,
  withTimeout,
  resetAdapterBtmgmt,
  resetAdapterRfkill,
  restartBluetoothd,
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_POLL_MS,
  POST_DISCOVERY_QUIESCE_MS,
} from '../types.js';
import { helperOf, getDbusNext, releaseDeviceProxy, type Adapter, type Device } from './dbus.js';
import { logAdvertisementSnapshot } from './device-object.js';
import { reensureAdapterPrivacy } from './privacy.js';
import {
  getAdapter,
  resetConnection,
  parseHciIndex,
  currentConnectionGeneration,
} from './connection.js';
import { safeName } from '../advertisement.js';

/**
 * Which adapters have a scan running that WE started with the duplicate filter
 * in place, and on which D-Bus connection.
 *
 * Keyed by the adapter rather than held as one module-level flag, because more
 * than one adapter object can be live at a time: `scanDevices()` builds a
 * throwaway bus with its own adapter alongside the persistent one, and a single
 * flag would let one stamp the other's state. The stored value is the
 * connection generation, because a reset replaces the BlueZ client and whatever
 * the old one asked for no longer applies (#372, #397).
 */
const filteredScans = new WeakMap<Adapter, number>();

/** True when this adapter's running scan is ours and already carries the filter. */
function runningScanIsFiltered(btAdapter: Adapter): boolean {
  const generation = filteredScans.get(btAdapter);
  return generation !== undefined && generation === currentConnectionGeneration();
}

/**
 * Forget the filtered-scan claim for an adapter whose discovery has been
 * stopped somewhere other than `stopDiscoveryAndQuiesce`.
 *
 * The invariant this protects is "a claim exists only while our filtered scan
 * is actually running". A stale claim is the one state that would silently keep
 * a deduplicating scan alive, because the restart branch would decline to cycle
 * it (#372, #397).
 */
export function notifyDiscoveryStopped(btAdapter: Adapter): void {
  filteredScans.delete(btAdapter);
}

/** Stop discovery and wait for the post-discovery quiesce period. */
export async function stopDiscoveryAndQuiesce(btAdapter: Adapter): Promise<void> {
  try {
    bleLog.debug('Stopping discovery before connect...');
    await btAdapter.stopDiscovery();
    bleLog.debug('Discovery stopped');
  } catch {
    bleLog.debug('stopDiscovery failed (may already be stopped)');
  }
  notifyDiscoveryStopped(btAdapter);
  await sleep(POST_DISCOVERY_QUIESCE_MS);
}

/**
 * How long one discovery call or Powered write may take before it counts as
 * stuck. A healthy BlueZ answers these in milliseconds. A stuck one can hold a
 * StartDiscovery forever: with a different filter and bluetoothd's
 * discovery_enable left at 1, start_discovery_timeout() sends the kernel a Stop
 * Discovery with no completion handler, the kernel rejects it, and our message
 * is never answered (bluez src/adapter.c). Without a deadline that parked the
 * whole cycle until the poll loop gave up on it.
 */
const BLUEZ_CALL_TIMEOUT_MS = 10_000;

/** A BlueZ call that got no answer in time, which is evidence of a stuck state. */
class BluezCallTimeout extends Error {}

/**
 * InProgress answers to a StartDiscovery, which are no evidence of a stuck
 * bluetoothd. BlueZ answers a first start the kernel refused with the same
 * InProgress (discovery_complete() replies btd_error_busy for any failed
 * status), and a second start from a sender that already has a session too
 * (start_discovery()). A kernel that refused a start because it was busy is
 * what the power cycle in tier 3 clears, so treating these as stuck would skip
 * the one tier that helps.
 *
 * That second start includes our own when a start of ours is still held,
 * which IS stuck: restartStalledDiscovery() keeps the bus, so a rejoin whose
 * start timed out leaves it held into the next cycle. Tier 2's StopDiscovery
 * then gets InProgress for the held message (client->msg in stop_discovery())
 * and catches it before tier 3; with Discovering on, the restart branch's stop
 * does.
 */
const refusedStarts = new WeakSet<object>();

async function bluezCall(btAdapter: Adapter, method: string, ...args: unknown[]): Promise<void> {
  const message = `${method} got no answer from BlueZ within ${BLUEZ_CALL_TIMEOUT_MS / 1000}s`;
  try {
    await withTimeout(
      helperOf(btAdapter).callMethod(method, ...args),
      BLUEZ_CALL_TIMEOUT_MS,
      message,
    );
  } catch (err) {
    if (err instanceof Error && err.message === message) throw new BluezCallTimeout(message);
    if (method === 'StartDiscovery' && isInProgress(err) && typeof err === 'object' && err) {
      refusedStarts.add(err);
    }
    throw err;
  }
}

/**
 * The BlueZ error name. dbus-next puts a D-Bus error's name in `.type` and only
 * the error's text in `.message` (DBusError in dbus-next lib/errors.js).
 */
function bluezErrorName(err: unknown): string {
  const t = (err as { type?: unknown } | null | undefined)?.type;
  return typeof t === 'string' ? t : '';
}

/** BlueZ's answer to a StopDiscovery from a sender with no session (stop_discovery()). */
function isNoDiscoveryStarted(err: unknown): boolean {
  const name = bluezErrorName(err);
  return (
    (name === '' || name === 'org.bluez.Error.Failed') &&
    errMsg(err).includes('No discovery started')
  );
}

function isInProgress(err: unknown): boolean {
  return (
    bluezErrorName(err) === 'org.bluez.Error.InProgress' ||
    errMsg(err).includes('Operation already in progress')
  );
}

/**
 * The two answers a healthy BlueZ does not give to our discovery calls: none
 * at all, or InProgress (btd_error_busy) to anything but a StartDiscovery (see
 * refusedStarts). BlueZ answers our StopDiscovery with InProgress when the
 * kernel rejected the Stop Discovery it sent on our behalf
 * (stop_discovery_complete()), which the kernel does when it is not scanning;
 * and a stop with InProgress while an earlier call of ours is still
 * unanswered.
 */
function isStuckEvidence(err: unknown): boolean {
  if (err instanceof BluezCallTimeout) return true;
  return isInProgress(err) && !(typeof err === 'object' && err && refusedStarts.has(err));
}

export interface StartDiscoveryOptions {
  abortSignal?: AbortSignal;
}

const announced = new Set<string>();

/** First time at `level`, after that at debug: these repeat every cycle while the state lasts. */
function announceOnce(key: string, level: 'info' | 'warn', message: string): void {
  if (announced.has(key)) {
    bleLog.debug(message);
    return;
  }
  announced.add(key);
  bleLog[level](message);
}

/** Test seam: the announcements are per process on purpose. */
export function _resetDiscoveryRecoveryStateForTests(): void {
  announced.clear();
}

/**
 * The one state none of our calls can clear: bluetoothd believes the kernel is
 * discovering (discovery_enable 1) while the kernel is not. Every Stop
 * Discovery it sends is then rejected, and a power cycle does not reset that
 * flag either (adapter_stop() leaves it, and a kernel that was not scanning
 * reports no change). Only a new bluetoothd starts from a clean one.
 */
function announceStuckDiscovery(err: unknown): void {
  announceOnce(
    'stuck',
    'warn',
    `BlueZ discovery looks stuck (${errMsg(err)}). bluetoothd keeps that state until it ` +
      'restarts: run `sudo systemctl restart bluetooth`.',
  );
}

/**
 * Powered off and on through BlueZ (Adapter1.Powered), recovery tier 3.
 * BlueZ's adapter_stop() then drops every client's discovery session,
 * Discovering and the current discovery filter, together with every connection
 * and temporary device on the adapter.
 *
 * Powered=true is written whatever happened before it, an abort included: an
 * adapter left off takes the scale and every other BLE device on it down.
 * True only when both writes were accepted.
 */
async function powerCycleViaDbus(btAdapter: Adapter, abortSignal?: AbortSignal): Promise<boolean> {
  const helper = helperOf(btAdapter);
  const { Variant } = await getDbusNext();
  const setPowered = (on: boolean): Promise<void> =>
    withTimeout(
      helper.set('Powered', new Variant('b', on)),
      BLUEZ_CALL_TIMEOUT_MS,
      `Powered=${on} got no answer from BlueZ within ${BLUEZ_CALL_TIMEOUT_MS / 1000}s`,
    );
  let off = false;
  try {
    await setPowered(false);
    off = true;
    bleLog.debug('Adapter powered off');
    // Cut short by an abort, never skipped: the power-on below has to run.
    await abortableSleep(1000, abortSignal).catch(() => {});
  } catch (err) {
    bleLog.debug(`Could not power the adapter off: ${errMsg(err)}`);
  }
  let on = false;
  try {
    await setPowered(true);
    on = true;
  } catch (err) {
    bleLog.warn(`Could not power the Bluetooth adapter back on: ${errMsg(err)}`);
  }
  if (!off || !on) return false;
  bleLog.debug('Adapter powered on');
  if (abortSignal?.aborted) return true;
  await sleep(1000);
  // HCI_PRIVACY survives a power cycle, so this is one `btmgmt info`, and a
  // no-op without ble.adapter_privacy. It is here so a key that did go missing
  // is put back before the next connect rather than found missing by it (#417).
  await reensureAdapterPrivacy();
  return true;
}

/**
 * Ask BlueZ to report every advertisement, not just the first one per device.
 *
 * MUST run BEFORE `StartDiscovery`. BlueZ applies the filter to the scan it
 * starts, and its own documentation says so: "SetDiscoveryFilter can be called
 * before StartDiscovery. It is useful when client will create first discovery
 * session, to ensure that proper scan will be started right after call to
 * StartDiscovery." `DuplicateData` is what makes it emit PropertiesChanged for
 * ManufacturerData and ServiceData on every packet rather than only when the
 * value first appears.
 *
 * Setting it afterwards, which is what the broadcast path used to do, leaves
 * the running scan deduplicating. A broadcast scale then looks frozen: BlueZ
 * keeps handing back the first advertisement it cached, the 500 ms poll re-reads
 * that same value forever, and the app reports one settling weight that never
 * changes while the vendor app shows the scale counting up (#372).
 *
 * Failure is non-fatal. A filter BlueZ rejects should not stop a scan that
 * would otherwise work; the caller falls back to polling as before.
 */
async function requestDuplicateAdvertisements(btAdapter: Adapter): Promise<boolean> {
  try {
    const { Variant } = await getDbusNext();
    await bluezCall(btAdapter, 'SetDiscoveryFilter', {
      Transport: new Variant('s', 'le'),
      DuplicateData: new Variant('b', true),
    });
    bleLog.debug('Discovery filter: Transport=le, DuplicateData=true');
    return true;
  } catch (err: unknown) {
    // A filter BlueZ refuses is harmless; one it never answers is not.
    if (err instanceof BluezCallTimeout) throw err;
    bleLog.debug(`SetDiscoveryFilter: ${errMsg(err)} (non-fatal, scan continues deduplicated)`);
    return false;
  }
}

/**
 * Set our filter and start the scan, WITHOUT going through node-ble.
 *
 * node-ble's own `Adapter.startDiscovery()` is
 *
 *     await this.helper.callMethod('SetDiscoveryFilter', { Transport: 'le' })
 *     await this.helper.callMethod('StartDiscovery')
 *
 * and BlueZ's SetDiscoveryFilter REPLACES the caller's whole filter dict rather
 * than merging into it, so every key we had just set reverts to its default and
 * `DuplicateData` goes back to false. Calling it and then calling node-ble's
 * startDiscovery, which is what shipped for #372, therefore does nothing at all:
 * the filter that reaches BlueZ is always node-ble's Transport-only one. The
 * scan keeps deduplicating, the 500 ms broadcast poll keeps re-reading one
 * cached advertisement, and the symptom #372 was meant to fix survives the fix.
 *
 * So the two calls are made here in the order that actually works.
 *
 * Returns whether the filter itself was accepted, which is what decides if the
 * running scan may be treated as already filtered.
 */
async function applyFilterAndStart(btAdapter: Adapter): Promise<boolean> {
  const filtered = await requestDuplicateAdvertisements(btAdapter);
  await bluezCall(btAdapter, 'StartDiscovery');
  return filtered;
}

/**
 * Clear a phantom `Discovering`: bluetoothd reports the adapter as discovering
 * while no client owns a session and the kernel is not scanning, so nothing is
 * found and nothing in BlueZ ever clears it on its own.
 *
 * Seen on the maintainer's Pi (BlueZ 5.82): every cycle our StopDiscovery came
 * back `No discovery started`, the old branch here continued with "the existing
 * scan", and btmon showed no HCI traffic at all while Discovering read true.
 * BlueZ gets there when a Stop Discovery it sends is rejected by a kernel that
 * is not scanning: stop_discovery_complete() then removes the client but
 * returns before it clears `discovering`, and discovery_remove() of the last
 * client only runs discovery_cleanup(). What clears it, from src/adapter.c:
 *
 * - Our StartDiscovery joins without touching the kernel: our filter is the
 *   one still in current_discovery_filter (it outlives the last client, and
 *   filters_equal() ignores DuplicateData), and update_discovery_filter()
 *   answers success when the filters are equal and `discovering` is set. That
 *   is useless as a scan, but it gives us a session to stop.
 * - As the only client, and with bluetoothd's discovery_enable at 0, our
 *   StopDiscovery takes discovery_stop()'s local path: `discovering` goes false
 *   and no Stop Discovery is sent, so the kernel has nothing to reject.
 * - The next StartDiscovery then really starts the kernel scan.
 *
 * With discovery_enable stuck at 1 instead, the stop goes to the kernel, which
 * rejects it, and BlueZ answers InProgress: see announceStuckDiscovery().
 *
 * Where another client's scan is really running (Home Assistant on a shared
 * adapter), the same three calls just end with us joined to it: `shared`.
 *
 * The quiesce follows the caller's abort, and a cut-short one starts nothing.
 */
async function rejoinAndRestart(
  btAdapter: Adapter,
  abortSignal?: AbortSignal,
): Promise<{ filtered: boolean; shared: boolean }> {
  await applyFilterAndStart(btAdapter);
  await bluezCall(btAdapter, 'StopDiscovery');
  notifyDiscoveryStopped(btAdapter);
  if (await othersStillDiscovering(btAdapter)) {
    return { filtered: await applyFilterAndStart(btAdapter), shared: true };
  }
  await abortableSleep(POST_DISCOVERY_QUIESCE_MS, abortSignal);
  return { filtered: await applyFilterAndStart(btAdapter), shared: false };
}

/**
 * Asked right after our own StopDiscovery went through: true when Discovering
 * is still on, which only other clients' sessions keep it (discovery_stop()
 * with more than one client just drops ours). Our stop and the start after it
 * then only leave and rejoin their scan. That reaches the controller only when
 * their filters differ from ours: update_discovery_filter() restarts the
 * kernel scan whenever the merged filter changes, so leaving and rejoining
 * costs two kernel restarts. With the same transport filter (filters_equal())
 * nothing reaches it. bluetoothd runs one main loop, so the stop has fully
 * taken by the time this Get is served.
 */
async function othersStillDiscovering(btAdapter: Adapter): Promise<boolean> {
  try {
    return (await btAdapter.isDiscovering()) === true;
  } catch {
    return false;
  }
}

/**
 * 'done': discovery runs (or a scan we could not cycle is left running).
 * 'escalate': discovery may not be running, try the recovery tiers.
 * `{ stuck }`: BlueZ answered InProgress or not at all, see isStuckEvidence().
 */
type RestartOutcome = 'done' | 'escalate' | { stuck: unknown };

/** Restart a scan we do not own yet, so the duplicate filter takes and the session is ours. */
async function restartRunningDiscovery(
  btAdapter: Adapter,
  generation: number,
  abortSignal?: AbortSignal,
): Promise<RestartOutcome> {
  let stopped = false;
  try {
    await bluezCall(btAdapter, 'StopDiscovery');
    stopped = true;
    notifyDiscoveryStopped(btAdapter);
    await sleep(POST_DISCOVERY_QUIESCE_MS);
    const refiltered = await applyFilterAndStart(btAdapter);
    bleLog.debug('Discovery restarted with the duplicate filter');
    if (refiltered) filteredScans.set(btAdapter, generation);
    return 'done';
  } catch (err) {
    if (isStuckEvidence(err)) return { stuck: err };
    if (stopped) {
      // Our own Stop went through, so there is no existing scan left to
      // continue with: the tiers have to start one.
      bleLog.debug(`Discovery did not start again after stopping it: ${errMsg(err)}`);
      return 'escalate';
    }
    if (!isNoDiscoveryStarted(err)) {
      // Could not cycle it. A deduplicating scan still finds devices and still
      // reads a connectable scale, so continuing beats failing the cycle.
      bleLog.debug(
        `Could not restart discovery (${errMsg(err)}); continuing with the existing scan`,
      );
      return 'done';
    }
  }
  try {
    const { filtered } = await rejoinAndRestart(btAdapter, abortSignal);
    if (filtered) filteredScans.set(btAdapter, generation);
    // Neutral on purpose: on a shared adapter (Home Assistant) this is the
    // ordinary case of joining a scan another client runs.
    announceOnce(
      'rejoin',
      'info',
      'Discovery was already running under a session that is not ours; ' +
        'restarted it under our own session.',
    );
    bleLog.debug('Discovery rejoined and restarted with the duplicate filter');
    return 'done';
  } catch (err) {
    if (isStuckEvidence(err)) return { stuck: err };
    bleLog.debug(`Could not take over discovery: ${errMsg(err)}`);
    return 'escalate';
  }
}

function stuck(err: unknown): 'stuck' {
  announceStuckDiscovery(err);
  return 'stuck';
}

/**
 * How a restart of a stalled scan ended, for the scan activity watchdog.
 * 'shared': other clients' sessions kept Discovering on, so our stop and start
 * only left and rejoined their scan (see othersStillDiscovering()).
 */
export type StalledScanRestart = 'restarted' | 'shared' | 'failed' | 'stuck';

/**
 * Restart a scan that stopped delivering advertisements while BlueZ still
 * reports Discovering, without leaving the wait that is running on it.
 *
 * On the maintainer's Pi this happened to a session that was ours, mid-scan
 * and with nothing done on our side: the device list fell from 32 to 15 and
 * hci0 stopped receiving advertising reports while Discovering stayed true.
 * Our own StopDiscovery clears that when bluetoothd's discovery_enable is 0
 * (discovery_stop()'s local path), and the start after it reaches the kernel.
 * A session that is not ours (any more) goes through rejoinAndRestart().
 *
 * Unlike startDiscoverySafe() this never resets the D-Bus connection: the
 * caller is still waiting on the adapter object it holds, and a reset would
 * pull the bus out from under that wait. Stuck evidence is reported and left
 * to the next cycle's startDiscoverySafe(), which the cleared latch sends down
 * the restart branch again.
 */
export async function restartStalledDiscovery(
  btAdapter: Adapter,
  abortSignal?: AbortSignal,
): Promise<StalledScanRestart> {
  const generation = currentConnectionGeneration();
  let result: { filtered: boolean; shared: boolean };
  try {
    let ours = true;
    try {
      await bluezCall(btAdapter, 'StopDiscovery');
    } catch (err) {
      if (!isNoDiscoveryStarted(err)) throw err;
      ours = false;
    }
    notifyDiscoveryStopped(btAdapter);
    if (!ours) {
      result = await rejoinAndRestart(btAdapter, abortSignal);
    } else if (await othersStillDiscovering(btAdapter)) {
      // Back into their scan straight away: this wait has no session without it.
      result = { filtered: await applyFilterAndStart(btAdapter), shared: true };
    } else {
      await abortableSleep(POST_DISCOVERY_QUIESCE_MS, abortSignal);
      result = { filtered: await applyFilterAndStart(btAdapter), shared: false };
    }
  } catch (err) {
    notifyDiscoveryStopped(btAdapter);
    if (isStuckEvidence(err)) return stuck(err);
    bleLog.debug(`Could not restart the stalled discovery: ${errMsg(err)}`);
    return 'failed';
  }
  // The latch is what keeps the next cycle from cycling this scan again
  // (#397), and only a filter BlueZ accepted earns it (#372).
  if (result.filtered) filteredScans.set(btAdapter, generation);
  return result.shared ? 'shared' : 'restarted';
}

/**
 * Try to start BlueZ discovery with escalating recovery strategies.
 *
 * Returns the (possibly refreshed) adapter on success. When every attempt
 * failed it returns false, unless one of them replaced the D-Bus connection:
 * then the adapter from the new connection comes back anyway, because the one
 * the caller holds belongs to a bus that no longer exists.
 */
export async function startDiscoverySafe(
  btAdapter: Adapter,
  bleAdapter?: string,
  opts: StartDiscoveryOptions = {},
): Promise<Adapter | false> {
  // Read once: every latch write below records the connection this scan
  // belongs to, and a reset mid-function would otherwise stamp the wrong one.
  const generation = currentConnectionGeneration();

  // Read once and logged: a Discovering that is on while the session is not
  // ours is the phantom state rejoinAndRestart clears, and without this line a
  // DEBUG log could not tell it from a scan we own.
  let discovering: boolean | undefined;
  try {
    discovering = await btAdapter.isDiscovering();
  } catch (e) {
    bleLog.debug(`Could not read Discovering: ${errMsg(e)}`);
  }
  bleLog.debug(
    `Discovery state at start: Discovering=${discovering ?? 'unknown'}, ` +
      `our filtered session=${runningScanIsFiltered(btAdapter) ? 'yes' : 'no'}`,
  );

  let skipDbusTiers = false;
  /** The adapter of a connection a step below had to replace. */
  let live: Adapter | undefined;

  /**
   * On stuck evidence (isStuckEvidence()), from whichever step saw it.
   *
   * Dropping our bus is the one thing that ends a call BlueZ will never answer:
   * bluetoothd runs discovery_disconnect() -> discovery_stop() for our client,
   * and stop_discovery_complete() answers the held message and frees the
   * client. Only our client goes; another one's scan is untouched. It does not
   * clear the stuck discovery_enable itself, which is what the warning is for.
   *
   * Tier 2 would only join the same stuck state and report it as a scan, and
   * tier 3's power cycle does not reset discovery_enable: its start would then
   * wait out the call deadline again, every cycle. What is left acts below
   * bluetoothd's D-Bus state.
   */
  const leaveStuckSession = async (err: unknown): Promise<void> => {
    announceStuckDiscovery(err);
    resetConnection();
    try {
      btAdapter = await getAdapter(bleAdapter);
      live = btAdapter;
    } catch (e) {
      bleLog.debug(`Could not reconnect to BlueZ: ${errMsg(e)}`);
    }
    skipDbusTiers = true;
  };

  // 1. Normal start, only while nothing is reported running: a scan that is
  // already up goes to the branch below, not to BlueZ's per-sender refusal.
  // The recovery tiers further down use the same unguarded call on purpose:
  // each has just stopped discovery or reset the adapter, and re-reading
  // `Discovering` there would only race a property BlueZ updates
  // asynchronously. BlueZ refuses a second StartDiscovery per sender, not per
  // adapter, so where a DIFFERENT client holds a session a recovery step simply
  // joins it, which is the correct outcome.
  if (discovering !== true) {
    try {
      const filtered = await applyFilterAndStart(btAdapter);
      bleLog.debug('Discovery started');
      if (filtered) filteredScans.set(btAdapter, generation);
      return btAdapter;
    } catch (e) {
      bleLog.debug(`startDiscovery failed: ${errMsg(e)}`);
      // Discovering off with discovery_enable stuck at 1 is what adapter_stop()
      // leaves after any power cycle in the stuck state (ble.adapter_privacy's
      // btmgmt cycle, tiers 4 and 5, the preemptive reset after GATT): the
      // start is held for good (start_discovery_timeout()).
      if (isStuckEvidence(e)) await leaveStuckSession(e);
    }
  }

  // Already running. Continuing is right only if the session is ours: one
  // started by an earlier cycle carries whatever filter was in force then, so a
  // restart-driven continuous run would inherit a deduplicating scan for the
  // rest of the process lifetime, which is how #372 stayed frozen across
  // cycles. And one that is not ours may be no scan at all (the phantom state,
  // see rejoinAndRestart). Cycle it once so the filter takes and the session is
  // ours.
  //
  // Safe here specifically because no device has been found yet: StopDiscovery
  // makes BlueZ drop Device1 objects (#297), and the whole point of doing it at
  // this moment is that there is nothing yet to lose.
  if (!skipDbusTiers && (discovering === true || (await btAdapter.isDiscovering()))) {
    // Only ONCE per connection. The running scan being ours and already
    // filtered is the normal state of every cycle after the first, and cycling
    // it again each time would be actively harmful: StopDiscovery makes BlueZ
    // drop its Device1 objects (#297), throwing away everything it learned
    // while we were between cycles, and the quiesce that follows is a window
    // with the radio not scanning at all. A reporter with a scale that
    // advertises in short bursts saw exactly that, nine cycles in a row (#397).
    if (runningScanIsFiltered(btAdapter)) {
      bleLog.debug('Discovery already active and already filtered; continuing with it');
      return btAdapter;
    }
    bleLog.debug('Discovery already active; restarting it so the duplicate filter applies');
    const outcome = await restartRunningDiscovery(btAdapter, generation, opts.abortSignal);
    if (outcome === 'done') return btAdapter;
    if (outcome !== 'escalate') await leaveStuckSession(outcome.stuck);
  }

  // A shutdown or an abandoned cycle has no use for a power cycle or a restart
  // of bluetoothd, so every tier from here on checks for one first.
  if (opts.abortSignal?.aborted) {
    bleLog.debug('Discovery did not start; skipping the recovery steps while aborting');
    return live ?? false;
  }

  if (!skipDbusTiers) {
    // 2. Force-stop via D-Bus (bypass node-ble's isDiscovering guard) + retry
    bleLog.debug('Attempting D-Bus StopDiscovery to reset stale state...');
    let stuckErr: unknown;
    try {
      await bluezCall(btAdapter, 'StopDiscovery');
      bleLog.debug('D-Bus StopDiscovery succeeded');
    } catch (e) {
      bleLog.debug(`D-Bus StopDiscovery failed: ${errMsg(e)}`);
      if (isStuckEvidence(e)) stuckErr = e;
    }

    if (stuckErr === undefined) {
      await sleep(1000);
      try {
        if (await applyFilterAndStart(btAdapter)) filteredScans.set(btAdapter, generation);
        bleLog.debug('Discovery started after D-Bus reset');
        return btAdapter;
      } catch (e) {
        bleLog.debug(`startDiscovery after D-Bus reset failed: ${errMsg(e)}`);
        if (isStuckEvidence(e)) stuckErr = e;
      }
    }
    if (stuckErr !== undefined) await leaveStuckSession(stuckErr);
  }

  if (!skipDbusTiers) {
    // 3. Power-cycle the adapter + retry
    if (opts.abortSignal?.aborted) return live ?? false;
    bleLog.debug('Attempting adapter power cycle...');
    if (await powerCycleViaDbus(btAdapter, opts.abortSignal)) {
      notifyDiscoveryStopped(btAdapter);
      try {
        if (await applyFilterAndStart(btAdapter)) filteredScans.set(btAdapter, generation);
        bleLog.debug('Discovery started after power cycle');
        return btAdapter;
      } catch (e) {
        bleLog.debug(`startDiscovery after power cycle failed: ${errMsg(e)}`);
        // Too late to skip anything, but the held start must not stay on the
        // bus the next cycle talks over.
        if (isStuckEvidence(e)) await leaveStuckSession(e);
      }
    }
  }

  // 4. Kernel-level adapter reset via btmgmt + fresh D-Bus connection
  if (opts.abortSignal?.aborted) return live ?? false;
  bleLog.debug('Attempting kernel-level adapter reset via btmgmt...');
  if (await resetAdapterBtmgmt(parseHciIndex(bleAdapter))) {
    resetConnection();
    try {
      const freshAdapter = await getAdapter(bleAdapter);
      live = freshAdapter;
      // A reset replaced the connection, so read the generation again.
      if (await applyFilterAndStart(freshAdapter)) {
        filteredScans.set(freshAdapter, currentConnectionGeneration());
      }
      bleLog.debug('Discovery started after btmgmt reset');
      return freshAdapter;
    } catch (e) {
      bleLog.debug(`startDiscovery after btmgmt reset failed: ${errMsg(e)}`);
    }
  }

  // 5. RF-level reset via rfkill (more thorough than btmgmt)
  bleLog.debug('Attempting rfkill block/unblock...');
  if (await resetAdapterRfkill()) {
    resetConnection();
    try {
      const freshAdapter = await getAdapter(bleAdapter);
      live = freshAdapter;
      // A reset replaced the connection, so read the generation again.
      if (await applyFilterAndStart(freshAdapter)) {
        filteredScans.set(freshAdapter, currentConnectionGeneration());
      }
      bleLog.debug('Discovery started after rfkill reset');
      return freshAdapter;
    } catch (e) {
      bleLog.debug(`startDiscovery after rfkill reset failed: ${errMsg(e)}`);
    }
  }

  // 6. Restart bluetoothd service (clears all D-Bus session state)
  bleLog.debug('Attempting bluetoothd service restart...');
  if (await restartBluetoothd()) {
    resetConnection();
    // bluetoothd applies its own Privacy setting on start, which can clear
    // ble.adapter_privacy's. No-op when the option is off (#417).
    await reensureAdapterPrivacy();
    try {
      const freshAdapter = await getAdapter(bleAdapter);
      live = freshAdapter;
      // A reset replaced the connection, so read the generation again.
      if (await applyFilterAndStart(freshAdapter)) {
        filteredScans.set(freshAdapter, currentConnectionGeneration());
      }
      bleLog.debug('Discovery started after bluetoothd restart');
      return freshAdapter;
    } catch (e) {
      bleLog.debug(`startDiscovery after bluetoothd restart failed: ${errMsg(e)}`);
    }
  }

  // All strategies failed
  bleLog.warn(
    'Could not start active discovery. ' +
      'Proceeding with passive scanning (device may take longer to appear).',
  );
  return live ?? false;
}

/**
 * Remove a device from BlueZ D-Bus cache to force a fresh proxy on re-discovery.
 *
 * `includeBonded` also deletes the stored pairing keys, which is destructive and
 * is only ever passed by the stale-bond recovery in connect.ts, behind
 * `ble.auto_clear_stale_bond` (#335).
 */
export async function removeDevice(
  btAdapter: Adapter,
  mac: string,
  opts: { includeBonded?: boolean } = {},
): Promise<void> {
  const formatted = formatMac(mac);

  // Never remove a bonded device: BlueZ RemoveDevice deletes the stored pairing
  // keys (LTK), which desyncs the host bond from the scale's retained bond and
  // makes the next run's re-pair time out (#168 Beurer BF720). Only unpaired
  // devices need the fresh-proxy reset (#80/#81); bonded scales keep their bond
  // so the next connect re-encrypts with the stored LTK instead of pairing.
  let paired: boolean;
  let probe: Device | undefined;
  try {
    probe = await btAdapter.getDevice(formatted);
    // Deliberately NOT the shared isBonded() helper in dbus.ts: that one answers
    // false for any failure, which is right where the answer gates a diagnostic
    // or a retry. Here it gates a DESTRUCTIVE RemoveDevice, so an unknown bond
    // state must abort rather than read as "not bonded" and delete a real bond.
    // The two semantics are the reason this copy stays a copy (#406).
    //
    // node-ble types isPaired() loosely; BusHelper.prop unwraps the Variant to a
    // real boolean at runtime, so the cast goes through unknown.
    paired = ((await probe.isPaired()) as unknown as boolean) === true;
  } catch (err) {
    // 'Device not found' => not in the BlueZ cache, so there is no bond to
    // preserve and removal is a harmless no-op; proceed. Any OTHER error is a
    // transient D-Bus failure on a device that may well be bonded, so fail safe
    // and skip removal rather than risk wiping a real bond.
    if (!errMsg(err).includes('Device not found')) {
      bleLog.debug(`Skipping RemoveDevice: bond state unknown (${errMsg(err)})`);
      return;
    }
    // Worth a line: an absent node here means BlueZ already dropped the peer's
    // object, which is the signature of #297.
    bleLog.debug('Device not in BlueZ cache; RemoveDevice is a no-op');
    paired = false;
  } finally {
    // The proxy exists only to read isPaired(); the removal below goes through
    // the adapter. Holding it would leak a match rule per cycle (#396, #397).
    if (probe) releaseDeviceProxy(probe);
  }
  if (paired && !opts.includeBonded) {
    bleLog.debug('Skipping RemoveDevice: device is bonded (preserving pairing keys)');
    return;
  }
  if (paired) {
    bleLog.warn(`Removing the bond for ${formatted} along with the BlueZ device object.`);
  }

  try {
    const devSerialized = `dev_${formatted.replace(/:/g, '_')}`;
    const adapterHelper = helperOf(btAdapter);
    await adapterHelper.callMethod('RemoveDevice', `${adapterHelper.object}/${devSerialized}`);
    bleLog.debug('Removed device from BlueZ cache');
  } catch {
    // Device wasn't in cache
  }
}

/**
 * How many looks a device that seemed incomplete gets before it is written off
 * (A-05). A failed lookup counts as an incomplete look too.
 *
 * BlueZ creates the Device1 object from the first advertising report it is
 * handed, and that report can lack the scan response. The kernel holds an
 * ADV_IND back to merge it with its SCAN_RSP, but sends it on alone as soon as
 * a report from any other address arrives first (`process_adv_report()` in
 * net/bluetooth/hci_event.c: "If the pending data doesn't match this report
 * ... force sending of the pending data"), which in a busy room is routine. A
 * scale that puts its name in the scan response then appears with no Name,
 * and gets it a moment later. Writing it off on the first look made it
 * invisible for the whole discovery window while it advertised throughout.
 *
 * Bounded rather than open-ended because every look costs a proxy and a match
 * rule (#396, #397), and plenty of nearby devices never advertise a name at
 * all. Five looks span about ten seconds of polling, far longer than a scan
 * response takes to follow its advertisement.
 */
const INCOMPLETE_LOOK_LIMIT = 5;

export async function autoDiscover(
  btAdapter: Adapter,
  adapters: ScaleAdapter[],
  abortSignal?: AbortSignal,
): Promise<{ device: Device; adapter: ScaleAdapter; mac: string; name: string }> {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  /** Devices looked at with nothing left to learn; never evaluated again. */
  const checked = new Set<string>();
  /** How many polls found each device incomplete (see INCOMPLETE_LOOK_LIMIT). */
  const incompleteLooks = new Map<string, number>();
  const settle = (addr: string, complete: boolean): void => {
    if (complete) {
      checked.add(addr);
      return;
    }
    const looks = (incompleteLooks.get(addr) ?? 0) + 1;
    incompleteLooks.set(addr, looks);
    if (looks >= INCOMPLETE_LOOK_LIMIT) checked.add(addr);
  };
  let heartbeat = 0;

  while (Date.now() < deadline) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    const addresses: string[] = await btAdapter.devices();

    for (const addr of addresses) {
      if (checked.has(addr)) continue;

      // Every device BlueZ knows gets a throwaway proxy here, and each one costs
      // a D-Bus match rule plus a listener on the bus-wide signal emitter until
      // it is released. Only the matched device survives the loop, so every
      // other proxy is handed back before the next iteration (#396, #397).
      let dev: Device | undefined;
      let matchedDevice = false;
      let complete = false;
      try {
        dev = await btAdapter.getDevice(addr);
        const name = await dev.getName().catch(() => '');
        if (!name) continue;

        bleLog.debug(`Discovered: ${safeName(name)} [${addr}]`);

        // Match on the name plus whatever the advertisement exposes. BlueZ does
        // not publish advertised service UUIDs before a connection, so an
        // adapter that matches only on serviceUuids still needs `ble.scale_mac`,
        // but ManufacturerData and ServiceData ARE exposed and are what
        // identifies a broadcast-only scale whose name says nothing: the
        // Silvergear 108 advertises itself as "108" (#297).
        //
        // The loop above skips a device with no name at all, so a genuinely
        // nameless broadcast peer is still only reachable through `ble.scale_mac`.
        const advert = await logAdvertisementSnapshot(dev).catch(() => undefined);
        const info: BleDeviceInfo = {
          localName: name,
          address: formatMac(addr),
          serviceUuids: [],
          ...(advert?.manufacturerData ? { manufacturerData: advert.manufacturerData } : {}),
          ...(advert?.serviceData && advert.serviceData.length > 0
            ? { serviceData: advert.serviceData }
            : {}),
        };
        const matched = resolveAdapter(info, adapters);
        if (matched) {
          bleLog.info(`Auto-discovered: ${matched.name} (${safeName(name)} [${addr}])`);
          matchedDevice = true;
          return { device: dev, adapter: matched, mac: addr, name };
        }
        // A name but no advertisement data at all may be the same split
        // seen from the other side: name in one packet, manufacturer or
        // service data in the other.
        complete = advert?.manufacturerData !== undefined || (advert?.serviceData?.length ?? 0) > 0;
      } catch {
        /* device may have gone away */
      } finally {
        if (dev && !matchedDevice) releaseDeviceProxy(dev);
        if (!matchedDevice) settle(addr, complete);
      }
    }

    heartbeat++;
    if (heartbeat % 5 === 0) {
      bleLog.info('Still scanning...');
    }
    await sleep(DISCOVERY_POLL_MS);
  }

  throw new Error(`No recognized scale found within ${DISCOVERY_TIMEOUT_MS / 1000}s`);
}
