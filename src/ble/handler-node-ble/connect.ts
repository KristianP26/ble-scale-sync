import {
  bleLog,
  formatMac,
  sleep,
  abortableSleep,
  errMsg,
  untilAborted,
  withTimeout,
  CONNECT_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  POST_DISCOVERY_QUIESCE_MS,
  StaleLinkError,
} from '../types.js';
import { isDebugEnabled } from '../../logger.js';
import { helperOf, isBonded, releaseDeviceProxy, type Adapter, type Device } from './dbus.js';
import {
  startDiscoverySafe,
  removeDevice,
  stopDiscoveryAndQuiesce,
  notifyDiscoveryStopped,
  withBluezDeadline,
} from './discovery.js';
import { disconnectBounded } from './stale-link.js';
import { startPeerFreshnessTracker } from './freshness.js';
import {
  classifyAttempt,
  describeAttempt,
  isAuthClassConnectFailure,
  shouldSettle,
  staleBondMessage,
  LINK_SETTLE_MS,
  STALE_BOND_EVIDENCE_ATTEMPTS,
  type AttemptEvidence,
} from './stale-bond.js';
import { observeConnectAttempt, type AttemptLinkView, type LinkObserver } from './link-observer.js';
import { isDeviceObjectGone } from './device-object.js';
import { requireAdapterPrivacy } from './privacy.js';
import { bleFailureKind, tagBleFailure } from '../failure-kind.js';

/** Bound on the two property reads behind the debug line before a connect. */
const LINK_CHECK_TIMEOUT_MS = 5_000;

/**
 * Debug only: what BlueZ says about the link before this cycle's first connect.
 * `Connected=true` here is a link left over from an earlier session that BlueZ
 * never let go of (#472). Nothing acts on it: a stuck link is recovered in the
 * teardown, and ServicesResolved can be true on one too, so it would not make
 * a complete rule anyway. Without DEBUG this costs no D-Bus call at all.
 */
async function logLinkStateBeforeConnect(device: Device): Promise<void> {
  if (!isDebugEnabled()) return;
  try {
    const helper = helperOf(device);
    const [connected, resolved] = await withTimeout(
      Promise.all([helper.prop('Connected'), helper.prop('ServicesResolved')]),
      LINK_CHECK_TIMEOUT_MS,
      `no answer within ${LINK_CHECK_TIMEOUT_MS / 1000}s`,
    );
    bleLog.debug(
      `Link check before connect: Connected=${String(connected)}, ServicesResolved=${String(resolved)}`,
    );
  } catch (err) {
    bleLog.debug(`Link check before connect failed: ${errMsg(err)}`);
  }
}

/** Debug only: how a failed attempt's connection ended (#471, D066). */
function logAttemptEnd(
  outcome: AttemptEvidence,
  attempt: number,
  total: number,
  link: AttemptLinkView | undefined,
  err: unknown,
  ms: number,
): void {
  const line = describeAttempt({ attempt, total, ms, error: errMsg(err), outcome, link });
  if (line) bleLog.debug(line);
}

export interface ConnectRecoveryContext {
  btAdapter: Adapter;
  mac: string;
  initialDevice: Device;
  maxRetries: number;
  bleAdapter?: string;
  /**
   * Do not stop BlueZ discovery between attempts: the peer's Device1 object
   * only exists while a discovery session is active (#297). Normally left
   * unset; the loop arms it by itself when it sees the object disappear.
   */
  keepDiscoveryDuringConnect?: boolean;
  /**
   * Delete a bond the peer has forgotten and pair again, rather than stopping at
   * the diagnostic (`ble.auto_clear_stale_bond`, #335). Off by default.
   */
  autoClearStaleBond?: boolean;
  /**
   * `ble.adapter_privacy` (#417). The caller checks privacy right before
   * handing over; this re-checks before any connect that follows a
   * startDiscoverySafe in here, since its bluetoothd restart tier can clear it.
   */
  adapterPrivacy?: boolean;
  /**
   * Shutdown. Up to six 30 s connect attempts with re-discovery in between is
   * far past the 5 s force-exit grace, and a hard exit skips teardownSession,
   * leaving the LE link to the scale up (A-07).
   */
  abortSignal?: AbortSignal;
  /**
   * Told about every adapter and device the retry loop moves to. A
   * startDiscoverySafe in here can replace the D-Bus connection, and the
   * caller's teardown has to reach BlueZ through the live one: a call through
   * a proxy on the old bus fails as soon as that bus is gone (connection.ts)
   * and never gets to BlueZ (#472). Once a device has been handed over this
   * way it is the caller's, on a throw too, and this function releases only
   * the ones it replaces. Without it the caller still holds what it passed in
   * on the old adapter, and that device is released here anyway once the loop
   * swaps it, so every caller that tears down a session passes this.
   */
  onLive?: (live: { btAdapter: Adapter; device: Device }) => void;
}

/**
 * `btAdapter.waitDevice()` bounded by a timeout, releasing the proxy nobody
 * asked for any more.
 *
 * `withTimeout` abandons the promise it raced rather than cancelling it, so a
 * waitDevice that resolves one millisecond past the deadline hands back a
 * Device proxy this function has already stopped waiting for. That proxy still
 * registers its match rule and bus listener the first time a property is read,
 * and nothing else can ever reach it (#404, same mechanism as #396/#397).
 */
async function waitDeviceBounded(
  btAdapter: Adapter,
  formattedMac: string,
  timeoutMessage: string,
  abortSignal?: AbortSignal,
): Promise<Device> {
  let abandoned = false;
  const pending = btAdapter.waitDevice(formattedMac);
  pending
    .then((late) => {
      if (abandoned) releaseDeviceProxy(late);
    })
    .catch(() => {
      /* the timeout below is what the caller sees */
    });
  try {
    // An abort abandons the wait exactly like the deadline does, so the late
    // proxy is released by the same path.
    return await untilAborted(
      withTimeout(pending, DISCOVERY_TIMEOUT_MS, timeoutMessage),
      abortSignal,
    );
  } catch (err) {
    abandoned = true;
    throw err;
  }
}

/**
 * Hand back a Device proxy that has just been replaced by a fresh one for the
 * same peer.
 *
 * `waitDevice`/`getDevice` build a brand new proxy every time, and each one
 * holds a listener on the bus-wide signal emitter plus a D-Bus match rule until
 * it is released. A retry loop that swaps the reference without releasing is
 * exactly the per-path listener growth reported in #397. Guarded on identity
 * because the fallback path can legitimately hand back the same object.
 */
function releaseSuperseded(previous: Device, current: Device): void {
  if (previous !== current) releaseDeviceProxy(previous);
}

/**
 * Connect to a BLE device with recovery for BlueZ-specific failures.
 * On each failed attempt: disconnect -> RemoveDevice -> re-discover -> quiesce -> retry.
 * Returns the (possibly refreshed) Device reference; ctx.onLive hears of every
 * adapter and device it moves to on the way, a throw included.
 */
export async function connectWithRecovery(ctx: ConnectRecoveryContext): Promise<Device> {
  let { btAdapter } = ctx;
  const { mac, maxRetries, bleAdapter, abortSignal } = ctx;
  const formattedMac = formatMac(mac);
  const throwIfAborted = (): void => {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new DOMException('Aborted', 'AbortError');
    }
  };
  let device = ctx.initialDevice;
  // RSSI freshness re-discovery is a one-shot defense per call: if the peer
  // already looks dark, we re-discover once. Repeating it on every retry just
  // burns the budget on a peer that never came back; let the outer loop pick
  // the next cooldown instead.
  let rssiRediscoverUsed = false;
  // Armed either by the caller or, reactively, the first time BlueZ is caught
  // deleting the peer's Device1 object while discovery is stopped (#297). Off
  // by default, so every other node-ble user takes the identical code path.
  let keepDiscovery = ctx.keepDiscoveryDuringConnect === true;
  let sawObjectGone = false;
  // Consecutive authentication-class failures, reset by any other error (#290).
  let authClassFailures = 0;
  // The current attempt's link: whether it came up, when it went down, and
  // why (#471, D066).
  let observer: LinkObserver | undefined;
  // Ask BlueZ for disconnect reasons only once a connection came up and
  // failed: a scale that connects, or never gets a link, costs no D-Bus call.
  let probeReasons = false;
  // One bond deletion per connectWithRecovery call, and only with the opt-in.
  // Repeating it would delete the bond the previous attempt just established,
  // turning a scale that needs two goes at pairing into an endless re-pair.
  let staleBondCleared = false;
  // Set before every startDiscoverySafe below, not after: a call that throws
  // may still have restarted bluetoothd on its way (#417).
  let privacyCheckDue = false;
  // Long-lived PropertiesChanged subscription on the current device proxy so
  // every received advertisement updates the freshness clock. The tracker is
  // rebound when the catch branch swaps the device reference.
  let tracker = startPeerFreshnessTracker(device);
  // Set immediately before each return, so the finally can tell "handing this
  // proxy to the caller" from "leaving by exception".
  let succeeded = false;
  // The device the caller holds: its own, or the last one handed over below.
  let handedOver = ctx.initialDevice;
  /** Hand the caller what the loop uses now; no-op without ctx.onLive. */
  const reportLive = (): void => {
    if (!ctx.onLive) return;
    handedOver = device;
    ctx.onLive({ btAdapter, device });
  };
  const adoptAdapter = (result: Adapter | false): void => {
    if (!result || result === btAdapter) return;
    btAdapter = result;
    reportLive();
  };

  try {
    await logLinkStateBeforeConnect(device);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let t0 = Date.now();
      try {
        throwIfAborted();
        // Skip the dying-peer connect attempt: a missing or 127-sentinel RSSI
        // OR no PropertiesChanged for RSSI within RSSI_FRESHNESS_MS means
        // BlueZ has not heard a fresh advertisement, and connect will stall
        // inside GATT discovery (#143). Force one re-discovery to either
        // refresh the cached props or fail fast.
        if (!(await tracker.isFresh())) {
          if (rssiRediscoverUsed) {
            throw new Error(`Peer ${formattedMac} not advertising (RSSI stale after re-discovery)`);
          }
          rssiRediscoverUsed = true;
          bleLog.warn(`Peer ${formattedMac} RSSI stale, re-discovering before connect...`);
          // Inner try wraps only the D-Bus rediscovery itself so its failures
          // map to "skipped connect to dying peer". The post-rediscovery
          // freshness check throws its own clear message outside the wrap.
          try {
            tracker.stop();
            privacyCheckDue = true;
            adoptAdapter(await startDiscoverySafe(btAdapter, bleAdapter, { abortSignal }));
            const supersededByRediscovery = device;
            device = await waitDeviceBounded(
              btAdapter,
              formattedMac,
              `Device ${formattedMac} not found during RSSI re-discovery`,
              abortSignal,
            );
            // Every swap here is a fresh proxy for the same path. Stopping the
            // tracker unhooks OUR listener but not the one node-ble's BusHelper
            // registered when the old proxy first read a property, so without
            // this the retry loop is itself a source of the listener growth in
            // #397.
            releaseSuperseded(supersededByRediscovery, device);
            reportLive();
            tracker = startPeerFreshnessTracker(device);
            if (keepDiscovery) {
              await sleep(POST_DISCOVERY_QUIESCE_MS);
            } else {
              await stopDiscoveryAndQuiesce(btAdapter);
            }
          } catch (rssiErr: unknown) {
            throw new Error(`Skipped connect to dying peer ${formattedMac}: ${errMsg(rssiErr)}`);
          }
          if (!(await tracker.isFresh())) {
            throw new Error(`Peer ${formattedMac} still not advertising after re-discovery`);
          }
        }

        // A pairing made now, without privacy, would carry no host IdKey: the
        // bond the scale throws away (#417).
        if (ctx.adapterPrivacy && privacyCheckDue) {
          await requireAdapterPrivacy(btAdapter);
          privacyCheckDue = false;
        }

        // On the device as it is now: a retry may have moved to a new adapter
        // and D-Bus connection.
        const obs = await observeConnectAttempt(device, { probeReasons, abortSignal });
        observer = obs;
        // The probe can take up to 2 s; a shutdown meanwhile must not send a Connect.
        throwIfAborted();

        t0 = Date.now();
        bleLog.debug(`Connect attempt ${attempt + 1}/${maxRetries + 1}...`);
        obs.markConnectStart();
        const pending = device.connect();
        // The first handler on the call: the error time the link is measured from.
        pending.catch(() => obs.markError());
        // On abort the pending Connect is left to teardownSession, whose
        // Disconnect on the same device path cancels it in BlueZ.
        await untilAborted(
          withTimeout(pending, CONNECT_TIMEOUT_MS, 'Connection timed out'),
          abortSignal,
        );
        bleLog.debug(`Connected (took ${Date.now() - t0}ms)`);
        obs.stop();
        observer = undefined;
        if (keepDiscovery) {
          // Restore the "no discovery during GATT" invariant the callers rely
          // on. Safe now: BlueZ does not drop a device object while it is
          // Connected, which is what let this peer be reached at all (#297).
          bleLog.debug('Connected with discovery active; stopping discovery for the GATT phase');
          await stopDiscoveryAndQuiesce(btAdapter);
        }
        succeeded = true;
        return device;
      } catch (err: unknown) {
        // A timeout never settles the Connect call, so its error time is now.
        observer?.markError();
        const attemptMs = Date.now() - t0;
        // A shutdown is not a connect failure: no retry, no diagnosis, and the
        // abort reason rather than whatever the abandoned step wrapped it in.
        throwIfAborted();
        // A refused precondition is not a connect failure: retrying cannot fix
        // it, and the retry path would delete the device and rediscover.
        if (bleFailureKind(err) === 'blocked') throw err;
        const msg = errMsg(err);
        authClassFailures = isAuthClassConnectFailure(err) ? authClassFailures + 1 : 0;
        if (isDeviceObjectGone(err)) sawObjectGone = true;
        if (sawObjectGone && !keepDiscovery) {
          keepDiscovery = true;
          bleLog.warn(
            `BlueZ removed the org.bluez.Device1 object for ${formattedMac} while discovery was stopped, so this peer is only visible while scanning is active. Retrying with discovery left running (#297).`,
          );
        }
        if (attempt >= maxRetries) {
          // Latched, not just the last error: once BlueZ has been caught
          // dropping the object, that is the story worth telling even if the
          // final attempt happened to time out instead.
          if (sawObjectGone) {
            throw new Error(
              `Connection failed after ${maxRetries + 1} attempts: BlueZ keeps removing the D-Bus object for ${formattedMac}, so no GATT connection can be opened. The scale advertises but does not accept connections (broadcast only or non-discoverable). Last error: ${msg}`,
            );
          }
          // No Disconnect follows the last attempt, so BlueZ's word on how
          // its connection ended (Connected=false, from 5.83 the reason) may
          // still be on its way: on a refused key it comes about one
          // connection interval after the error.
          if (observer && shouldSettle(err, observer.view())) {
            await observer.settle(LINK_SETTLE_MS, abortSignal);
          }
          throwIfAborted();
          const lastLink = observer?.view();
          logAttemptEnd(
            classifyAttempt(err, lastLink),
            attempt + 1,
            maxRetries + 1,
            lastLink,
            err,
            attemptMs,
          );
          observer?.stop();
          observer = undefined;
          // A run of authentication-class aborts against a peer BlueZ still
          // lists as bonded is the #290 signature: the scale rejected the
          // stored key. Say so, with the remedy, instead of surfacing the bare
          // BlueZ string that told nobody anything. Diagnosis only, since the
          // same string also has benign producers (a connect issued while
          // discovery is still active, or another D-Bus client holding a
          // discovery session), so we never delete the bond on our own.
          if (authClassFailures >= STALE_BOND_EVIDENCE_ATTEMPTS) {
            if (await isBonded(device)) {
              throw new Error(staleBondMessage(formattedMac, maxRetries + 1, msg));
            }
          }
          throw new Error(`Connection failed after ${maxRetries + 1} attempts: ${msg}`);
        }

        const delay = 1000 + attempt * 500;
        bleLog.warn(
          `Connect error: ${msg}. Retrying (${attempt + 1}/${maxRetries}) in ${delay}ms...`,
        );

        // 1. Disconnect (best-effort, but bounded). An unanswered one means
        // BlueZ still lists the scale as connected after the link is gone, and
        // every further attempt would "connect" at once from that state and
        // then wait for services that never come (#472). Stop here; the
        // teardown recovers the adapter.
        bleLog.debug('Disconnecting before retry...');
        const disconnected = await disconnectBounded(device, {
          mac: formattedMac,
          label: 'retry',
          abortSignal,
        });
        if (disconnected === 'aborted') throwIfAborted();
        if (disconnected === 'timeout') {
          throw tagBleFailure(new StaleLinkError(formattedMac), 'wedge-suspect');
        }

        // What this attempt's connection did, read only now: BlueZ sends
        // Connected=false, and from 5.83 the reason, before it answers the
        // Disconnect above.
        const link = observer?.view();
        const outcome = classifyAttempt(err, link);
        logAttemptEnd(outcome, attempt + 1, maxRetries + 1, link, err, attemptMs);
        if (link?.linkUp && outcome !== 'other') probeReasons = true;
        observer?.stop();
        observer = undefined;

        // 2. Purge stale D-Bus proxy. With the opt-in, a run of
        // authentication-class failures against a peer BlueZ still lists as
        // bonded also takes the pairing keys with it: the peripheral has
        // forgotten its half, and the bonded guard in removeDevice would
        // otherwise keep the dead key alive forever and lock the host out of
        // the scale until someone runs `bluetoothctl remove` (#335).
        const clearBond =
          ctx.autoClearStaleBond === true &&
          !staleBondCleared &&
          authClassFailures >= STALE_BOND_EVIDENCE_ATTEMPTS &&
          (await isBonded(device));
        if (clearBond) {
          staleBondCleared = true;
          bleLog.warn(
            `${formattedMac} rejected the stored pairing key on ${authClassFailures} ` +
              'consecutive attempts, so the bond is being cleared and re-established ' +
              '(ble.auto_clear_stale_bond). Put the scale into pairing mode if it asks.',
          );
        }
        await removeDevice(btAdapter, mac, { includeBonded: clearBond });

        // 3. Progressive delay
        await abortableSleep(delay, abortSignal);

        // 4. Re-discover and acquire fresh device reference + rebind tracker
        tracker.stop();
        const supersededByRetry = device;
        try {
          privacyCheckDue = true;
          adoptAdapter(await startDiscoverySafe(btAdapter, bleAdapter, { abortSignal }));
          device = await waitDeviceBounded(
            btAdapter,
            formattedMac,
            `Device ${formattedMac} not found during retry`,
            abortSignal,
          );

          if (keepDiscovery) {
            bleLog.debug('Leaving discovery running for the next connect attempt (#297)');
          } else {
            try {
              await withBluezDeadline(btAdapter.stopDiscovery(), 'StopDiscovery');
            } catch (err) {
              bleLog.debug(`stopDiscovery failed during retry (ignored): ${errMsg(err)}`);
            }
            // Our filtered scan is no longer running, so the claim on it has to
            // go with it or the next start would decline to re-apply the filter.
            notifyDiscoveryStopped(btAdapter);
          }
          await sleep(POST_DISCOVERY_QUIESCE_MS);
        } catch (retryErr: unknown) {
          throwIfAborted();
          bleLog.debug(`Re-discovery during retry failed: ${errMsg(retryErr)}`);
          // Fallback: try to get device directly without re-discovery
          try {
            device = await btAdapter.getDevice(formattedMac);
          } catch {
            throw new Error(
              `Connection failed and device re-acquisition failed: ${errMsg(retryErr)}`,
            );
          }
        }
        releaseSuperseded(supersededByRetry, device);
        reportLive();
        tracker = startPeerFreshnessTracker(device);
      }
    }

    throw new Error('Connection failed');
  } finally {
    observer?.stop();
    tracker.stop();
    // Every throw path leaves the proxy this function last acquired unreleased,
    // and the caller cannot compensate: `device = await connectWithRecovery()`
    // never runs when it throws, so teardownSession releases the proxy it
    // passed IN, not the one the retry loop ended up holding. That proxy has
    // certainly registered its match rule and bus listener, because the
    // freshness tracker reads RSSI off it (#404, same mechanism as #396/#397).
    //
    // Only proxies the caller does not hold: ctx.initialDevice, or the last one
    // ctx.onLive handed over, is its to disconnect and release.
    if (!succeeded && device !== handedOver) releaseDeviceProxy(device);
  }
}
