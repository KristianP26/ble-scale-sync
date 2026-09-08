import { helperOf, releaseDeviceProxy, type Adapter } from './dbus.js';
import { LIVENESS_PROBE_WINDOW_MS, sleep as defaultSleep } from '../types.js';

/**
 * Minimal adapter surface the liveness probe needs, abstracted from node-ble so
 * the probe logic is unit-testable with a plain object (no D-Bus mocks).
 */
export interface LivenessAdapter {
  /** Addresses BlueZ currently knows about (its discovery cache). */
  listAddresses(): Promise<string[]>;
  /** Last-seen RSSI for an address, or undefined if unreadable / absent. */
  rssiOf(addr: string): Promise<number | undefined>;
}

/**
 * Wrap a real node-ble Adapter as a LivenessAdapter.
 *
 * The probe reads one property off every device BlueZ knows, twice per probe,
 * once per cycle, in a room that may hold dozens of advertisers. Each read
 * needs a throwaway Device proxy, and each proxy costs a D-Bus match rule plus
 * a listener on the shared signal emitter until it is released, so the release
 * is not tidiness here: without it a long-running continuous install leaks both
 * until the bus daemon refuses more match rules (#396, #397).
 */
export function makeLivenessAdapter(btAdapter: Adapter): LivenessAdapter {
  return {
    listAddresses: () => btAdapter.devices(),
    rssiOf: async (addr) => {
      let dev: unknown;
      try {
        dev = await btAdapter.getDevice(addr);
        const rssi = await helperOf(dev).prop('RSSI');
        return typeof rssi === 'number' ? rssi : undefined;
      } catch {
        return undefined;
      } finally {
        if (dev !== undefined) releaseDeviceProxy(dev);
      }
    },
  };
}

interface ProbeOpts {
  windowMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Decide whether the BLE radio is still actively scanning ("alive") by watching
 * advertisement activity over a short window while discovery runs.
 *
 * BlueZ updates `org.bluez.Device1.RSSI` on every received advertisement, so the
 * radio is alive if, between two samples `windowMs` apart, either a new device
 * address appears OR a known device's RSSI value moves. A wedged controller
 * (Discovering=true but not scanning) shows neither. Returns false on total
 * enumeration failure, so the watchdog safety net stays armed when the adapter
 * cannot even be queried.
 */
export async function probeLiveness(la: LivenessAdapter, opts: ProbeOpts = {}): Promise<boolean> {
  const windowMs = opts.windowMs ?? LIVENESS_PROBE_WINDOW_MS;
  const sleep = opts.sleep ?? defaultSleep;

  let first: Map<string, number | undefined>;
  try {
    first = await sample(la);
  } catch {
    return false;
  }

  await sleep(windowMs);

  let second: Map<string, number | undefined>;
  try {
    second = await sample(la);
  } catch {
    return false;
  }

  for (const [addr, rssi] of second) {
    if (!first.has(addr)) return true; // a new advertiser appeared
    const prev = first.get(addr);
    if (rssi !== undefined && prev !== undefined && rssi !== prev) return true; // RSSI moved
  }
  return false;
}

async function sample(la: LivenessAdapter): Promise<Map<string, number | undefined>> {
  const m = new Map<string, number | undefined>();
  for (const addr of await la.listAddresses()) {
    m.set(addr, await la.rssiOf(addr));
  }
  return m;
}
