import type {
  ScaleAdapter,
  UserProfile,
  ScaleReading,
  ScaleAuth,
  LiveWeight,
} from '../interfaces/scale-adapter.js';
import type {
  WeightUnit,
  MqttProxyConfig,
  EsphomeProxyConfig,
  HaBluetoothConfig,
} from '../config/schema.js';
import { createLogger } from '../logger.js';
import { errMsg } from '../utils/error.js';
import { stripAnsi, parseBtmgmtSettings, btmgmtErrorLine } from './btmgmt.js';
export { errMsg };

// ─── Constants ────────────────────────────────────────────────────────────────

export const LBS_TO_KG = 0.453592;
export const BT_BASE_UUID_SUFFIX = '00001000800000805f9b34fb';
export const CONNECT_TIMEOUT_MS = 30_000;

/**
 * How long a Device1.Disconnect (node-ble) may go unanswered before the link
 * counts as stuck in BlueZ (#472).
 *
 * BlueZ answers a Disconnect for a device it lists as connected only once the
 * connection is gone, and sends the kernel its MGMT Disconnect after a 2 s
 * timer (DISCONNECT_TIMER). A kernel from v6.11 on waits at most 2 s more for
 * the controller (HCI_CMD_TIMEOUT) and answers either way, and a device that is
 * not connected is answered at once, so a healthy Disconnect is in by about
 * 4 s. With a kernel older than that the MGMT Disconnect waits for the
 * controller's Disconnection Complete, which a weak link can stretch to the
 * supervision timeout (up to 32 s): there this can end a slow but healthy
 * Disconnect early and cost one unneeded power-cycle. The debug line with the
 * measured answer time is what this number should be tuned against.
 */
export const DISCONNECT_TIMEOUT_MS = 10_000;

export const MAX_CONNECT_RETRIES = 5;
export const DISCOVERY_TIMEOUT_MS = 120_000;
export const DISCOVERY_POLL_MS = 2_000;

/** Timeout for GATT service/characteristic enumeration after connecting. */
export const GATT_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * How long the reading phase waits without a notification from the scale. The
 * timer restarts on every frame except a status frame (isStatusFrame, D070),
 * so it counts silence rather than time since connect: a window counted from
 * connect can expire before the user steps on, because connect is driven by
 * the advertisement, not the weigh-in. Native handlers and the single-shot
 * mqtt-proxy scan; the proxy watchers use their own GATT_READING_IDLE_MS.
 */
export const RAW_READING_TIMEOUT_MS = 120_000;

/**
 * Absolute cap on one native reading session, as a multiple of the configured
 * silence window. The idle timer restarts on every frame except a status frame
 * (isStatusFrame, D070), so a scale that streams adapter-rejected frames
 * forever would otherwise hold the session open with no bound; the cap ends it
 * while leaving room for a weigh-in that spans several restarts. A composition
 * hold can move it out, by at most the hold plus HOLD_EXTENSION_MAX_MS plus 2 s
 * (withIdleTimeout, #211). A session_timeout_sec above 300 makes
 * POLL_CYCLE_TIMEOUT_MS the effective ceiling instead.
 */
export const READING_SESSION_CAP_FACTOR = 3;

/**
 * Max attempts to enumerate GATT characteristics. BlueZ can signal
 * `ServicesResolved=true` before all characteristic interfaces are exported
 * over D-Bus ([bluez/bluez#1489](https://github.com/bluez/bluez/issues/1489)),
 * so the first enumeration can return a partial map. Retrying with a short
 * backoff lets BlueZ finish exporting before we validate the map.
 */
export const CHAR_DISCOVERY_MAX_RETRIES = 3;

/** Backoff between characteristic-enumeration retries. */
export const CHAR_DISCOVERY_RETRY_DELAY_MS = 500;

/** Delay after stopping BlueZ discovery to let the radio quiesce before connecting. */
export const POST_DISCOVERY_QUIESCE_MS = 500;

/**
 * Hard ceiling on one native poll cycle.
 *
 * The reading phase is bounded by scale silence, capped in absolute terms at
 * READING_SESSION_CAP_FACTOR x the silence window (360 s by default), plus at
 * most one composition hold. The worst legitimate node-ble cycle is then roughly
 * 847 s (discovery 120 + six connect attempts 170 + GATT acquisition 30 +
 * characteristic retries + reading 360 + a 32 s R-MSC04 hold),
 * so 900 s never fires on a healthy run with the default session_timeout_sec.
 *
 * It exists because dbus-next never rejects an in-flight `MessageBus.call()`
 * by itself: the resolver is stored in `_methodReturnHandlers` and is only ever
 * read when a reply arrives, so a broken D-Bus transport parks the cycle
 * forever. The node-ble connection fails those calls when the bus closes the
 * socket (A-03), but a daemon that keeps the socket open and never answers is
 * still only caught here. Without a deadline the consecutive-failure watchdog
 * is never reached and a dead transport looks exactly like an idle house (#290).
 *
 * A healthy daemon can leave a call unanswered too: a Disconnect or
 * RemoveDevice for a link BlueZ still lists as connected waits on that link
 * (#472). Those calls carry their own 10 s deadlines on the connect and
 * teardown path (DISCONNECT_TIMEOUT_MS, and the BlueZ call deadline in
 * discovery.ts), so this one is only the last net there.
 */
export const POLL_CYCLE_TIMEOUT_MS = 900_000;

/**
 * Minimum cooldown floor after a successful read in continuous mode.
 * BLE scales typically keep advertising for 15-25 s after the user steps off
 * (display goes dark, link layer winds down). Connecting during that tail-off
 * triggers BlueZ to accept the request against a peer that never completes
 * GATT discovery, which on some controllers stalls the D-Bus call inside
 * node-ble synchronously. A 25 s floor sidesteps the dying-peer window
 * entirely. A cycle without a reading waits for the retry backoff (or
 * idle_rescan_delay, or at least runtime.no_reading_rescan_delay after a
 * session that heard the scale and then went quiet until its idle timeout)
 * instead; this floor applies on success.
 *
 * BlueZ-specific: only the `node-ble` handler hits the dying-peer GATT stall.
 * Proxy handlers (mqtt-proxy, esphome-proxy) and the noble-based stacks talk
 * to a different transport and do not need this floor; the orchestrator gates
 * application based on the resolved handler. See #143. The proxy watchers keep
 * no distance at all; how their session after a reading is logged is
 * POST_READING_RECONNECT_MS.
 */
export const POST_DISCONNECT_GRACE_MS = 25_000;

/**
 * How long after a GATT reading a proxy watcher's next session to the same
 * scale counts as the scale still being on after that weigh-in (#466).
 *
 * The proxy watchers keep no distance from a scale after a reading, on
 * purpose: a second person stepping on before it switches off is read in that
 * session, and on mqtt-proxy the ESP32 reconnects by itself anyway. Such a
 * session ending without a reading is expected, not a failure. Measured from
 * the reading to the moment the next session opens, or from the end of such a
 * session to the next one, for a scale that stays connectable for minutes
 * after a weigh-in (#474, PostReadingWindow). 60 s covers the usual
 * first reconnect: under a second on ESPHome, a few seconds on an ESP32-S3,
 * about 10 to 13 s on a classic ESP32. A classic board that also waits out a
 * Wi-Fi recovery and connect retries can take longer, and that session still
 * warns.
 */
export const POST_READING_RECONNECT_MS = 60_000;

/** Threshold below which a cached RSSI is considered stale (BlueZ uses 127 as "unavailable" sentinel). */
export const RSSI_UNAVAILABLE = 127;

/**
 * Maximum age of the last RSSI PropertiesChanged signal before a peer is
 * considered to have stopped advertising. Typical BLE scale advertising
 * intervals are 100-500 ms, so 5 s gives roughly 10-50 missed packets of slack
 * before we treat the device reference as stale. See #143.
 */
export const RSSI_FRESHNESS_MS = 5_000;

/**
 * Observation window for the watchdog liveness probe (#213). After a failed idle
 * scan we watch advertisement activity for this long to tell a live-but-idle
 * radio (saw other adverts) from a wedged controller (saw nothing).
 */
export const LIVENESS_PROBE_WINDOW_MS = 3_000;

/**
 * Grace window after a weight-only broadcast frame is received.
 * The Mi Scale 2 broadcasts weight-only frames while BIA is in progress, then
 * a final frame with impedance once the measurement completes (~10-20 s on device).
 * If an impedance-bearing frame arrives within this window the complete reading is
 * used; otherwise the weight-only reading is forwarded as a fallback.
 *
 * The Silvergear 108 uses the same hold for its post-weigh-in frame, and its
 * `BODY_FRAME_WINDOW_MS` must stay below this value: the proxy watchers queue
 * the fallback without recording it for dedup, so a frame paired after the
 * fallback would export the weigh-in twice (#357). A test pins the ordering.
 */
export const IMPEDANCE_GRACE_MS = 12_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type BleHandlerName = 'auto' | 'mqtt-proxy' | 'esphome-proxy' | 'ha-bluetooth';

export interface ScanOptions {
  targetMac?: string;
  adapters: ScaleAdapter[];
  profile: UserProfile;
  scaleAuth?: ScaleAuth;
  weightUnit?: WeightUnit;
  onLiveData?: (reading: ScaleReading) => void;
  /**
   * Settling weights from a broadcast scale, for a display that follows it
   * (#356). A `LiveWeight` is not a `ScaleReading` and cannot be exported.
   */
  onLiveWeight?: (live: LiveWeight) => void;
  abortSignal?: AbortSignal;
  bleHandler?: BleHandlerName;
  mqttProxy?: MqttProxyConfig;
  esphomeProxy?: EsphomeProxyConfig;
  haBluetooth?: HaBluetoothConfig;
  bleAdapter?: string;
  /** Override RAW_READING_TIMEOUT_MS (seconds of silence) for one session (ble.session_timeout_sec, #83). */
  readingTimeoutMs?: number;
  /**
   * Clear a bond the scale has forgotten instead of only diagnosing it
   * (`ble.auto_clear_stale_bond`, #335), and only when the scale is seen
   * refusing the key (D066). node-ble only; the other transports have no bond
   * to clear.
   */
  autoClearStaleBond?: boolean;
  /**
   * Run the preemptive btmgmt power-cycle after a GATT session
   * (`ble.preemptive_adapter_reset`, #80, #417). Undefined means true; only an
   * explicit false skips it. node-ble only.
   */
  preemptiveAdapterReset?: boolean;
  /**
   * Keep LE privacy on, with an IRK derived from the adapter address, and skip
   * the connect when it is off (`ble.adapter_privacy`, #417). node-ble only.
   */
  adapterPrivacy?: boolean;
  /**
   * Longest wait, in minutes, before a bonding scale whose pairing nobody
   * confirmed is connected again (`ble.pairing_retry_max_min`, #471, D063).
   * Undefined means the handler's default; 0 never holds it back. node-ble only.
   */
  pairingRetryMaxMin?: number;
}

export interface ScanResult {
  address: string;
  name: string;
  matchedAdapter?: string;
}

// ─── Pure utilities ───────────────────────────────────────────────────────────

export const bleLog = createLogger('BLE');

/**
 * Normalize a UUID to lowercase 32-char (no dashes) form for comparison.
 *
 * Accepts the shapes the transports actually hand us: 16-bit ('181b'), 32-bit,
 * full 128-bit with or without dashes, and the braced form some stacks print.
 * This is the only normalizer in the project; there used to be five, one of
 * which returned the DASHED form under the same name and would silently never
 * match anything compared against this one (#406).
 */
export function normalizeUuid(uuid: string): string {
  const stripped = uuid.replace(/[-{}]/g, '').toLowerCase();
  if (stripped.length === 4) {
    return `0000${stripped}${BT_BASE_UUID_SUFFIX}`;
  }
  if (stripped.length === 8) {
    return `${stripped}${BT_BASE_UUID_SUFFIX}`;
  }
  return stripped;
}

/** Format MAC address for BlueZ D-Bus (uppercase with colons). */
export function formatMac(mac: string): string {
  const clean = mac.replace(/[:-]/g, '').toUpperCase();
  return clean.match(/.{2}/g)!.join(':');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts.
 *
 * Like withTimeout this abandons the raced promise rather than cancelling it,
 * so the caller still owns whatever that promise holds. The listener is removed
 * on every path because continuous mode reuses one signal for every cycle, and
 * a listener left behind per call is a MaxListenersExceededWarning and then a
 * leak for the life of the process.
 */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The raced promise still needs a handler, or its later rejection would
    // surface as unhandled.
    promise.catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

// Canonical home is src/utils/timeout.ts: the MQTT exporter needs it too, and
// an exporter importing from the BLE layer would be the wrong way round.
// Re-exported here so the BLE call sites keep their existing import.
export { withTimeout } from '../utils/timeout.js';

/**
 * A reading session that ran out of time on its own clock: the idle window
 * passed without activity (`'idle'`), or the absolute cap was reached
 * (`'cap'`). By then the scale was found, connected and subscribed, so the
 * loop must not log it as "No scale found" (#460).
 *
 * Indistinguishable from a plain Error except by `instanceof` and `reason`:
 * `name` stays the inherited 'Error', so `String(err)` and the log text are
 * unchanged, and `reason` is a getter, not an own enumerable property, so a
 * test comparing against `new Error(msg)` with toEqual still matches (Vitest
 * compares name and own enumerable properties of errors).
 */
export class SessionTimeoutError extends Error {
  readonly #reason: 'idle' | 'cap';

  constructor(message: string, reason: 'idle' | 'cap') {
    super(message);
    this.#reason = reason;
  }

  get reason(): 'idle' | 'cap' {
    return this.#reason;
  }
}

/**
 * BlueZ still lists the scale as connected and did not complete a
 * Device1.Disconnect within DISCONNECT_TIMEOUT_MS (#472). Another connect
 * attempt would "succeed" at once from that state and then wait in vain for
 * the services, so the retry loop stops and the teardown recovers the adapter.
 *
 * Same shape as SessionTimeoutError: `name` stays 'Error' and `mac` is a
 * getter, not an own enumerable property. Lives here rather than in the
 * node-ble handler because the runtime picks the log prefix by it, and the
 * handler is an optional dependency the runtime must not import.
 */
export class StaleLinkError extends Error {
  readonly #mac: string;

  constructor(mac: string) {
    super(
      `BlueZ keeps ${mac} marked as connected and did not complete a Disconnect within ` +
        `${DISCONNECT_TIMEOUT_MS / 1000}s (#472)`,
    );
    this.#mac = mac;
  }

  get mac(): string {
    return this.#mac;
  }
}

/**
 * The scale was found, but it is not paired and nobody confirmed the last
 * pairing on it, so this cycle did not connect to it (#471, D063). The cycle
 * listened to its advertisements for the rest of the discovery budget instead.
 *
 * Same shape as SessionTimeoutError: `name` stays 'Error' and `mac` is a
 * getter. Lives here for the same reason as StaleLinkError: the runtime picks
 * the log prefix by it and must not import the node-ble handler.
 */
export class PairingDeferredError extends Error {
  readonly #mac: string;

  constructor(mac: string, waitMs: number) {
    const min = Math.max(1, Math.ceil(waitMs / 60_000));
    // A wait that is over but heard no report since says so, rather than a
    // minute that has nothing to do with when the next attempt goes.
    super(
      waitMs > 0
        ? `${mac} is not paired; next pairing attempt in ${min} min, ` +
            'or sooner if it reappears or advertises a new weigh-in'
        : `${mac} is not paired; next pairing attempt as soon as it is heard again`,
    );
    this.#mac = mac;
  }

  get mac(): string {
    return this.#mac;
  }
}

/**
 * Like withTimeout, but the deadline restarts whenever `start`'s callback is
 * invoked: the returned promise rejects after `ms` with no activity. Like
 * withTimeout, the promise from `start` is abandoned rather than cancelled, so
 * callers must still tear down whatever it holds.
 *
 * `onActivity(minIdleMs)` additionally promises that the session is waiting on
 * purpose for at least that long, and later activity does not shorten it. A
 * composition hold uses this: after the weight settles a scale can stay silent
 * for longer than a short `session_timeout_sec`, and the idle timeout winning
 * that race drops the settled weight together with the composition it was
 * waiting for. The hold is bounded by its own timer, so this cannot keep a
 * session open indefinitely.
 *
 * `cap` is an absolute deadline for the whole session, counted from the call,
 * that activity does not restart. A requested minimum window moves it out too
 * when the window would end later: with the cap at 3 x a 5 s
 * `session_timeout_sec`, a 30 s hold armed a few seconds in was otherwise still
 * cut at 15 s, and the held weight dropped with it (#434). Only that minimum
 * window moves the cap, and the hold that requests it arms once per session
 * plus at most HOLD_EXTENSION_MAX_MS of extensions (#211), so the cap stays
 * bounded.
 */
export async function withIdleTimeout<T>(
  start: (onActivity: (minIdleMs?: number) => void) => Promise<T>,
  ms: number,
  message: string,
  cap?: { ms: number; message: string },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout!: (err: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  let capAt = 0;
  const armCap = (at: number): void => {
    if (!cap) return;
    capAt = at;
    clearTimeout(capTimer);
    capTimer = setTimeout(
      () => rejectTimeout(new SessionTimeoutError(cap.message, 'cap')),
      at - Date.now(),
    );
  };
  if (cap) armCap(Date.now() + cap.ms);
  let floorAt = 0;
  const onActivity = (minIdleMs?: number): void => {
    const now = Date.now();
    if (minIdleMs !== undefined && minIdleMs > 0) {
      floorAt = Math.max(floorAt, now + minIdleMs);
      if (cap && floorAt > capAt) armCap(floorAt);
    }
    clearTimeout(timer);
    timer = setTimeout(
      () => rejectTimeout(new SessionTimeoutError(message, 'idle')),
      Math.max(ms, floorAt - now),
    );
  };
  onActivity();
  try {
    return await Promise.race([start(onActivity), timeout]);
  } finally {
    clearTimeout(timer);
    clearTimeout(capTimer);
  }
}

/** Set once the first refused btmgmt power-cycle has been reported at info. */
let btmgmtRefusalAnnounced = false;

/** Test seam: the announcement above is per process on purpose. */
export function _resetBtmgmtResetStateForTests(): void {
  btmgmtRefusalAnnounced = false;
}

/**
 * Power-cycle the controller with `btmgmt power off` / `power on`.
 *
 * True only when the adapter really went down and came back. btmgmt's exit
 * status cannot tell: it exits 0 when the kernel refuses the command, which is
 * what happens without CAP_NET_ADMIN (`Permission Denied`), and prints the
 * refusal in red on stdout. So the outcome is read from that output and from a
 * separate `btmgmt info`, the same way ble.adapter_privacy checks its own
 * writes. Reporting a refused reset as done made the btmgmt recovery tier
 * count as a success and reset the D-Bus connection for nothing, and the
 * preemptive reset after each session claimed a power-cycle that never ran.
 */
export async function resetAdapterBtmgmt(adapterIndex = 0): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const idx = String(adapterIndex);
  let execFile: typeof import('node:child_process').execFile;
  try {
    ({ execFile } = await import('node:child_process'));
  } catch (err) {
    bleLog.debug(`btmgmt reset failed: ${errMsg(err)}`);
    return false;
  }
  // Never rejects: a spawn error, non-zero exit or timeout comes back as `failure`.
  const run = (args: string[]): Promise<{ out: string; failure?: string }> =>
    new Promise((resolve) => {
      try {
        execFile('btmgmt', args, { timeout: 5000, encoding: 'utf8' }, (err, stdout, stderr) => {
          const out = stripAnsi(`${stdout ?? ''}${stderr ?? ''}`);
          resolve(err ? { out, failure: errMsg(err) } : { out });
        });
      } catch (err) {
        resolve({ out: '', failure: errMsg(err) });
      }
    });
  const poweredNow = async (): Promise<boolean | undefined> =>
    parseBtmgmtSettings((await run(['--index', idx, 'info'])).out)?.current.includes('powered');
  const refused = (why: string): false => {
    const line = `btmgmt could not power-cycle hci${idx}: ${why}`;
    if (btmgmtRefusalAnnounced) {
      bleLog.debug(line);
    } else {
      btmgmtRefusalAnnounced = true;
      bleLog.info(
        `${line}. The adapter resets need btmgmt installed and allowed CAP_NET_ADMIN ` +
          '(sudo setcap cap_net_admin+ep $(which btmgmt)); continuing without them.',
      );
    }
    return false;
  };

  const off = await run(['--index', idx, 'power', 'off']);
  const offError = off.failure ?? btmgmtErrorLine(off.out);
  // The state decides, not the printed result: an adapter that was already
  // off still has to be powered on. Only an unreadable `info` leaves the
  // printed result as the evidence.
  const poweredAfterOff = await poweredNow();
  if (poweredAfterOff === true || (poweredAfterOff === undefined && offError)) {
    return refused(offError ?? 'the adapter is still powered after power off');
  }
  bleLog.debug('btmgmt: adapter powered off');
  await sleep(500);
  const on = await run(['--index', idx, 'power', 'on']);
  await sleep(2000);
  const onError = on.failure ?? btmgmtErrorLine(on.out);
  const poweredAfterOn = await poweredNow();
  if (poweredAfterOn === false || (poweredAfterOn === undefined && onError)) {
    bleLog.warn(
      `btmgmt power on for hci${idx} did not take (${onError ?? 'the adapter reports not powered'}).`,
    );
    return false;
  }
  bleLog.debug('btmgmt: adapter powered on');
  return true;
}

/** Reset Bluetooth adapter via rfkill (RF-level block/unblock). */
export async function resetAdapterRfkill(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('rfkill', ['block', 'bluetooth'], { timeout: 5000 });
    bleLog.debug('rfkill: bluetooth blocked');
    await sleep(1000);
    await run('rfkill', ['unblock', 'bluetooth'], { timeout: 5000 });
    bleLog.debug('rfkill: bluetooth unblocked');
    await sleep(3000);
    return true;
  } catch (err) {
    bleLog.debug(`rfkill reset failed: ${errMsg(err)}`);
    return false;
  }
}

/** Restart the bluetoothd service via systemctl (nuclear option). */
export async function restartBluetoothd(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('systemctl', ['restart', 'bluetooth'], { timeout: 15_000 });
    bleLog.debug('bluetoothd service restarted');
    await sleep(3000);
    return true;
  } catch (err) {
    bleLog.debug(`bluetoothd restart failed: ${errMsg(err)}`);
    return false;
  }
}
