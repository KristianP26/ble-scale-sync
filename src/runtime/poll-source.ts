import type { RawReading } from '../ble/shared.js';
import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { scanAndReadRaw, releaseTransport } from '../ble/index.js';
import { POLL_CYCLE_TIMEOUT_MS } from '../ble/types.js';
import { resolveUserProfile } from '../config/resolve.js';
import { fmtWeight } from './format.js';
import type { AppContext } from './context.js';
import type { ReadingSource } from './loop.js';

/**
 * Wraps `scanAndReadRaw` as a `ReadingSource`. Stateless: hot-swap fields
 * (scaleMac, weightUnit, mqttProxy, ...) take effect on the next cycle. The
 * handler's own connection state lives in the handler and is released by
 * stop().
 */
export class PollReadingSource implements ReadingSource {
  constructor(
    private readonly ctx: AppContext,
    private readonly adapters: ScaleAdapter[],
  ) {}

  /**
   * Called by the loop on its way out. Without it a shutdown during an idle
   * cycle (the usual state) left node-ble's D-Bus socket open, and the process
   * ended through the force-exit timer rather than by draining (A-02).
   */
  async stop(): Promise<void> {
    await releaseTransport(this.ctx.bleHandler);
  }

  async nextReading(signal: AbortSignal): Promise<RawReading> {
    const primaryUser = this.ctx.config.users[0];
    const profile = resolveUserProfile(primaryUser, this.ctx.config.scale);

    // Hard deadline on the whole cycle. dbus-next never rejects an in-flight
    // MessageBus.call() by itself when the socket dies, so a broken transport
    // would park here forever while the heartbeat kept ticking and the
    // consecutive-failure watchdog was never reached (#290). connection.ts now
    // fails the parked calls when the bus closes the socket (A-03); this
    // deadline still covers a call the daemon simply never answers. Only the
    // native poll path is wrapped: the proxy watchers wait indefinitely for a
    // weigh-in by design.
    //
    // withTimeout only stops waiting, so the cycle gets an abort of its own and
    // the deadline fires it (A-04). Every stage of the session follows the
    // signal (A-07), so an abandoned cycle stops at its next await instead of
    // retrying connects and making BlueZ calls next to the cycle that replaced
    // it. A call the daemon never answers still parks it; its teardown then
    // stands down once a newer cycle has started. A loop shutdown is forwarded
    // unchanged, and a cycle that finished is never aborted afterwards.
    const cycle = new AbortController();
    const forwardShutdown = (): void => cycle.abort(signal.reason);
    if (signal.aborted) forwardShutdown();
    else signal.addEventListener('abort', forwardShutdown, { once: true });

    const scan = scanAndReadRaw({
      targetMac: this.ctx.scaleMac,
      adapters: this.adapters,
      profile,
      scaleAuth: {
        pin: primaryUser.beurer_pin,
        userIndex: primaryUser.beurer_user_index,
        provision: primaryUser.beurer_provision,
        registerNewUser: primaryUser.beurer_register_new_user,
      },
      weightUnit: this.ctx.weightUnit,
      abortSignal: cycle.signal,
      bleHandler: this.ctx.bleHandler,
      mqttProxy: this.ctx.mqttProxy,
      esphomeProxy: this.ctx.esphomeProxy,
      haBluetooth: this.ctx.haBluetooth,
      bleAdapter: this.ctx.bleAdapter,
      readingTimeoutMs: this.ctx.config.ble?.session_timeout_sec
        ? this.ctx.config.ble.session_timeout_sec * 1000
        : undefined,
      autoClearStaleBond: this.ctx.config.ble?.auto_clear_stale_bond === true,
      // Default on: only an explicit false skips the power-cycle (#417).
      preemptiveAdapterReset: this.ctx.config.ble?.preemptive_adapter_reset !== false,
      onLiveData: (reading) => {
        const impStr: string = reading.impedance > 0 ? `${reading.impedance} Ohm` : 'Measuring...';
        process.stdout.write(
          `\r  Weight: ${fmtWeight(reading.weight, this.ctx.weightUnit)} | Impedance: ${impStr}      `,
        );
      },
      // Settling weights from a broadcast scale, so the console follows the
      // scale's own display while somebody steps on (#356). Labelled as
      // settling rather than shown bare: it is a number the scale has not
      // committed to and it must not read like a result.
      onLiveWeight: (live) => {
        process.stdout.write(
          `\r  Weight: ${fmtWeight(live.weight, this.ctx.weightUnit)} (settling...)      `,
        );
      },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error(
          `Scan cycle exceeded ${POLL_CYCLE_TIMEOUT_MS / 1000}s and was abandoned (transport wedge?)`,
        );
        // Reject first, so the loop sees the deadline and not the abort error
        // the scan settles with afterwards.
        reject(err);
        cycle.abort(err);
      }, POLL_CYCLE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([scan, deadline]);
    } finally {
      clearTimeout(timer);
      // Continuous mode hands every cycle the same loop signal, so a listener
      // left on it per cycle would leak for the life of the process.
      signal.removeEventListener('abort', forwardShutdown);
    }
  }
}
