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
 * Read weight + impedance from BLE service-data advertisements without connecting.
 *
 * Sets DuplicateData=true in the BlueZ discovery filter so every advertisement
 * triggers a PropertiesChanged signal, then subscribes to that signal on the
 * Device1 D-Bus object. Falls back to polling the ServiceData property every
 * 500 ms if signal subscription fails.
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

    /** Try to parse ServiceData entries and resolve if a complete reading is found. */
    const tryServiceData = (sd: unknown): boolean => {
      if (!sd || typeof sd !== 'object') return false;

      const entries: Iterable<[unknown, unknown]> =
        sd instanceof Map
          ? (sd as Map<unknown, unknown>).entries()
          : Object.entries(sd as Record<string, unknown>);

      for (const [uuid, val] of entries) {
        const buf = extractDbusBytes(val);
        if (!buf) continue;

        const reading = adapter.parseServiceData!(String(uuid), buf);
        if (!reading) continue;

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
        if (changedProps.ServiceData) tryServiceData(changedProps.ServiceData);
      };
      deviceHelper.on('PropertiesChanged', onPropsChanged);
      bleLog.debug('Subscribed to Device1 PropertiesChanged for ServiceData');
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
          const sd: unknown = await helperOf(device).prop('ServiceData');
          tryServiceData(sd);
        } catch (err: unknown) {
          bleLog.debug(`ServiceData poll error: ${errMsg(err)}`);
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
