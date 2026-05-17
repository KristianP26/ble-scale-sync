import type { RawReading } from '../ble/shared.js';
import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { scanAndReadRaw } from '../ble/index.js';
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

    return scanAndReadRaw({
      targetMac: this.ctx.scaleMac,
      adapters: this.adapters,
      profile,
      scaleAuth: {
        pin: primaryUser.beurer_pin,
        userIndex: primaryUser.beurer_user_index,
      },
      weightUnit: this.ctx.weightUnit,
      abortSignal: signal,
      bleHandler: this.ctx.bleHandler,
      mqttProxy: this.ctx.mqttProxy,
      esphomeProxy: this.ctx.esphomeProxy,
      bleAdapter: this.ctx.bleAdapter,
      onLiveData: (reading) => {
        const impStr: string = reading.impedance > 0 ? `${reading.impedance} Ohm` : 'Measuring...';
        process.stdout.write(
          `\r  Weight: ${fmtWeight(reading.weight, this.ctx.weightUnit)} | Impedance: ${impStr}      `,
        );
      },
    });
  }
}
