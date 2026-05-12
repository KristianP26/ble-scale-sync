import type { RawReading } from '../ble/shared.js';
import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { scanAndReadRaw } from '../ble/index.js';
import { resolveForSingleUser, resolveUserProfile } from '../config/resolve.js';
import { fmtWeight } from './format.js';
import type { AppContext } from './context.js';
import type { ReadingSource } from './loop.js';

/**
 * Wraps `scanAndReadRaw` as a `ReadingSource`. Each call performs one full
 * scan-and-read cycle (one-shot). No `start` / `stop` / `updateConfig` needed
 * because the underlying handler is stateless and reads context fresh on every
 * invocation, so hot-swap fields (scaleMac, weightUnit, mqttProxy, etc.) take
 * effect on the next cycle automatically.
 */
export class PollReadingSource implements ReadingSource {
  constructor(
    private readonly ctx: AppContext,
    private readonly adapters: ScaleAdapter[],
  ) {}

  async nextReading(signal: AbortSignal): Promise<RawReading> {
    const profile =
      this.ctx.config.users.length > 1
        ? resolveUserProfile(this.ctx.config.users[0], this.ctx.config.scale)
        : resolveForSingleUser(this.ctx.config).profile;

    return scanAndReadRaw({
      targetMac: this.ctx.scaleMac,
      adapters: this.adapters,
      profile,
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
