import NodeBle from 'node-ble';
import type {
  ScaleAdapter,
  BleDeviceInfo,
  BodyComposition,
} from '../../interfaces/scale-adapter.js';
import type { ScanOptions, ScanResult } from '../types.js';
import type { RawReading } from '../shared.js';
import { findMissingCharacteristics } from '../shared.js';
import { resolveAdapter } from '../../scales/resolve.js';
import {
  bleLog,
  formatMac,
  sleep,
  errMsg,
  withTimeout,
  MAX_CONNECT_RETRIES,
  DISCOVERY_POLL_MS,
  POST_DISCOVERY_QUIESCE_MS,
  GATT_DISCOVERY_TIMEOUT_MS,
} from '../types.js';
import { helperOf, getDbusNext, type Adapter, type Device } from './dbus.js';
import { applyDbusMatchRefcountPatch } from './dbus-match-patch.js';
import { getBus, attachBusErrorHandler, isDbusConnectionError, dbusError } from './connection.js';
import { registerPairingAgent, setPairingTarget } from './agent.js';
import {
  startDiscoverySafe,
  removeDevice,
  autoDiscover,
  stopDiscoveryAndQuiesce,
} from './discovery.js';
import { connectWithRecovery } from './connect.js';
import { logAdvertisementSnapshot } from './device-object.js';
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
import { safeName } from '../advertisement.js';

/** Max time to wait for a BLE pairing/bonding handshake before giving up. */
const BONDING_TIMEOUT_MS = 15_000;

/**
 * Best-effort BLE bonding for adapters that need an encrypted link (#168).
 *
 * Some SIG scales (e.g. Beurer BF720, whose User Data Service 0x181C protects
 * its CCCDs) drop the link when notifications are enabled on an unbonded
 * connection. Pairing here, after connect and before subscribing, establishes
 * the encryption those characteristics require. A failure is logged and the
 * read continues unbonded so adapters that do not strictly need it are not
 * blocked; pairing may need a registered BlueZ agent on some setups.
 */
export async function ensureBonded(
  device: Device,
  pin: number | undefined,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) throw new Error('Shutting down before BLE pairing started');
  let onAbort: (() => void) | undefined;
  try {
    const paired = (await device.isPaired()) as unknown as boolean;
    if (paired) {
      bleLog.debug('Device already bonded');
      return;
    }
    // Register our own BlueZ pairing agent first so pairing can actually complete:
    // it supplies the configured PIN as the passkey for Passkey Entry, or auto-accepts
    // Just Works / numeric comparison. Without an agent BlueZ returns "Authentication
    // Failed" (#168). Best-effort; a failure here falls back to any system agent.
    try {
      await registerPairingAgent(getBus(), () => pin);
    } catch (err) {
      bleLog.debug(`Pairing agent registration skipped: ${errMsg(err)}`);
    }
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
  bond: (d: Device, p: number | undefined, s?: AbortSignal) => Promise<void> = ensureBonded,
  abortSignal?: AbortSignal,
): Promise<NodeBle.GattServer> {
  const acquire = (): Promise<NodeBle.GattServer> =>
    withTimeout(device.gatt(), GATT_DISCOVERY_TIMEOUT_MS, 'GATT server acquisition timed out');
  try {
    return await acquire();
  } catch (err) {
    if (!adapter?.requiresBonding) throw err;
    let alreadyBonded = false;
    try {
      alreadyBonded = (await device.isPaired()) as unknown as boolean;
    } catch {
      alreadyBonded = false;
    }
    // Already bonded but still timing out means the stall is not a missing bond;
    // pairing again would not help, so surface the original timeout.
    if (alreadyBonded) throw err;
    bleLog.info(
      'GATT discovery timed out on a scale that requires bonding; pairing first, then retrying discovery once (#290)...',
    );
    await bond(device, pin, abortSignal);
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
  const {
    targetMac,
    adapters,
    profile,
    scaleAuth,
    weightUnit,
    onLiveData,
    onLiveWeight,
    abortSignal,
    bleAdapter,
    readingTimeoutMs,
    autoClearStaleBond,
  } = opts;

  let device: Device | null = null;
  let btAdapter: Adapter;
  let gattAttempted = false;
  let gattSucceeded = false;
  let deviceMac: string = targetMac ?? '';
  // Latest resolved adapter handle, captured for the failure-classification
  // liveness probe (#213). Stays undefined if getAdapter never succeeds.
  let probeAdapter: Adapter | undefined;

  // Publish this cycle's pairing target before the first getAdapter(), which is
  // where the agent registers. Stored as a closure rather than a value so a
  // config reload lands on the next cycle without a restart, and MAC-scoped so
  // an unrelated peer cannot be handed the scale's consent PIN (#83).
  setPairingTarget(() => ({ pin: scaleAuth?.pin, mac: targetMac }));

  try {
    btAdapter = await acquireBluezAdapter(bleAdapter);

    probeAdapter = btAdapter;

    if (!(await btAdapter.isPowered())) {
      throw new Error(
        'Bluetooth adapter is not powered on. ' +
          'Ensure bluetoothd is running: sudo systemctl start bluetooth',
      );
    }

    // In continuous mode, BlueZ caches the device from a previous cycle.
    // Removing it forces a fresh discovery + proxy creation.
    if (targetMac) {
      await removeDevice(btAdapter, targetMac);
    }

    const discoveryResult = await startDiscoverySafe(btAdapter, bleAdapter);
    if (discoveryResult) btAdapter = discoveryResult;
    probeAdapter = btAdapter;

    let matchedAdapter: ScaleAdapter;

    if (targetMac) {
      const mac = formatMac(targetMac);
      bleLog.info('Scanning for device...');

      device = await waitForTargetDevice(btAdapter, mac, abortSignal);

      const { name, advert, preMatchedAdapter } = await resolvePreConnectAdapter(
        device,
        mac,
        deviceMac,
        adapters,
      );

      if (
        preMatchedAdapter?.preferPassive &&
        (preMatchedAdapter.parseServiceData || preMatchedAdapter.parseBroadcast)
      ) {
        matchedAdapter = preMatchedAdapter;
        bleLog.info(`Matched adapter: ${matchedAdapter.name}`);
        return await broadcastScanNodeBle(matchedAdapter, btAdapter, device, mac, {
          abortSignal,
          onLiveData,
          onLiveWeight,
        });
      }

      // Stop discovery before connecting. BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      await stopDiscoveryAndQuiesce(btAdapter);

      gattAttempted = true;
      device = await connectWithRecovery({
        btAdapter,
        mac: targetMac,
        initialDevice: device,
        maxRetries: MAX_CONNECT_RETRIES,
        bleAdapter,
        autoClearStaleBond,
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
      matchedAdapter = await resolveAfterConnect(gatt, adapters, name, deviceMac, advert);
      bleLog.info(`Matched adapter: ${matchedAdapter.name}`);
    } else {
      // Auto-discovery: poll discovered devices, match by name, connect, verify
      const result = await autoDiscover(btAdapter, adapters, abortSignal);
      device = result.device;
      matchedAdapter = result.adapter;
      deviceMac = result.mac;
      await logAdvertisementSnapshot(device);

      // Passive-mode adapters: read from advertisements without connecting.
      if (
        matchedAdapter.preferPassive &&
        (matchedAdapter.parseServiceData || matchedAdapter.parseBroadcast)
      ) {
        bleLog.info(`Matched adapter: ${matchedAdapter.name}`);
        return await broadcastScanNodeBle(matchedAdapter, btAdapter, device, result.mac, {
          abortSignal,
          onLiveData,
          onLiveWeight,
        });
      }

      // Stop discovery before connecting. BlueZ on low-power devices (e.g. Pi Zero)
      // often fails with le-connection-abort-by-local while discovery is still active.
      await stopDiscoveryAndQuiesce(btAdapter);

      gattAttempted = true;
      device = await connectWithRecovery({
        btAdapter,
        mac: result.mac,
        initialDevice: device,
        maxRetries: MAX_CONNECT_RETRIES,
        bleAdapter,
        autoClearStaleBond,
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
    const charMap = await buildCharMapWithRetry(gatt, (map) =>
      findMissingCharacteristics(map, matchedAdapter),
    );
    // Establish an encrypted link before enabling notifications for adapters
    // whose SIG services protect their CCCDs (#168). Best-effort: see ensureBonded.
    if (matchedAdapter.requiresBonding) {
      await ensureBonded(device, scaleAuth?.pin, abortSignal);
    }

    const raw = await readWithTimeouts(charMap, wrapDevice(device), matchedAdapter, deviceMac, {
      profile,
      weightUnit,
      onLiveData,
      scaleAuth,
      readingTimeoutMs,
    });
    gattSucceeded = true;

    try {
      await device.disconnect();
    } catch {
      /* ignore */
    }
    return raw;
  } catch (err) {
    await classifyBleFailure(err, { gattAttempted, probeAdapter, abortSignal });
    throw err;
  } finally {
    await teardownSession({
      device,
      btAdapter: btAdapter!,
      deviceMac,
      bleAdapter,
      gattAttempted,
      gattSucceeded,
      abortSignal,
    });
  }
}

/** Scan, read, and compute body composition. Wrapper around scanAndReadRaw(). */
export async function scanAndRead(opts: ScanOptions): Promise<BodyComposition> {
  const { reading, adapter } = await scanAndReadRaw(opts);
  return adapter.computeMetrics(reading, opts.profile);
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

        try {
          const dev = await btAdapter.getDevice(addr);
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
  }
}
