import NodeBle from 'node-ble';
import type { ScaleAdapter, BleDeviceInfo } from '../../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from '../types.js';
import type { RawReading } from '../shared.js';
import {
  findMissingCharacteristics,
  hasDeferredNotifyBinding,
  stopDeferredNotifications,
} from '../session/wiring.js';
import { resolveAdapter } from '../../scales/resolve.js';
import {
  bleLog,
  formatMac,
  sleep,
  abortableSleep,
  errMsg,
  untilAborted,
  withTimeout,
  MAX_CONNECT_RETRIES,
  DISCOVERY_POLL_MS,
  POST_DISCOVERY_QUIESCE_MS,
  GATT_DISCOVERY_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  StaleLinkError,
} from '../types.js';
import {
  helperOf,
  getDbusNext,
  isBonded,
  releaseDeviceProxy,
  type Adapter,
  type Device,
} from './dbus.js';
import { applyDbusMatchRefcountPatch } from './dbus-match-patch.js';
import {
  getBus,
  attachBusErrorHandler,
  currentConnectionGeneration,
  isDbusConnectionError,
  dbusError,
  resetConnection,
} from './connection.js';
import { ensurePairingAgent, setPairingTarget, userPromptCount } from './agent.js';
import { ensureAdapterPrivacy, requireAdapterPrivacy } from './privacy.js';
import {
  startDiscoverySafe,
  removeDevice,
  autoDiscover,
  stopDiscoveryAndQuiesce,
  runningScanIsFiltered,
} from './discovery.js';
import {
  announceKept,
  armFreshAdvertLatch,
  cachePolicyFor,
  forgetReadingAdapter,
  noScaleRecognizedMessage,
  rememberReadingAdapter,
  targetNotFoundMessage,
  type FreshAdvertLatch,
} from './device-cache.js';
import {
  advertisedReadingHint,
  hintAdapterFor,
  holdUntilPairingAllowed,
  noteAllScalesMissed,
  noteScaleMissed,
  settlePairingRecord,
} from './pairing-backoff.js';
import { connectWithRecovery } from './connect.js';
import { disconnectBounded, noteReadingForStaleLink } from './stale-link.js';
import {
  withScanActivityWatchdog,
  resetScanActivityBackoff,
  type ScanWatch,
} from './scan-watchdog.js';
import { logAdvertisementSnapshot } from './device-object.js';
import { sessionManufacturerData } from './session-advert.js';
import { wrapDevice } from './gatt.js';
import { broadcastScanNodeBle } from './broadcast.js';
import {
  acquireBluezAdapter,
  buildCharMapWithRetry,
  resolveAfterConnect,
  resolvePreConnectAdapter,
  classifyBleFailure,
  readWithTimeouts,
  teardownSession,
  waitForTargetDevice,
} from './scan-stages.js';
import { readsFromAdvertisement, safeName } from '../advertisement.js';

/** Max time to wait for a BLE pairing/bonding handshake before giving up. */
const BONDING_TIMEOUT_MS = 15_000;

/**
 * Wait after turning a deferred binding off and before disconnecting. BlueZ
 * answers StopNotify first and writes the CCCD afterwards; the vendor app's
 * own CCCD writes were answered 68 to 112 ms after the request (#408).
 */
const STOP_NOTIFY_SETTLE_MS = 500;

/**
 * Number of the most recent scanAndReadRaw() call.
 *
 * The poll loop abandons a cycle at POLL_CYCLE_TIMEOUT_MS without being able to
 * stop it, and starts the next one over the same persistent D-Bus connection
 * and the same radio. The abandoned cycle still runs to its end, and its
 * teardown used to StopDiscovery, RemoveDevice, reset the connection and
 * power-cycle the adapter underneath the cycle that replaced it (A-04).
 */
let scanCycle = 0;

/** Options `ensureBonded` takes only for a `singleBond` adapter (#408). */
export interface BondOptions {
  /** Take the default-agent role for this pairing and check the bond after it. */
  forPairing?: boolean;
}

/** Whether the "paired but not bonded" warning was printed in this process. */
let notBondedWarned = false;

/** Test hook: forget that the warning was printed. */
export function _resetNotBondedWarningForTests(): void {
  notBondedWarned = false;
}

/**
 * Warn once per process when BlueZ paired the scale without storing a bond.
 *
 * A pairing without a bond works for this one connection and is gone at the
 * next, and a scale that sends its data only to its bonded collector then
 * says nothing (#408). `Device1.Bonded` exists from BlueZ 5.65 on; where it is
 * missing, or the read fails, there is nothing to say.
 */
async function warnIfNotBonded(device: Device): Promise<void> {
  if (notBondedWarned) return;
  let bonded: unknown;
  try {
    bonded = await helperOf(device).prop('Bonded');
  } catch {
    return;
  }
  if (bonded !== false) return;
  notBondedWarned = true;
  bleLog.warn(
    'The scale is paired with this host, but BlueZ did not store the pairing as a bond, ' +
      'so it will not survive this connection. Pair it once by hand: bluetoothctl, ' +
      '"agent on", "default-agent", "pair <MAC>", "trust <MAC>", with the scale in pairing mode.',
  );
}

/**
 * Best-effort BLE bonding for adapters that need an encrypted link (#168).
 *
 * Some SIG scales (e.g. Beurer BF720, whose User Data Service 0x181C protects
 * its CCCDs) drop the link when notifications are enabled on an unbonded
 * connection. Pairing here, after connect and before subscribing, establishes
 * the encryption those characteristics require. A failure is logged and the
 * read continues unbonded so adapters that do not strictly need it are not
 * blocked; pairing may need a registered BlueZ agent on some setups.
 *
 * `_pin` is unused: the agent reads the PIN from the cycle's pairing target,
 * together with the scale's MAC. The parameter stays because acquireGattServer
 * passes this function as its bonding callback with that signature.
 *
 * `opts.forPairing` is passed only for an adapter with `singleBond` (#408).
 * It lets the agent take the default role for this one pairing, which is what
 * makes an adapter without a PIN bondable on a BlueZ older than 5.51, and it
 * checks afterwards that BlueZ stored the pairing as a bond. Every other
 * adapter calls this exactly as before, with three arguments.
 */
export async function ensureBonded(
  device: Device,
  _pin: number | undefined,
  abortSignal?: AbortSignal,
  opts?: BondOptions,
): Promise<void> {
  /**
   * The abort was checked ONCE, on entry, and the listener that reacts to it is
   * only attached after device.pair() has already been called. Between those
   * two points sit an isPaired() round trip and an agent registration, both
   * D-Bus calls that can take a while on a busy adapter. A stop arriving in
   * that window was seen by nothing: pairing started anyway, lit the passkey
   * prompt on a scale nobody was standing at, and the shutdown then waited out
   * the 15 s bonding timeout - three times the force-exit grace window (#335).
   */
  const throwIfAborted = (when: string): void => {
    if (abortSignal?.aborted) throw new Error(`Shutting down ${when}`);
  };
  throwIfAborted('before BLE pairing started');
  let onAbort: (() => void) | undefined;
  try {
    // NOT the shared isBonded() helper, and this is the third semantic in the
    // file: answering false here would send an unknown bond state into
    // device.pair(), which lights the passkey prompt on the scale and burns the
    // 15 s bonding timeout. A transient D-Bus read failure must abort instead,
    // so the read is deliberately unguarded (#406).
    if (((await device.isPaired()) as unknown as boolean) === true) {
      bleLog.debug('Device already bonded');
      // On BlueZ the kernel answers the scale's own Security Request when it
      // connects, so for a single-bond scale this is the usual way in, not
      // Pair() below; a pairing without a stored bond shows up only here.
      if (opts?.forPairing) await warnIfNotBonded(device);
      return;
    }
    throwIfAborted('before registering the BLE pairing agent');
    // Register our own BlueZ pairing agent first so pairing can actually complete:
    // it supplies the configured PIN as the passkey for Passkey Entry, or auto-accepts
    // Just Works / numeric comparison. Without an agent BlueZ returns "Authentication
    // Failed" (#168). Best-effort; a failure here falls back to any system agent.
    // The ambient target (setPairingTarget) carries the PIN AND the scale's MAC.
    // This used to install a PIN-only provider instead, which silently dropped
    // the MAC gate for the rest of the cycle (#83).
    try {
      await (opts?.forPairing
        ? ensurePairingAgent(getBus(), { forPairing: true })
        : ensurePairingAgent(getBus()));
    } catch (err) {
      bleLog.debug(`Pairing agent registration skipped: ${errMsg(err)}`);
    }
    // Last check before the one call that will not come back on its own.
    throwIfAborted('before BLE pairing started');
    bleLog.info('Adapter requires bonding; attempting BLE pairing...');
    // A pairing that waits on a button press is the one D-Bus call that will
    // not come back on its own: BlueZ holds Pair() open until someone confirms
    // on the scale, and during a shutdown nobody is there to. Reported in #335
    // by an owner whose scale forces a stop/start cycle for every weigh-in, so
    // almost every stop lands here.
    const pairing = withTimeout(device.pair(), BONDING_TIMEOUT_MS, 'BLE pairing timed out');
    if (abortSignal) {
      let rejectOnAbort!: (err: unknown) => void;
      const abortedFirst = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = reject;
      });
      onAbort = () => {
        bleLog.debug('Shutting down with a BLE pairing outstanding, cancelling it');
        // NOT node-ble's device.cancelPair(). That calls `CancelPair`, and the
        // org.bluez.Device1 interface has no such method: it defines
        // `CancelPairing`. The call comes back as UnknownMethod, so going
        // through node-ble here would look like a fix and cancel nothing.
        // Verified against the BlueZ interface documentation, not from memory.
        void helperOf(device)
          .callMethod('CancelPairing')
          .catch((err) => bleLog.debug(`CancelPairing failed: ${errMsg(err)}`));
        rejectOnAbort(
          abortSignal.reason ?? new Error('Shutting down with a BLE pairing outstanding'),
        );
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      // The cancel is best-effort cleanup, not the mechanism. BlueZ may not
      // answer a cancelled Pair() at all, and on the wedged-D-Bus case this
      // exists for it certainly will not, so the abort has to settle this await
      // by itself. Relying on the cancel alone would still wait out
      // BONDING_TIMEOUT_MS, which is three times the force-exit grace window.
      await Promise.race([pairing, abortedFirst]);
    } else {
      await pairing;
    }
    // Stand the listener down as soon as the pairing is through. Two awaits
    // follow, and a stop arriving during them must not send CancelPairing
    // against a bond that already completed.
    if (onAbort && abortSignal) {
      abortSignal.removeEventListener('abort', onAbort);
      onAbort = undefined;
    }
    bleLog.info('BLE pairing succeeded');
    if (opts?.forPairing) await warnIfNotBonded(device);
    // Mark the device trusted so subsequent reconnects re-use the bond without
    // re-invoking the agent. Best-effort: a failure does not affect this session.
    try {
      const { Variant } = await getDbusNext();
      await helperOf(device).set('Trusted', new Variant('b', true));
    } catch (err) {
      bleLog.debug(`Could not set Trusted on device: ${errMsg(err)}`);
    }
  } catch (err) {
    // Swallowing an abort here would be worse than useless: the caller would
    // carry straight on into a two-minute wait for a reading nobody is going
    // to produce, and cancelling the pairing would have bought nothing.
    if (abortSignal?.aborted) throw err;
    bleLog.warn(
      `BLE pairing failed (continuing unbonded): ${errMsg(err)}. ` +
        'A BlueZ pairing agent may be required for scales that mandate an encrypted link.',
    );
  } finally {
    if (onAbort) abortSignal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Acquire the GATT server, tolerating consent-and-bond scales (e.g. Beurer
 * BF950) that withhold GATT service resolution until the link is encrypted, so
 * the very first `device.gatt()` never resolves and times out (#290). On that
 * timeout, if the matched adapter requires bonding and the device is not yet
 * bonded, pair first (ensureBonded registers the PIN agent) and retry the
 * acquisition exactly once.
 *
 * The normal path is untouched: the retry only runs after a timeout, so scales
 * that already resolve their services unbonded (e.g. Beurer BF720, whose
 * gatt() succeeds and only its CCCDs need the later bond) behave exactly as
 * before and never enter the retry. withTimeout races gatt() against a timer via
 * Promise.race, which keeps a reaction attached to the gatt() promise, so a late
 * rejection after the timeout is already handled and cannot surface as an
 * unhandled rejection.
 */
export async function acquireGattServer(
  device: Device,
  adapter: ScaleAdapter | undefined,
  pin: number | undefined,
  // Injectable so the branch logic (bond gate, already-bonded rethrow,
  // single retry) is unit-testable without a live D-Bus. Defaults to the real
  // ensureBonded in production.
  bond: (
    d: Device,
    p: number | undefined,
    s?: AbortSignal,
    o?: BondOptions,
  ) => Promise<void> = ensureBonded,
  abortSignal?: AbortSignal,
): Promise<NodeBle.GattServer> {
  // Raced against the abort as well as the deadline: a shutdown otherwise sat
  // out up to 30 s here, past the 5 s force-exit grace (A-07).
  const acquire = (): Promise<NodeBle.GattServer> =>
    untilAborted(
      withTimeout(device.gatt(), GATT_DISCOVERY_TIMEOUT_MS, 'GATT server acquisition timed out'),
      abortSignal,
    );
  try {
    return await acquire();
  } catch (err) {
    if (abortSignal?.aborted || !adapter?.requiresBonding) throw err;
    const alreadyBonded = await isBonded(device);
    // Already bonded but still timing out means the stall is not a missing bond;
    // pairing again would not help, so surface the original timeout.
    if (alreadyBonded) throw err;
    bleLog.info(
      'GATT discovery timed out on a scale that requires bonding; pairing first, then retrying discovery once (#290)...',
    );
    await (adapter.singleBond
      ? bond(device, pin, abortSignal, { forPairing: true })
      : bond(device, pin, abortSignal));
    return await acquire();
  }
}

/**
 * Scan for a BLE scale, read weight + impedance, and compute body composition.
 * Uses node-ble (BlueZ D-Bus). Requires bluetoothd running on Linux.
 *
 * The D-Bus connection is kept alive across calls (singleton) to prevent
 * orphaned BlueZ discovery sessions in continuous mode. If the connection
 * becomes stale (e.g. bluetoothd restart), it is automatically reset.
 */
export async function scanAndReadRaw(opts: ScanOptions): Promise<RawReading> {
  // Numbered so a cycle can tell, once it finally ends, whether the poll loop
  // gave up on it and started another one meanwhile (A-04).
  const cycle = ++scanCycle;
  const isSuperseded = (): boolean => cycle !== scanCycle;
  const {
    targetMac,
    adapters,
    profile,
    scaleAuth,
    onLiveData,
    onLiveWeight,
    abortSignal,
    bleAdapter,
    readingTimeoutMs,
    autoClearStaleBond,
    preemptiveAdapterReset,
    adapterPrivacy,
    pairingRetryMaxMin,
  } = opts;

  let device: Device | null = null;
  let btAdapter: Adapter;
  let gattAttempted = false;
  let gattSucceeded = false;
  let deviceMac: string = targetMac ?? '';
  // Latest resolved adapter handle, captured for the failure-classification
  // liveness probe (#213). Stays undefined if getAdapter never succeeds.
  let probeAdapter: Adapter | undefined;
  /** What the scan activity watchdog did in this cycle's wait, for the same classification. */
  const scanWatch: ScanWatch = { restarts: 0 };
  /** Listens on the scale's kept BlueZ object until the wait has used it (D060). */
  let latch: FreshAdvertLatch | undefined;
  /** The scale's BlueZ object was kept from an earlier cycle rather than removed (D060). */
  let keptObject = false;
  /** BlueZ left a Disconnect for the scale unanswered in this cycle (#472). */
  let staleLink = false;
  /** Pairing prompts the agent had handled for the scale right before this cycle's connect (#471). */
  let promptsBefore: number | undefined;
  /** The bonding adapter this cycle matched the scale to, if any (#471). */
  let bondingAdapter: ScaleAdapter | undefined;
  /** What the scale's advertisement said in this cycle about a stored weigh-in (#471). */
  let cycleHint: boolean | undefined;
  const releaseLatch = (): void => {
    latch?.release();
    latch = undefined;
  };
  /**
   * Hold the connect back while a pairing nobody confirmed stands for the
   * scale (#471, D063). A held cycle never connected, so its teardown must not
   * send a Disconnect to the object either: BlueZ may still list the scale as
   * connected from an earlier cycle (#472).
   */
  const holdPairing = async (
    found: Device,
    mac: string,
    adapter: ScaleAdapter | undefined,
    waitStartedAt: number,
  ): Promise<void> => {
    try {
      cycleHint = await holdUntilPairingAllowed({
        device: found,
        btAdapter,
        mac,
        adapter,
        adapters,
        capMin: pairingRetryMaxMin,
        hint: cycleHint,
        budgetMs: waitStartedAt + DISCOVERY_TIMEOUT_MS - Date.now(),
        abortSignal,
        scanWatch,
      });
    } catch (err) {
      releaseDeviceProxy(found);
      device = null;
      throw err;
    }
  };

  /**
   * Follow the connect retry loop onto the adapter and device it uses now. A
   * re-discovery in there can replace the D-Bus connection, and the teardown's
   * Disconnect, StopDiscovery and RemoveDevice through the proxies of the old
   * one would never reach BlueZ: connection.ts fails them once that bus is
   * gone (#472). probeAdapter is left alone on purpose. The connect runs only
   * after gattAttempted is set, and classifyBleFailure never probes then.
   */
  const followConnect = (live: { btAdapter: Adapter; device: Device }): void => {
    btAdapter = live.btAdapter;
    device = live.device;
  };

  // Publish this cycle's pairing target before the first getAdapter(), which is
  // where the agent registers. Stored as a closure rather than a value so a
  // config reload lands on the next cycle without a restart, and MAC-scoped so
  // an unrelated peer cannot be handed the scale's consent PIN (#83). In
  // auto-discovery the closure picks up the matched address once autoDiscover
  // sets deviceMac; until then the agent declines everything.
  setPairingTarget(() => ({ pin: scaleAuth?.pin, mac: targetMac ?? (deviceMac || undefined) }));

  try {
    btAdapter = await acquireBluezAdapter(bleAdapter);

    probeAdapter = btAdapter;

    if (!(await btAdapter.isPowered())) {
      throw new Error(
        'Bluetooth adapter is not powered on. ' +
          'Ensure bluetoothd is running: sudo systemctl start bluetooth',
      );
    }

    // Before this cycle starts discovery, so the power-cycle an apply needs
    // never lands on a device this cycle found. In continuous mode an idle
    // cycle leaves its discovery running, so the power-cycle can still land on
    // that one: the resetConnection below drops the D-Bus state it leaves
    // behind and startDiscoverySafe starts a fresh scan. The index comes from
    // the adapter BlueZ resolved, not from ble.adapter (#417).
    if (adapterPrivacy) {
      const privacy = await ensureAdapterPrivacy(btAdapter, abortSignal);
      if (privacy.powerCycled) {
        // btmgmt took the controller down underneath this D-Bus connection,
        // the same situation as the btmgmt recovery tier.
        resetConnection();
        btAdapter = await acquireBluezAdapter(bleAdapter);
        probeAdapter = btAdapter;
      }
    }

    // Removing the scale's BlueZ object before the scan is what made the wait
    // below mean "it is advertising now": waitDevice() only polls for the
    // object, and BlueZ keeps it for good once Connect() was called on it. It
    // also drops BlueZ's GATT cache, which a GATT-only scale then pays for with
    // a full service discovery on every connect (#425). So it stays where a
    // kept object could do harm, and elsewhere a latch armed before discovery
    // starts has to hear the scale in this cycle first (D060, device-cache.ts).
    if (targetMac) {
      const policy = cachePolicyFor(targetMac, adapters);
      const key = formatMac(targetMac);
      if (!policy.keep) {
        bleLog.debug(`Removing ${key} from BlueZ before the scan: ${policy.reason}`);
        await removeDevice(btAdapter, targetMac);
      } else {
        const held = await armFreshAdvertLatch(btAdapter, key);
        switch (held.kind) {
          case 'absent':
            bleLog.debug(`BlueZ no longer lists ${key}; waiting for it to appear`);
            break;
          case 'paired':
            keptObject = true;
            bleLog.debug(`${key} is paired; BlueZ keeps it either way`);
            break;
          case 'unknown':
            bleLog.debug(`Could not read ${key} from BlueZ (${held.error}); removing it`);
            await removeDevice(btAdapter, targetMac);
            break;
          case 'armed':
            latch = held.latch;
            keptObject = true;
            announceKept(key, policy.adapter!.name);
            bleLog.debug(`Keeping ${key} in BlueZ for this cycle: ${policy.reason}`);
            break;
        }
      }
    }

    const discoveryResult = await startDiscoverySafe(btAdapter, bleAdapter, { abortSignal });
    if (discoveryResult) btAdapter = discoveryResult;
    probeAdapter = btAdapter;

    // The latch hears reports only on the bus it was put on, and every report
    // only while our filtered scan runs. Without either, remove the object as
    // before, just after the scan started instead of before it.
    if (latch && targetMac) {
      const why =
        btAdapter !== latch.adapter
          ? 'the D-Bus connection was replaced while discovery started'
          : !runningScanIsFiltered(btAdapter)
            ? 'our filtered discovery is not running'
            : undefined;
      if (why) {
        releaseLatch();
        keptObject = false;
        bleLog.debug(`Removing ${formatMac(targetMac)} from BlueZ after all: ${why}`);
        await removeDevice(btAdapter, targetMac);
      }
    }

    let matchedAdapter: ScaleAdapter;
    // Advertised name, for adapters whose protocol differs by model.
    let deviceName = '';
    // Advertised manufacturer data, for adapters that read per-unit flags from
    // it (#461). Captured before StopDiscovery, which can drop it (#297); when
    // this cycle's snapshot has none, the last one the address advertised in
    // this run (session-advert.ts, #463).
    let manufacturerData: { id: number; data: Buffer } | undefined;

    if (targetMac) {
      const mac = formatMac(targetMac);
      bleLog.info('Scanning for device...');

      // A no-show is what lets a held pairing go at once when the scale comes
      // back (#471); an abort or any other failure says nothing about it.
      const waitStartedAt = Date.now();
      const noteNoShow = (err: unknown): never => {
        if (!abortSignal?.aborted && errMsg(err) === targetNotFoundMessage(mac)) {
          noteScaleMissed(mac);
        }
        throw err;
      };
      device = await waitForTargetDevice(btAdapter, mac, abortSignal, scanWatch, latch).catch(
        noteNoShow,
      );
      releaseLatch();

      let { name, advert, preMatchedAdapter } = await resolvePreConnectAdapter(
        device,
        mac,
        deviceMac,
        adapters,
      );
      // A broadcast poll must never read a kept object: its cached
      // ManufacturerData can still be the last weigh-in's final frame, which a
      // report without one does not clear (#372). Only GATT-only adapters keep
      // the object, so this takes a different match on the same unit, and it
      // costs one more wait if it ever does.
      if (keptObject && preMatchedAdapter && readsFromAdvertisement(preMatchedAdapter)) {
        bleLog.debug(
          `${preMatchedAdapter.name} reads advertisements; removing the kept ${mac} and waiting for a fresh one`,
        );
        keptObject = false;
        forgetReadingAdapter(targetMac);
        releaseDeviceProxy(device);
        device = null;
        await removeDevice(btAdapter, targetMac);
        device = await waitForTargetDevice(btAdapter, mac, abortSignal, scanWatch).catch(
          noteNoShow,
        );
        ({ name, advert, preMatchedAdapter } = await resolvePreConnectAdapter(
          device,
          mac,
          deviceMac,
          adapters,
        ));
      }
      deviceName = name;

      if (
        preMatchedAdapter?.preferPassive &&
        (preMatchedAdapter.parseServiceData || preMatchedAdapter.parseBroadcast)
      ) {
        matchedAdapter = preMatchedAdapter;
        bleLog.info(`Matched adapter: ${matchedAdapter.name}`);
        const reading = await broadcastScanNodeBle(matchedAdapter, btAdapter, device, mac, {
          abortSignal,
          onLiveData,
          onLiveWeight,
        });
        // A broadcast adapter in the memory means the next cycle removes the
        // object again (D060).
        rememberReadingAdapter(targetMac, matchedAdapter);
        resetScanActivityBackoff();
        return reading;
      }

      if (preMatchedAdapter?.requiresBonding) bondingAdapter = preMatchedAdapter;
      cycleHint = advertisedReadingHint(
        hintAdapterFor(mac, preMatchedAdapter, adapters),
        mac,
        advert.serviceData,
      );
      await holdPairing(device, mac, preMatchedAdapter, waitStartedAt);
      // For the session only, never for the matches above (D071).
      manufacturerData = sessionManufacturerData(mac, advert);

      // Stop discovery before connecting. BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      await stopDiscoveryAndQuiesce(btAdapter);
      if (adapterPrivacy) await requireAdapterPrivacy(btAdapter);

      gattAttempted = true;
      promptsBefore = userPromptCount(targetMac);
      device = await connectWithRecovery({
        btAdapter,
        mac: targetMac,
        initialDevice: device,
        maxRetries: MAX_CONNECT_RETRIES,
        bleAdapter,
        autoClearStaleBond,
        adapterPrivacy,
        abortSignal,
        onLive: followConnect,
      });
      bleLog.info('Connected. Discovering services...');

      // Resolve the adapter post-discovery using characteristics as well as
      // service UUIDs, so devices that share a generic vendor service (e.g.
      // 0xFFF0: 1byone/Eufy vs Inlife) are disambiguated instead of falling to
      // the first service-only match. BlueZ can export characteristics late
      // ([bluez/bluez#1489]), so retry the enumeration within the existing
      // discovery budget until an adapter is recognized. #177
      // Wrap device.gatt() in the same timeout as the standard path below: if
      // the peripheral drops the connection mid-discovery, node-ble waits on the
      // D-Bus ServicesResolved property forever, freezing the event loop after
      // connect but before the scan cycle fails, so the consecutive-failure
      // watchdog never trips (#273).
      const gatt = await acquireGattServer(
        device,
        preMatchedAdapter,
        scaleAuth?.pin,
        ensureBonded,
        abortSignal,
      );
      matchedAdapter = await untilAborted(
        resolveAfterConnect(gatt, adapters, name, deviceMac, advert),
        abortSignal,
      );
      if (matchedAdapter.requiresBonding) bondingAdapter = matchedAdapter;
      bleLog.info(`Matched adapter: ${matchedAdapter.name}`);
    } else {
      // Auto-discovery: poll discovered devices, match by name, connect, verify
      const scanAdapter = btAdapter;
      const waitStartedAt = Date.now();
      const result = await withScanActivityWatchdog(
        scanAdapter,
        abortSignal,
        () => autoDiscover(scanAdapter, adapters, abortSignal),
        scanWatch,
      ).catch((err: unknown) => {
        // No scale at all in this cycle: a held one goes at once when it is
        // found again (#471).
        if (!abortSignal?.aborted && errMsg(err) === noScaleRecognizedMessage()) {
          noteAllScalesMissed();
        }
        throw err;
      });
      device = result.device;
      matchedAdapter = result.adapter;
      deviceMac = result.mac;
      deviceName = result.name;
      // The fresher snapshot first; a name-only match may have had none yet
      // (ADV_IND and SCAN_RSP arrive apart), then the one it matched on. Only
      // one with bytes counts, as in session-advert.ts.
      const snapshot = await logAdvertisementSnapshot(device);
      const sessionAdvert = [snapshot.manufacturerData, result.manufacturerData].find(
        (md) => md !== undefined && md.data.length > 0,
      );

      // Passive-mode adapters: read from advertisements without connecting.
      if (
        matchedAdapter.preferPassive &&
        (matchedAdapter.parseServiceData || matchedAdapter.parseBroadcast)
      ) {
        bleLog.info(`Matched adapter: ${matchedAdapter.name}`);
        const reading = await broadcastScanNodeBle(matchedAdapter, btAdapter, device, result.mac, {
          abortSignal,
          onLiveData,
          onLiveWeight,
        });
        resetScanActivityBackoff();
        return reading;
      }

      if (matchedAdapter.requiresBonding) bondingAdapter = matchedAdapter;
      cycleHint = advertisedReadingHint(
        hintAdapterFor(result.mac, matchedAdapter, adapters),
        result.mac,
        snapshot.serviceData,
      );
      await holdPairing(device, result.mac, matchedAdapter, waitStartedAt);
      // For the session only, never for the match above (D071).
      manufacturerData = sessionManufacturerData(result.mac, { manufacturerData: sessionAdvert });

      // Stop discovery before connecting. BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      await stopDiscoveryAndQuiesce(btAdapter);
      if (adapterPrivacy) await requireAdapterPrivacy(btAdapter);

      gattAttempted = true;
      promptsBefore = userPromptCount(result.mac);
      device = await connectWithRecovery({
        btAdapter,
        mac: result.mac,
        initialDevice: device,
        maxRetries: MAX_CONNECT_RETRIES,
        bleAdapter,
        autoClearStaleBond,
        adapterPrivacy,
        abortSignal,
        onLive: followConnect,
      });
      bleLog.info('Connected. Discovering services...');
    }

    // Setup GATT characteristics and wait for a complete reading.
    // BlueZ has a known race ([bluez/bluez#1489]) where ServicesResolved=true
    // fires before all characteristic interfaces are exported over D-Bus, so
    // the first enumeration can be missing chars the scale actually exposes.
    // Retry the enumeration a few times with a short backoff when we detect
    // that the adapter's required chars are not yet present.
    const gatt = await acquireGattServer(
      device,
      matchedAdapter,
      scaleAuth?.pin,
      ensureBonded,
      abortSignal,
    );
    const charMap = await untilAborted(
      buildCharMapWithRetry(gatt, (map) => findMissingCharacteristics(map, matchedAdapter)),
      abortSignal,
    );
    // Establish an encrypted link before enabling notifications for adapters
    // whose SIG services protect their CCCDs (#168). Best-effort: see ensureBonded.
    if (matchedAdapter.requiresBonding) {
      await (matchedAdapter.singleBond
        ? ensureBonded(device, scaleAuth?.pin, abortSignal, { forPairing: true })
        : ensureBonded(device, scaleAuth?.pin, abortSignal));
    }

    const raw = await readWithTimeouts(charMap, wrapDevice(device), matchedAdapter, deviceMac, {
      profile,
      onLiveData,
      scaleAuth,
      readingTimeoutMs,
      abortSignal,
      deviceName,
      manufacturerData,
    });
    gattSucceeded = true;
    // Even for a cycle the poll loop has given up on: which adapter read the
    // scale is a fact about the scale, not about the cycle (D060).
    if (targetMac) rememberReadingAdapter(targetMac, matchedAdapter);
    resetScanActivityBackoff();
    noteReadingForStaleLink(deviceMac);

    // Same device path as the newer cycle's, so a late Disconnect here would
    // drop that cycle's link to the scale.
    if (!isSuperseded()) {
      // An adapter that enables a binding itself (CharacteristicBinding.deferred)
      // gets it turned off again first, as its vendor app does (#408). StopNotify
      // answers before BlueZ has written the CCCD, so the short wait lets that
      // write reach the scale before the link goes; a shutdown cuts it short.
      // Checked synchronously, so every adapter without a deferred binding
      // reaches the disconnect exactly as before: no D-Bus call, no log line,
      // no wait, not even an extra await.
      if (!abortSignal?.aborted && hasDeferredNotifyBinding(matchedAdapter)) {
        if ((await stopDeferredNotifications(charMap, matchedAdapter)) > 0) {
          await abortableSleep(STOP_NOTIFY_SETTLE_MS, abortSignal).catch(() => {});
        }
      }
      // The stop and the wait above take up to 2.5 s, long enough for the poll
      // loop to give up on this cycle and start a newer one on the same device.
      // Bounded, so a Disconnect BlueZ never answers no longer takes the
      // reading down with it; the teardown recovers the link instead (#472).
      if (!isSuperseded()) {
        const outcome = await disconnectBounded(device, {
          mac: formatMac(deviceMac),
          label: 'after reading',
          abortSignal,
        });
        if (outcome === 'timeout') staleLink = true;
      }
    }
    return raw;
  } catch (err) {
    // connectWithRecovery already waited out one unanswered Disconnect.
    if (err instanceof StaleLinkError) staleLink = true;
    await classifyBleFailure(err, {
      gattAttempted,
      probeAdapter,
      abortSignal,
      scanRestarted: scanWatch.restarts > 0,
      scanHeardAt: scanWatch.lastHeardAt,
    });
    throw err;
  } finally {
    releaseLatch();
    // Before the teardown, which disconnects and releases the device this
    // reads Paired from (#471).
    await settlePairingRecord({
      device,
      mac: deviceMac,
      adapter: bondingAdapter,
      promptsBefore,
      reading: gattSucceeded,
      hint: cycleHint,
      capMin: pairingRetryMaxMin,
      abortSignal,
    });
    await teardownSession({
      device,
      btAdapter: btAdapter!,
      deviceMac,
      bleAdapter,
      gattAttempted,
      gattSucceeded,
      abortSignal,
      preemptiveAdapterReset,
      isSuperseded,
      staleLink,
    });
  }
}

/**
 * Scan for nearby BLE devices and identify recognized scales.
 * Uses node-ble (BlueZ D-Bus). Linux only.
 *
 * Uses its own short-lived D-Bus connection (not the persistent singleton)
 * because scan operations are one-shot and should not interfere with
 * continuous mode scanning.
 */
export async function scanDevices(
  adapters: ScaleAdapter[],
  durationMs = 15_000,
  bleAdapter?: string,
): Promise<ScanResult[]> {
  let bluetooth: NodeBle.Bluetooth;
  let destroy: () => void;
  try {
    // This path builds its own bus instead of going through getConnection(),
    // so it needs the match-rule patch applied here as well (#396).
    applyDbusMatchRefcountPatch();
    ({ bluetooth, destroy } = NodeBle.createBluetooth());
  } catch (err) {
    if (isDbusConnectionError(err)) throw dbusError();
    throw err;
  }

  // This session owns its own bus, so it needs its own error listener or a
  // socket failure here is an uncaught exception (#290). No latch: the function
  // is one-shot and its finally block tears the session down.
  attachBusErrorHandler(bluetooth, (err) =>
    bleLog.warn(`D-Bus transport error during scan: ${errMsg(err)}`),
  );

  let btAdapter: Adapter | null = null;
  // startDiscoverySafe's btmgmt/rfkill/bluetoothd tiers reset the PERSISTENT
  // connection and hand back an adapter from a fresh one, which also registers
  // the pairing agent on it. Each reset bumps the generation, so a change means
  // this one-shot scan opened a persistent connection that nothing else will
  // close, and the CLI would never exit (A-08).
  const generationBefore = currentConnectionGeneration();

  try {
    try {
      btAdapter = bleAdapter
        ? await bluetooth.getAdapter(bleAdapter)
        : await bluetooth.defaultAdapter();
    } catch (err) {
      if (isDbusConnectionError(err)) throw dbusError();
      if (bleAdapter) {
        throw new Error(
          `Bluetooth adapter '${bleAdapter}' not found. ` +
            'Check that the adapter exists (hciconfig or btmgmt info).',
        );
      }
      throw err;
    }

    if (!(await btAdapter.isPowered())) {
      throw new Error(
        'Bluetooth adapter is not powered on. ' +
          'Ensure bluetoothd is running: sudo systemctl start bluetooth',
      );
    }

    const discoveryResult = await startDiscoverySafe(btAdapter, bleAdapter);
    if (discoveryResult) btAdapter = discoveryResult;

    const seen = new Set<string>();
    const results: ScanResult[] = [];
    const deadline = Date.now() + durationMs;

    while (Date.now() < deadline) {
      const addresses = await btAdapter.devices();

      for (const addr of addresses) {
        if (seen.has(addr)) continue;
        seen.add(addr);

        let dev: Device | undefined;
        try {
          dev = await btAdapter.getDevice(addr);
          // Match on what the read path matches on, not on the name alone.
          // This tool is what users are pointed at to discover the adapter name
          // for `ble.force_scale_adapter`, so an answer that differs from what a
          // real run would choose gets acted on. The advertisement snapshot is
          // the same one the connect path uses, and it carries the manufacturer
          // data a dozen adapters fingerprint on (#280).
          //
          // The name is read as '' rather than a sentinel for the same reason as
          // the Noble tool: a placeholder is truthy, and adapters that branch on
          // whether an advertisement carries a name would read a nameless device
          // as named.
          const name = await dev.getName().catch(() => '');
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

          results.push({
            address: addr,
            name: safeName(name) || '(unknown)',
            matchedAdapter: matched?.name,
          });
        } catch {
          /* device may have gone away */
        } finally {
          // Reading a property is what registers the listener and the D-Bus
          // match rule, and this loop reads two per device. autoDiscover and
          // removeDevice already hand theirs back; this one did not, so a scan
          // in a crowded room walked toward the per-connection match-rule cap
          // (#404). Bounded by `seen` and by the throwaway bus below, but it is
          // the same mechanism as #396.
          if (dev) releaseDeviceProxy(dev);
        }
      }

      await sleep(DISCOVERY_POLL_MS);
    }

    return results;
  } finally {
    if (btAdapter) {
      try {
        await btAdapter.stopDiscovery();
      } catch {
        /* ignore */
      }
    }
    await sleep(POST_DISCOVERY_QUIESCE_MS);
    destroy();
    if (currentConnectionGeneration() !== generationBefore) resetConnection();
  }
}
