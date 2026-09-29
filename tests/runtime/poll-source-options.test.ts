import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * How PollReadingSource turns config into ScanOptions. `ble.preemptive_adapter_reset`
 * (#417) defaults ON, so only an explicit false may reach the handler as false;
 * a null or missing key must not quietly switch the #80 power-cycle off.
 */

const scanAndReadRaw = vi.fn();
vi.mock('../../src/ble/index.js', () => ({ scanAndReadRaw }));

// Profile resolution is not the subject here, same as poll-cycle-deadline.test.ts.
vi.mock('../../src/config/resolve.js', () => ({
  resolveUserProfile: () => ({ sex: 'male', age: 40, heightCm: 180, athlete: false }),
}));

const { PollReadingSource } = await import('../../src/runtime/poll-source.js');

type Ctx = ConstructorParameters<typeof PollReadingSource>[0];

function makeCtx(ble: Record<string, unknown> | undefined): Ctx {
  return {
    config: {
      users: [{ beurer_pin: undefined, beurer_user_index: undefined }],
      scale: {},
      ble,
    },
    scaleMac: undefined,
    weightUnit: 'kg',
    bleHandler: 'node-ble',
    mqttProxy: undefined,
    esphomeProxy: undefined,
    bleAdapter: undefined,
  } as unknown as Ctx;
}

async function optionsFor(ctx: Ctx): Promise<Record<string, unknown>> {
  scanAndReadRaw.mockClear();
  await new PollReadingSource(ctx, []).nextReading(new AbortController().signal);
  return scanAndReadRaw.mock.calls[0][0] as Record<string, unknown>;
}

describe('PollReadingSource ble.preemptive_adapter_reset (#417)', () => {
  beforeEach(() => {
    scanAndReadRaw.mockReset();
    scanAndReadRaw.mockResolvedValue({ weight: 80, impedance: 500 });
  });

  it.each([
    ['no ble block', true, undefined],
    ['the key omitted', true, {}],
    ['null', true, { preemptive_adapter_reset: null }],
    ['true', true, { preemptive_adapter_reset: true }],
    ['false', false, { preemptive_adapter_reset: false }],
  ])('maps %s to preemptiveAdapterReset: %s', async (_label, expected, ble) => {
    const opts = await optionsFor(makeCtx(ble));
    expect(opts.preemptiveAdapterReset).toBe(expected);
  });

  it('re-reads the option on every cycle, so a config reload lands without a restart', async () => {
    const ctx = makeCtx({ preemptive_adapter_reset: true });
    const source = new PollReadingSource(ctx, []);

    await source.nextReading(new AbortController().signal);
    (ctx as { config: { ble?: Record<string, unknown> } }).config.ble = {
      preemptive_adapter_reset: false,
    };
    await source.nextReading(new AbortController().signal);

    expect(scanAndReadRaw.mock.calls[0][0].preemptiveAdapterReset).toBe(true);
    expect(scanAndReadRaw.mock.calls[1][0].preemptiveAdapterReset).toBe(false);
  });
});
