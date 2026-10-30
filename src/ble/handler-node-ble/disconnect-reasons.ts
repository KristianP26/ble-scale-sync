/**
 * Why BlueZ ended a connection this process made, as one debug line (#434).
 *
 * A session that loses the scale midway ends in node-ble's `disconnect`, which
 * says nothing about who ended it. BlueZ 5.83 and later do: Device1.Disconnected
 * carries the kernel's reason (Remote, Timeout, Local, ...) and is sent before
 * Connected goes false and before any Disconnect is answered. That tells the
 * scale hanging up on purpose from a radio link that timed out, without btmon,
 * which a Home Assistant OS host does not ship.
 *
 * One raw match rule on the whole D-Bus connection rather than a ProxyObject
 * per device (the D066 link observer in link-observer.ts builds one per
 * connect attempt after a failure): no Introspect, nothing to stop at the end
 * of a session, and no window in which a listener is not yet attached or
 * already gone. The rule lives as long as the connection, which
 * resetConnection() drops after every GATT session, and the listener goes
 * with the bus object. On BlueZ before 5.83 the rule matches nothing and no
 * line is ever written.
 *
 * Only addresses this process connected are reported: on a Home Assistant OS
 * host, HA and other D-Bus clients have BLE devices of their own, and the rule
 * hears every one of them.
 */

import { isDebugEnabled } from '../../logger.js';
import { bleLog, errMsg } from '../types.js';

const DISCONNECTED_RULE =
  "type='signal',sender='org.bluez',interface='org.bluez.Device1',member='Disconnected'";

/** D-Bus wire message type SIGNAL (D-Bus spec; `dbus-next/lib/constants.js`). */
const DBUS_MESSAGE_TYPE_SIGNAL = 4;

/** `/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF`, the device object itself, not one under it. */
const DEVICE_PATH = /^\/org\/bluez\/hci\d+\/dev_([0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5})$/;

/**
 * What each reason means for a connection that was up, not for a failed
 * connect attempt (REASON_MEANINGS in stale-bond.ts says it for those).
 * Remote is not a fault on its own: many scales hang up after every weigh-in.
 */
const REASON_GLOSS: Record<string, string> = {
  'org.bluez.Reason.Remote': 'the scale ended it',
  'org.bluez.Reason.Timeout': 'link lost (supervision timeout)',
  'org.bluez.Reason.Local': 'this host ended it (this app, BlueZ or the kernel)',
  'org.bluez.Reason.Authentication': 'the scale refused the key',
  'org.bluez.Reason.Suspend': 'the host suspended',
};
const OTHER_GLOSS = 'other reason; btmon shows the code';

/**
 * The parts of a dbus-next 0.10.2 MessageBus this module uses. `_addMatch` is
 * internal (refcounted by the D012 patch in dbus-match-patch.ts); `message` is
 * the low-level event the class comment lists, emitted for every incoming
 * message before dbus-next dispatches it (`lib/bus.js`).
 */
interface RawSignalBus {
  _addMatch?: (rule: string) => Promise<unknown>;
  on?: (event: 'message', listener: (msg: unknown) => void) => unknown;
}

interface RawMessage {
  type?: unknown;
  path?: unknown;
  interface?: unknown;
  member?: unknown;
  body?: unknown;
}

let clock: () => number = () => performance.now();

/** When this process's connect to each address succeeded, by formatted MAC. */
const connectedAt = new Map<string, number>();

/**
 * A connect to `mac` (formatted) succeeded just now. The entry goes with the
 * line for this connection's end.
 */
export function noteConnected(mac: string): void {
  connectedAt.set(mac, clock());
}

/**
 * A connect to `mac` (formatted) is about to start. The end of the previous
 * connection can go unheard: a teardown that resets the D-Bus connection
 * before BlueZ sends the signal, or a stale link ended by the adapter
 * power-cycle. Its entry would then time a failed attempt of this connect
 * (D066 reports those) from a session minutes ago, so it goes here.
 */
export function noteConnecting(mac: string): void {
  connectedAt.delete(mac);
}

/** The debug line for one Device1.Disconnected, or undefined when it is not ours to report. */
function describeDisconnect(raw: unknown): string | undefined {
  const msg = raw as RawMessage | null | undefined;
  if (
    msg?.type !== DBUS_MESSAGE_TYPE_SIGNAL ||
    msg.interface !== 'org.bluez.Device1' ||
    msg.member !== 'Disconnected' ||
    typeof msg.path !== 'string'
  ) {
    return undefined;
  }
  const m = DEVICE_PATH.exec(msg.path);
  if (!m) return undefined;
  const mac = m[1].replace(/_/g, ':').toUpperCase();
  const at = connectedAt.get(mac);
  if (at === undefined) return undefined;
  const [reason, message] = Array.isArray(msg.body) ? (msg.body as unknown[]) : [];
  if (typeof reason !== 'string' || typeof message !== 'string') return undefined;
  connectedAt.delete(mac);
  const secs = ((clock() - at) / 1000).toFixed(2);
  const detail = message ? ` (${message})` : '';
  const gloss = REASON_GLOSS[reason] ?? OTHER_GLOSS;
  return `BlueZ: ${mac} disconnected ${secs} s after connect: ${reason}${detail} - ${gloss}`;
}

/**
 * Listen for Device1.Disconnected on a freshly created D-Bus connection, when
 * debug output is on at that moment. Debug switched on later (a config
 * reload) takes effect with the next connection: resetConnection() opens one
 * after every GATT session, but idle cycles keep theirs, so the first
 * weigh-in after the reload can still go without the line. Never throws: a
 * failed AddMatch only costs the line.
 */
export function watchDisconnectReasons(bus: unknown): void {
  try {
    if (!isDebugEnabled()) return;
    const raw = bus as RawSignalBus | null | undefined;
    if (typeof raw?._addMatch !== 'function' || typeof raw.on !== 'function') {
      bleLog.debug('Disconnect reasons not watched: dbus-next internals changed');
      return;
    }
    // dbus-next runs `message` listeners inside the try that also dispatches
    // the message, and a throw there skips the dispatch and answers the signal
    // with an error: this listener must never throw.
    raw.on('message', (msg: unknown) => {
      try {
        const line = describeDisconnect(msg);
        if (line) bleLog.debug(line);
      } catch {
        // A malformed message: no line.
      }
    });
    // Through the D012 patch, so the rule is refcounted like every other one.
    // A refusal (LimitsExceeded, a closed socket) only costs the line.
    void Promise.resolve(raw._addMatch(DISCONNECTED_RULE)).catch((err: unknown) => {
      bleLog.debug(`Disconnect reasons not watched: ${errMsg(err)}`);
    });
  } catch (err) {
    bleLog.debug(`Disconnect reasons not watched: ${errMsg(err)}`);
  }
}

/** Test seam: the clock (fake timers do not move performance.now()) and the connect times. */
export function _resetDisconnectReasonsForTests(now?: () => number): void {
  clock = now ?? (() => performance.now());
  connectedAt.clear();
}
