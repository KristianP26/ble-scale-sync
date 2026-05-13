import NodeBle from 'node-ble';
import { bleLog, errMsg } from '../types.js';

type Adapter = NodeBle.Adapter;

// Persistent D-Bus connection + adapter, reused across scan cycles in
// continuous mode. Same client owns the discovery session across cycles;
// same adapter proxy means stopDiscovery() always matches startDiscovery().
// Minimizes the start/stop cycling that triggers the BlueZ Discovering desync
// (bluez/bluez#807, bluez/bluer#47).

let persistentConn: { bluetooth: NodeBle.Bluetooth; destroy: () => void } | null = null;
let persistentAdapter: Adapter | null = null;

export function getConnection(): { bluetooth: NodeBle.Bluetooth; destroy: () => void } {
  if (!persistentConn) {
    persistentConn = NodeBle.createBluetooth();
    bleLog.debug('D-Bus connection established');
  }
  return persistentConn;
}

export async function getAdapter(bleAdapter?: string): Promise<Adapter> {
  const conn = getConnection();
  if (!persistentAdapter) {
    if (bleAdapter) {
      bleLog.debug(`Using adapter: ${bleAdapter}`);
      persistentAdapter = await conn.bluetooth.getAdapter(bleAdapter);
    } else {
      persistentAdapter = await conn.bluetooth.defaultAdapter();
    }
  }
  return persistentAdapter;
}

export function resetConnection(): void {
  persistentAdapter = null;
  if (persistentConn) {
    try {
      persistentConn.destroy();
    } catch {
      /* ignore */
    }
    persistentConn = null;
    bleLog.debug('D-Bus connection reset');
  }
}

/** Returns true if the error indicates a stale or broken D-Bus connection. */
export function isStaleConnectionError(err: unknown): boolean {
  const msg = errMsg(err);
  return (
    msg.includes('interface not found') ||
    msg.includes('not found in proxy') ||
    msg.includes('connection closed') ||
    msg.includes('The name is not activatable') ||
    msg.includes('was not provided')
  );
}

export function isDbusConnectionError(err: unknown): boolean {
  const msg = errMsg(err);
  return msg.includes('ENOENT') && msg.includes('bus_socket');
}

export function dbusError(): Error {
  return new Error(
    'Cannot connect to D-Bus. Bluetooth is not accessible.\n' +
      'If running in Docker, mount the D-Bus socket:\n' +
      '  -v /var/run/dbus:/var/run/dbus:ro\n' +
      'On the host, ensure bluetoothd is running:\n' +
      '  sudo systemctl start bluetooth',
  );
}

/** Extract the numeric index from an hci adapter name (e.g., 'hci1' -> 1). */
export function parseHciIndex(adapterName?: string): number {
  if (!adapterName) return 0;
  const match = adapterName.match(/^hci(\d+)$/);
  return match ? Number(match[1]) : 0;
}
