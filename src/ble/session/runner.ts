import type { BleDeviceInfo, ScaleAdapter } from '../../interfaces/scale-adapter.js';
import { resolveAfterDiscovery, type GattDiscovery } from '../../scales/resolve.js';
import { tagBleFailure } from '../failure-kind.js';
import {
  type RawReading,
  type SessionRequest,
  waitForRawReading,
  withAbandonmentCleanup,
} from '../shared.js';
import {
  bleLog,
  normalizeUuid,
  RAW_READING_TIMEOUT_MS,
  READING_SESSION_CAP_FACTOR,
  SessionTimeoutError,
  untilAborted,
  withIdleTimeout,
  withTimeout,
} from '../types.js';

/**
 * Idle bound of a session over a proxy. A proxy that vanishes mid-session (Wi-Fi
 * drop, reboot) never sends the disconnect the session waits on.
 */
const PROXY_IDLE_MS = 60_000;
/**
 * Cap of a proxy watcher session. A scale that keeps sending frames the adapter
 * rejects restarts the idle bound forever, and meanwhile the ESP32 holds its one
 * connection and pauses its scan.
 */
export const PROXY_WATCHER_CAP_MS = 90_000;

/**
 * How one GATT reading session is bounded. Each transport path keeps the values
 * it had before they were data (BLE-LAYER.md, "Status ramce a idle timeout");
 * making them the same changes behaviour and is the owner's call.
 */
export interface SessionPolicy {
  idleMs: number;
  idleMessage: string;
  /**
   * Bound on the whole session. `movedByHold`: inside withIdleTimeout, so a
   * composition hold that ends later moves it (#434) and it fails as a
   * SessionTimeoutError; otherwise an outer withTimeout nothing moves.
   */
  cap?: { ms: number; message: string; movedByHold: boolean };
  /** A shutdown ends the session and hands nothing over (D051). */
  abortSignal?: AbortSignal;
  /** A timeout after any frame from the scale is tagged 'no-reading' (D041). */
  tagNoReading?: boolean;
}

/** node-ble, noble and the mqtt-proxy single-shot: `ble.session_timeout_sec`, cap 3 x that. */
export function nativePolicy(idleMs = RAW_READING_TIMEOUT_MS): SessionPolicy {
  return {
    idleMs,
    idleMessage: 'Timed out waiting for a complete scale reading',
    cap: {
      ms: idleMs * READING_SESSION_CAP_FACTOR,
      message: 'GATT session cap exceeded',
      movedByHold: true,
    },
  };
}

/** The proxy watchers: 60 s idle and a 90 s cap; `label` names the session in both errors. */
export function proxyWatcherPolicy(label: string): SessionPolicy {
  return {
    ...proxyScanPolicy(label),
    cap: {
      ms: PROXY_WATCHER_CAP_MS,
      message: `GATT session cap exceeded for ${label}`,
      movedByHold: false,
    },
  };
}

/** The esphome-proxy single-shot: 60 s idle and no cap; the scan has a deadline of its own. */
export function proxyScanPolicy(label: string): SessionPolicy {
  return { idleMs: PROXY_IDLE_MS, idleMessage: `GATT reading timeout for ${label}` };
}

/**
 * Run one GATT reading session under its policy. A timeout or a shutdown goes
 * through withAbandonmentCleanup, so the session ends the way a disconnect ends
 * it, and a timeout hands over what it held (#331, D051).
 */
export async function runGattSession(
  req: Omit<SessionRequest, 'onActivity' | 'onFrame'>,
  policy: SessionPolicy,
): Promise<RawReading> {
  const { cap, abortSignal } = policy;
  // Any frame, status frames included: the scale answered at all (D041, D070).
  let heard = false;
  const onFrame = policy.tagNoReading ? () => void (heard = true) : undefined;
  try {
    return await withAbandonmentCleanup(
      req.device,
      () => {
        const session = withIdleTimeout(
          (onActivity) => waitForRawReading({ ...req, onActivity, onFrame }),
          policy.idleMs,
          policy.idleMessage,
          cap?.movedByHold ? cap : undefined,
        );
        const capped =
          cap && !cap.movedByHold ? withTimeout(session, cap.ms, cap.message) : session;
        return untilAborted(capped, abortSignal);
      },
      abortSignal,
    );
  } catch (err) {
    // Only our own timeout; an abort, a disconnect or a GATT error keeps its kind.
    if (heard && err instanceof SessionTimeoutError) tagBleFailure(err, 'no-reading');
    throw err;
  }
}

/**
 * The adapter that drives a session once GATT discovery is done, by the rule
 * every transport shares (D031). `advertisedPick`, the adapter the
 * advertisement chose, is the fallback, and a change from it is logged.
 * `byNotifyChar`: a device nothing matches goes to the highest-priority adapter
 * whose notify characteristic it has (mqtt-proxy autonomous connect, #258).
 */
export function selectSessionAdapter(
  advertised: BleDeviceInfo,
  discovery: GattDiscovery,
  adapters: readonly ScaleAdapter[],
  how: { advertisedPick?: ScaleAdapter; address?: string; byNotifyChar?: boolean } = {},
): ScaleAdapter | undefined {
  const pick = how.advertisedPick;
  const found =
    resolveAfterDiscovery(advertised, discovery, adapters) ??
    (how.byNotifyChar ? byNotifyChar(discovery.characteristicUuids, adapters) : undefined);
  if (!found || !pick) return found ?? pick;
  if (found.name !== pick.name) {
    bleLog.info(
      `Re-resolved adapter after GATT discovery: ${pick.name} -> ${found.name} (${how.address})`,
    );
  }
  return found;
}

function byNotifyChar(
  chars: readonly string[],
  adapters: readonly ScaleAdapter[],
): ScaleAdapter | undefined {
  const have = new Set(chars.map(normalizeUuid));
  // A stable sort keeps the registry order for ties.
  return [...adapters]
    .sort((a, b) => (b.match?.priority ?? 0) - (a.match?.priority ?? 0))
    .find((a) => !!a.charNotifyUuid && have.has(normalizeUuid(a.charNotifyUuid)));
}
