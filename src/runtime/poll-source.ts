import type { RawReading } from '../ble/shared.js';
import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { scanAndReadRaw } from '../ble/index.js';
import { withTimeout, POLL_CYCLE_TIMEOUT_MS } from '../ble/types.js';
import { resolveUserProfile } from '../config/resolve.js';
import { fmtWeight } from './format.js';
import type { AppContext } from './context.js';
import type { ReadingSource } from './loop.js';

/**
 * Wraps `scanAndReadRaw` as a `ReadingSource`. Stateless: hot-swap fields
 * (scaleMac, weightUnit, mqttProxy, ...) take effect on the next cycle.
 */
export class PollReadingSource implements ReadingSource {
  constructor(
    private readonly ctx: AppContext,
    private readonly adapters: ScaleAdapter[],
  ) {}

  async nextReading(signal: AbortSignal): Promise<RawReading> {
    const primaryUser = this.ctx.config.users[0];
    const profile = resolveUserProfile(primaryUser, this.ctx.config.scale);

    // Hard deadline on the whole cycle. dbus-next never rejects an in-flight
    // MessageBus.call() when the socket dies, so a broken transport would park
    // here forever while the heartbeat kept ticking and the consecutive-failure
    // watchdog was never reached (#290). withTimeout races via Promise.race, so
    // an abandoned scan stays parked; that is acceptable because the next
    // getAdapter() destroys the connection under it and the watchdog bounds the
    // process lifetime. Only the native poll path is wrapped: the proxy watchers
    // wait indefinitely for a weigh-in by design.
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
      abortSignal: signal,
      bleHandler: this.ctx.bleHandler,
      mqttProxy: this.ctx.mqttProxy,
      esphomeProxy: this.ctx.esphomeProxy,
      haBluetooth: this.ctx.haBluetooth,
      bleAdapter: this.ctx.bleAdapter,
      readingTimeoutMs: this.ctx.config.ble?.session_timeout_sec
        ? this.ctx.config.ble.session_timeout_sec * 1000
        : undefined,
      autoClearStaleBond: this.ctx.config.ble?.auto_clear_stale_bond === true,
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

    return withTimeout(
      scan,
      POLL_CYCLE_TIMEOUT_MS,
      `Scan cycle exceeded ${POLL_CYCLE_TIMEOUT_MS / 1000}s and was abandoned (transport wedge?)`,
    );
  }
}
