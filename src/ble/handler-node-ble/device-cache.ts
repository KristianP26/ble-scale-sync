/**
 * Whether a MAC-pinned scale's BlueZ object is removed before a node-ble
 * cycle, and the check that lets a kept one be used (#425, D060).
 *
 * The removal used to run before every cycle. It also throws away BlueZ's
 * cached GATT database, so every connect paid for a full service discovery
 * (2 to 19 s on a Robi S9), and that cost a time-sensitive scale its weigh-in.
 * But it was also the only reason `waitDevice()` meant "the scale is
 * advertising": node-ble polls for the object's path, once a second, and
 * BlueZ makes a device permanent as soon as `Device1.Connect()` is called on
 * it (`dev_connect()`, BlueZ 5.66 and 5.82), so without the removal the object
 * outlives the scale's sleep and the wait returns at once.
 *
 * So the removal stays wherever a kept object could do harm: an adapter that
 * reads advertisements would parse the last weigh-in's cached frame again
 * (#372), a bonding adapter's pairing path is not to be changed without data,
 * and a scale not read yet in this run is unknown. Where it is skipped, a
 * latch on the kept object has to hear a report from BlueZ in this cycle
 * before the object is used.
 */

import type { BleDeviceInfo, ScaleAdapter } from '../../interfaces/scale-adapter.js';
import { isForced } from '../../scales/force.js';
import { bleLog, errMsg, formatMac, DISCOVERY_TIMEOUT_MS } from '../types.js';
import {
  helperOf,
  releaseDeviceProxy,
  type Adapter,
  type Device,
  type PropsChangedHandler,
} from './dbus.js';
import type { AdvertisementSnapshot } from './device-object.js';

/**
 * The no-show message of the MAC wait. Shared, so a kept object that never
 * advertises ends its cycle with the exact line a removed one always did.
 */
export function targetNotFoundMessage(mac: string): string {
  return `Device ${mac} not found within ${DISCOVERY_TIMEOUT_MS / 1000}s`;
}

/**
 * The no-show message of auto-discovery. Shared, so a cycle can tell that
 * nothing was found apart from a wait that failed for another reason (#471).
 */
export function noScaleRecognizedMessage(): string {
  return `No recognized scale found within ${DISCOVERY_TIMEOUT_MS / 1000}s`;
}

/**
 * What a BlueZ device is matched on: its name, its address and what its
 * advertisement snapshot holds. BlueZ shows no advertised service UUIDs
 * before a connect, so the list is empty.
 */
export function deviceInfoFrom(
  name: string,
  mac: string,
  advert: AdvertisementSnapshot | undefined,
): BleDeviceInfo {
  return {
    localName: name,
    address: mac ? formatMac(mac) : undefined,
    serviceUuids: [],
    ...(advert?.manufacturerData ? { manufacturerData: advert.manufacturerData } : {}),
    ...(advert?.serviceData && advert.serviceData.length > 0
      ? { serviceData: advert.serviceData }
      : {}),
  };
}

/** Any advertisement parser, passive or not (QN, Eufy P2 and Mi Scale 2 included). */
export function canReadAdvertisement(adapter: ScaleAdapter): boolean {
  return (
    typeof adapter.parseBroadcast === 'function' || typeof adapter.parseServiceData === 'function'
  );
}

/**
 * Formatted MAC -> name of the adapter the last reading in this process came
 * through. A name and not the object, so the lookup goes through the adapter
 * list the cycle was handed. Process lifetime on purpose: after a restart the
 * first cycle removes the object exactly as before.
 */
const lastReadingAdapter = new Map<string, string>();

/** MACs the one-time info line was printed for. */
const keptAnnounced = new Set<string>();

/** Test hook: forget every remembered reading and announcement. */
export function _resetDeviceCacheForTests(): void {
  lastReadingAdapter.clear();
  keptAnnounced.clear();
}

/**
 * Record which adapter a reading for this MAC came through. Also for a cycle
 * the poll loop has given up on meanwhile: a GATT-only reading is a fact about
 * the scale, not about the cycle.
 */
export function rememberReadingAdapter(mac: string, adapter: ScaleAdapter): void {
  lastReadingAdapter.set(formatMac(mac), adapter.name);
}

export function forgetReadingAdapter(mac: string): void {
  lastReadingAdapter.delete(formatMac(mac));
}

/** Whether to keep the scale's BlueZ object for this cycle, and why. */
export function cachePolicyFor(
  mac: string,
  adapters: readonly ScaleAdapter[],
): { keep: boolean; adapter?: ScaleAdapter; reason: string } {
  let adapter: ScaleAdapter | undefined;
  if (adapters.length === 1 && isForced(adapters[0])) {
    // Known from the first cycle: the override is the only adapter there is.
    adapter = adapters[0];
  } else {
    const name = lastReadingAdapter.get(formatMac(mac));
    adapter = name === undefined ? undefined : adapters.find((a) => a.name === name);
  }
  if (!adapter) return { keep: false, reason: 'no reading from this scale in this run yet' };
  if (canReadAdvertisement(adapter)) {
    return { keep: false, adapter, reason: `${adapter.name} can read advertisements` };
  }
  if (adapter.requiresBonding === true) {
    return { keep: false, adapter, reason: `${adapter.name} requires bonding` };
  }
  return { keep: true, adapter, reason: `${adapter.name} reads over GATT only` };
}

/** Info once per process and MAC, so the effect shows without DEBUG. */
export function announceKept(mac: string, adapterName: string): void {
  const key = formatMac(mac);
  if (keptAnnounced.has(key)) return;
  keptAnnounced.add(key);
  bleLog.info(
    `Keeping ${key} known to BlueZ between weigh-ins (${adapterName} reads over GATT only), ` +
      'so the next connect can reuse its service cache.',
  );
}

export interface FreshAdvertLatch {
  /** The adapter object, and so the bus, the listener lives on. */
  readonly adapter: Adapter;
  /** Resolves once a fresh report arrived since arming (at once if one did). */
  heard(budgetMs: number, mac: string, abortSignal?: AbortSignal): Promise<void>;
  /** Idempotent: our listener off, the proxy released. */
  release(): void;
}

export type HeldObject =
  | { kind: 'absent' } // nothing held: the first report creates it, as after a removal
  | { kind: 'paired' } // the usual path; removeDevice never removes a paired device
  | { kind: 'unknown'; error: string } // remove it as before
  | { kind: 'armed'; latch: FreshAdvertLatch };

/**
 * The properties only BlueZ's `btd_adapter_device_found()` sets, so a change
 * to one means an advertising report arrived. Under our filtered discovery
 * (DuplicateData) RSSI changes on every report, even at the same value.
 * Clearing RSSI goes out as an invalidated property, which node-ble does not
 * forward, so that cannot open the gate.
 */
export const FRESH_REPORT_PROPS = ['RSSI', 'ManufacturerData', 'ServiceData'] as const;

/**
 * Put a listener on the scale's kept BlueZ object before discovery starts.
 *
 * Before and not after `waitDevice()`: that looks first after a second, and
 * the maintainer's Pi delivers a scan window's reports in one burst at its
 * start, then nothing for 5 to 8 s. A listener added later could miss the
 * burst of a scale that is already advertising and let it in one window late.
 *
 * `isPaired()` is read directly rather than through `isBonded()`, which
 * answers false on an error: an unreadable property means node-ble's
 * PropertiesChanged forwarding may not be running either, and a latch that
 * hears nothing would turn an awake scale into a no-show. That case removes
 * the object as before. Reading the property is also what starts the
 * forwarding and adds the match rule, so the listener is live once it returns.
 */
export async function armFreshAdvertLatch(btAdapter: Adapter, mac: string): Promise<HeldObject> {
  let device: Device;
  try {
    device = await btAdapter.getDevice(mac);
  } catch (err) {
    if (errMsg(err).includes('Device not found')) return { kind: 'absent' };
    return { kind: 'unknown', error: errMsg(err) };
  }
  let paired: boolean;
  try {
    paired = ((await device.isPaired()) as unknown as boolean) === true;
  } catch (err) {
    releaseDeviceProxy(device);
    return { kind: 'unknown', error: errMsg(err) };
  }
  if (paired) {
    releaseDeviceProxy(device);
    return { kind: 'paired' };
  }

  const helper = helperOf(device);
  let heardFresh = false;
  let wake: (() => void) | undefined;
  const onProps: PropsChangedHandler = (props) => {
    if (heardFresh) return;
    if (!FRESH_REPORT_PROPS.some((p) => p in props)) return;
    heardFresh = true;
    wake?.();
  };
  try {
    helper.on('PropertiesChanged', onProps);
  } catch (err) {
    releaseDeviceProxy(device);
    return { kind: 'unknown', error: errMsg(err) };
  }

  let released = false;
  const latch: FreshAdvertLatch = {
    adapter: btAdapter,
    heard(budgetMs, target, abortSignal) {
      if (heardFresh) return Promise.resolve();
      if (abortSignal?.aborted) {
        return Promise.reject(abortSignal.reason ?? new DOMException('Aborted', 'AbortError'));
      }
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            done();
            reject(new Error(targetNotFoundMessage(target)));
          },
          Math.max(0, budgetMs),
        );
        const onAbort = (): void => {
          done();
          reject(abortSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        // Every way out drops the timer, the abort listener and the waiter;
        // the PropertiesChanged listener stays until release().
        const done = (): void => {
          clearTimeout(timer);
          abortSignal?.removeEventListener('abort', onAbort);
          wake = undefined;
        };
        wake = () => {
          done();
          resolve();
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    release() {
      if (released) return;
      released = true;
      try {
        helper.removeListener('PropertiesChanged', onProps);
      } catch {
        /* the proxy release below drops it either way */
      }
      releaseDeviceProxy(device);
    },
  };
  return { kind: 'armed', latch };
}
