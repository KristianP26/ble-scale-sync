import type { ScaleAdapter, ScaleReading } from '../../interfaces/scale-adapter.js';
import type { RawReading } from '../shared.js';
import { bleLog, sleep, errMsg, DISCOVERY_TIMEOUT_MS, IMPEDANCE_GRACE_MS } from '../types.js';
import {
  helperOf,
  getDbusNext,
  type PropsChangedHandler,
  type Adapter,
  type Device,
} from './dbus.js';
import { isDeviceObjectGone } from './device-object.js';

/** Extract a Buffer from a D-Bus value that may be a Variant wrapper, Buffer, Uint8Array, or number[]. */
export function extractDbusBytes(val: unknown): Buffer | null {
  if (!val) return null;
  // dbus-next wraps dict values in Variant objects, so unwrap .value if present.
  const inner: unknown =
    typeof val === 'object' && val !== null && 'value' in val
      ? (val as { value: unknown }).value
      : val;
  if (Buffer.isBuffer(inner)) return inner;
  if (inner instanceof Uint8Array) return Buffer.from(inner);
  if (Array.isArray(inner) && inner.every((b) => typeof b === 'number'))
    return Buffer.from(inner as number[]);
  // dbus-next serialises Buffer values to JSON as {type:"Buffer",data:[...]}
  // (standard Node.js Buffer.toJSON() format)
  if (typeof inner === 'object' && inner !== null && 'type' in inner && 'data' in inner) {
    const obj = inner as { type: unknown; data: unknown };
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return Buffer.from(obj.data as number[]);
    }
  }
  return null;
}

/**
 * Read weight + impedance from BLE advertisements without connecting.
 *
 * Sets DuplicateData=true in the BlueZ discovery filter so every advertisement
 * triggers a PropertiesChanged signal, then subscribes to that signal on the
 * Device1 D-Bus object. Falls back to polling every 500 ms if the signal
 * subscription fails.
 *
 * Both advertisement payloads are read: ServiceData through `parseServiceData`
 * and ManufacturerData through `parseBroadcast`. Handling only the first was
 * what made a manufacturer-data broadcast scale unreadable on Linux while
 * working on Noble, since nothing here ever looked at ManufacturerData (#297).
 */
export async function broadcastScanNodeBle(
  adapter: ScaleAdapter,
  btAdapter: Adapter,
  device: Device,
  mac: string,
  opts: { abortSignal?: AbortSignal; onLiveData?: (r: ScaleReading) => void },
): Promise<RawReading> {
  const { abortSignal, onLiveData } = opts;

  // Tell BlueZ to report duplicate advertisements so ServiceData is refreshed
  // on every packet from the scale, not just on first discovery.
  try {
    const { Variant } = await getDbusNext();
    const adapterHelper = helperOf(btAdapter);
    await adapterHelper.callMethod('SetDiscoveryFilter', {
      Transport: new Variant('s', 'le'),
      DuplicateData: new Variant('b', true),
    });
    bleLog.debug('Discovery filter: DuplicateData=true');
  } catch (err: unknown) {
    bleLog.debug(`SetDiscoveryFilter: ${errMsg(err)} (non-fatal, will poll)`);
  }

  bleLog.info(
    'Adapter prefers passive mode. Listening for broadcast weight data. Step on the scale.',
  );

  return new Promise<RawReading>((resolve, reject) => {
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let bestWeightOnly: RawReading | null = null;

    const finish = (result: RawReading) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    let onPropsChanged: PropsChangedHandler | null = null;

    const cleanup = () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      abortSignal?.removeEventListener('abort', onAbort);
      if (onPropsChanged) {
        try {
          helperOf(device).removeListener('PropertiesChanged', onPropsChanged);
        } catch {
          // Helper torn down or listener already removed.
        }
        onPropsChanged = null;
      }
    };

    const onAbort = () => fail(abortSignal!.reason ?? new DOMException('Aborted', 'AbortError'));
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    /** Iterate a BlueZ `{key: bytes}` advertisement dict. */
    const dbusEntries = (val: unknown): [string, Buffer][] => {
      if (!val || typeof val !== 'object') return [];
      const raw: Iterable<[unknown, unknown]> =
        val instanceof Map
          ? (val as Map<unknown, unknown>).entries()
          : Object.entries(val as Record<string, unknown>);
      const out: [string, Buffer][] = [];
      for (const [k, v] of raw) {
        const buf = extractDbusBytes(v);
        if (buf) out.push([String(k), buf]);
      }
      return out;
    };

    /**
     * Handle one parsed reading. Returns true when the scan is finished, so a
     * caller iterating advertisement entries can stop.
     */
    const consume = (reading: ScaleReading): boolean => {
      if (onLiveData) onLiveData(reading);

      if (adapter.isComplete(reading)) {
        bleLog.info(`Broadcast reading: ${reading.weight.toFixed(2)} kg`);
        finish({ reading, adapter });
        return true;
      }

      bleLog.debug(
        `${adapter.name} broadcast frame not yet complete ` +
          `(weight=${reading.weight.toFixed(2)} kg, impedance=${reading.impedance})`,
      );
      bestWeightOnly = { reading, adapter };
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          bleLog.info(
            `Broadcast reading (weight only, no impedance within ${IMPEDANCE_GRACE_MS / 1000}s): ` +
              `${bestWeightOnly!.reading.weight.toFixed(2)} kg`,
          );
          finish(bestWeightOnly!);
        }, IMPEDANCE_GRACE_MS);
      }
      return false;
    };

    /** Try to parse ServiceData entries and resolve if a complete reading is found. */
    const tryServiceData = (sd: unknown): boolean => {
      if (!adapter.parseServiceData) return false;
      for (const [uuid, buf] of dbusEntries(sd)) {
        const reading = adapter.parseServiceData(uuid, buf);
        if (reading && consume(reading)) return true;
      }
      return false;
    };

    /**
     * Try to parse ManufacturerData entries the same way.
     *
     * BlueZ keys this dict by company id and strips it from the value, which is
     * exactly the shape `parseBroadcast` expects, so the value is passed
     * through unchanged.
     *
     * Entries under a different company id are skipped when the adapter
     * declares one, so a device advertising under two ids cannot have the
     * wrong element parsed as a reading.
     */
    const wantedCompanyId = adapter.match?.manufacturerId;
    const tryManufacturerData = (md: unknown): boolean => {
      if (!adapter.parseBroadcast) return false;
      for (const [key, buf] of dbusEntries(md)) {
        if (wantedCompanyId !== undefined && Number(key) !== wantedCompanyId) continue;
        const reading = adapter.parseBroadcast(buf);
        if (reading && consume(reading)) return true;
      }
      return false;
    };

    // Subscribe to PropertiesChanged via node-ble's BusHelper, which re-emits
    // the signal directly (Device is constructed with usePropsEvents: true).
    // This fires on every advertisement when DuplicateData=true is set above.
    try {
      const deviceHelper = helperOf(device);
      onPropsChanged = (changedProps) => {
        if (done) return;
        if (changedProps.ServiceData && tryServiceData(changedProps.ServiceData)) return;
        if (changedProps.ManufacturerData) tryManufacturerData(changedProps.ManufacturerData);
      };
      deviceHelper.on('PropertiesChanged', onPropsChanged);
      bleLog.debug('Subscribed to Device1 PropertiesChanged for advertisement data');
    } catch (err: unknown) {
      bleLog.debug(`PropertiesChanged subscription failed: ${errMsg(err)} (poll fallback active)`);
      onPropsChanged = null;
    }

    // Poll ServiceData every 500 ms as a fallback (and for first-read before
    // the PropertiesChanged subscription is established).
    const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
    (async () => {
      while (!done && Date.now() < deadline) {
        if (abortSignal?.aborted) break;
        try {
          const helper = helperOf(device);
          // Each property is read separately so one failing does not hide the
          // other, but the rejection is NOT swallowed: BlueZ dropping the
          // Device1 object is the failure this whole path exists for, and a
          // silent poll would spin for the full discovery timeout and then
          // report the generic "no reading" message instead of the real cause.
          if (adapter.parseServiceData) {
            const sd: unknown = await helper.prop('ServiceData');
            if (tryServiceData(sd)) break;
          }
          if (adapter.parseBroadcast) {
            const md: unknown = await helper.prop('ManufacturerData');
            if (tryManufacturerData(md)) break;
          }
        } catch (err: unknown) {
          if (isDeviceObjectGone(err)) {
            fail(
              new Error(
                `BlueZ removed the device object for ${mac} during the broadcast scan, ` +
                  `so it is only visible while scanning is active (#297): ${errMsg(err)}`,
              ),
            );
            break;
          }
          bleLog.debug(`Advertisement poll error: ${errMsg(err)}`);
        }
        await sleep(500);
      }
      if (!done) {
        fail(
          new Error(
            `No stable broadcast reading within ${DISCOVERY_TIMEOUT_MS / 1000}s. ` +
              `Step on the scale and make sure it is awake.`,
          ),
        );
      }
    })();
  });
}
