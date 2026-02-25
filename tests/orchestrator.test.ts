import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHealthchecks, dispatchExports } from '../src/orchestrator.js';
import type { Exporter, ExportResult } from '../src/interfaces/exporter.js';
import type { BodyComposition } from '../src/interfaces/scale-adapter.js';

const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  consoleSpy.mockClear();
});

const SAMPLE_PAYLOAD: BodyComposition = {
  weight: 75.5,
  impedance: 500,
  bmi: 22.5,
  bodyFatPercent: 18.2,
  waterPercent: 55.1,
  boneMass: 3.1,
  muscleMass: 58.4,
  visceralFat: 5,
  physiqueRating: 5,
  bmr: 1650,
  metabolicAge: 28,
};

function mockExporter(
  name: string,
  exportResult: ExportResult | Error = { success: true },
  healthcheckResult?: ExportResult | Error,
): Exporter {
  const exporter: Exporter = {
    name,
    export: vi.fn<() => Promise<ExportResult>>().mockImplementation(async () => {
      if (exportResult instanceof Error) throw exportResult;
      return exportResult;
    }),
  };
  if (healthcheckResult !== undefined) {
    exporter.healthcheck = vi.fn<() => Promise<ExportResult>>().mockImplementation(async () => {
      if (healthcheckResult instanceof Error) throw healthcheckResult;
      return healthcheckResult;
    });
  }
  return exporter;
}

// ─── runHealthchecks ────────────────────────────────────────────────────────

describe('runHealthchecks()', () => {
  it('does nothing when no exporters have healthcheck', async () => {
    const e1 = mockExporter('garmin'); // no healthcheck
    await runHealthchecks([e1]);
    // No error — just returns
  });

  it('runs healthchecks on exporters that support them', async () => {
    const e1 = mockExporter('mqtt', { success: true }, { success: true });
    const e2 = mockExporter('webhook', { success: true }, { success: true });
    await runHealthchecks([e1, e2]);
    expect(e1.healthcheck).toHaveBeenCalledOnce();
    expect(e2.healthcheck).toHaveBeenCalledOnce();
  });

  it('skips exporters without healthcheck', async () => {
    const e1 = mockExporter('garmin'); // no healthcheck
    const e2 = mockExporter('mqtt', { success: true }, { success: true });
    await runHealthchecks([e1, e2]);
    expect(e2.healthcheck).toHaveBeenCalledOnce();
  });

  it('logs warning on healthcheck failure (returned error)', async () => {
    const e1 = mockExporter('mqtt', { success: true }, { success: false, error: 'timeout' });
    await runHealthchecks([e1]);
    expect(e1.healthcheck).toHaveBeenCalledOnce();
    // Should not throw — healthcheck failures are non-fatal
  });

  it('logs warning on healthcheck exception', async () => {
    const e1 = mockExporter('mqtt', { success: true }, new Error('connection refused'));
    await runHealthchecks([e1]);
    expect(e1.healthcheck).toHaveBeenCalledOnce();
  });

  it('runs healthchecks in parallel', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeSlowHealthcheck = (name: string): Exporter => ({
      name,
      export: vi.fn(async () => ({ success: true })),
      healthcheck: vi.fn(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
        return { success: true };
      }),
    });

    await runHealthchecks([makeSlowHealthcheck('a'), makeSlowHealthcheck('b')]);
    expect(maxConcurrent).toBe(2);
  });
});

// ─── dispatchExports ────────────────────────────────────────────────────────

describe('dispatchExports()', () => {
  it('returns success true with details when all exports succeed', async () => {
    const e1 = mockExporter('garmin');
    const e2 = mockExporter('mqtt');
    const result = await dispatchExports([e1, e2], SAMPLE_PAYLOAD);
    expect(result.success).toBe(true);
    expect(result.details).toEqual([
      { name: 'garmin', ok: true },
      { name: 'mqtt', ok: true },
    ]);
    expect(e1.export).toHaveBeenCalledWith(SAMPLE_PAYLOAD);
    expect(e2.export).toHaveBeenCalledWith(SAMPLE_PAYLOAD);
  });

  it('returns success true when at least one export succeeds (partial failure)', async () => {
    const e1 = mockExporter('garmin', { success: false, error: 'auth failed' });
    const e2 = mockExporter('mqtt');
    const result = await dispatchExports([e1, e2], SAMPLE_PAYLOAD);
    expect(result.success).toBe(true);
    expect(result.details).toEqual([
      { name: 'garmin', ok: false, error: 'auth failed' },
      { name: 'mqtt', ok: true },
    ]);
  });

  it('returns success false when all exports fail (returned error)', async () => {
    const e1 = mockExporter('garmin', { success: false, error: 'auth failed' });
    const e2 = mockExporter('mqtt', { success: false, error: 'timeout' });
    const result = await dispatchExports([e1, e2], SAMPLE_PAYLOAD);
    expect(result.success).toBe(false);
    expect(result.details).toHaveLength(2);
    expect(result.details[0]).toEqual({ name: 'garmin', ok: false, error: 'auth failed' });
    expect(result.details[1]).toEqual({ name: 'mqtt', ok: false, error: 'timeout' });
  });

  it('returns success false when all exports throw', async () => {
    const e1 = mockExporter('garmin', new Error('crash'));
    const e2 = mockExporter('mqtt', new Error('boom'));
    const result = await dispatchExports([e1, e2], SAMPLE_PAYLOAD);
    expect(result.success).toBe(false);
    expect(result.details).toEqual([
      { name: 'garmin', ok: false, error: 'crash' },
      { name: 'mqtt', ok: false, error: 'boom' },
    ]);
  });

  it('returns success true with mixed: one succeeds, one throws, one returns error', async () => {
    const e1 = mockExporter('garmin', new Error('crash'));
    const e2 = mockExporter('mqtt');
    const e3 = mockExporter('webhook', { success: false, error: 'HTTP 500' });
    const result = await dispatchExports([e1, e2, e3], SAMPLE_PAYLOAD);
    expect(result.success).toBe(true);
    expect(result.details).toEqual([
      { name: 'garmin', ok: false, error: 'crash' },
      { name: 'mqtt', ok: true },
      { name: 'webhook', ok: false, error: 'HTTP 500' },
    ]);
  });

  it('returns success true with single successful exporter', async () => {
    const e1 = mockExporter('garmin');
    const result = await dispatchExports([e1], SAMPLE_PAYLOAD);
    expect(result.success).toBe(true);
    expect(result.details).toEqual([{ name: 'garmin', ok: true }]);
    expect(e1.export).toHaveBeenCalledOnce();
  });

  it('returns success false with single failing exporter', async () => {
    const e1 = mockExporter('garmin', { success: false, error: 'fail' });
    const result = await dispatchExports([e1], SAMPLE_PAYLOAD);
    expect(result.success).toBe(false);
    expect(result.details).toEqual([{ name: 'garmin', ok: false, error: 'fail' }]);
  });

  it('runs exports in parallel', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeSlowExporter = (name: string): Exporter => ({
      name,
      export: vi.fn(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
        return { success: true };
      }),
    });

    await dispatchExports([makeSlowExporter('a'), makeSlowExporter('b')], SAMPLE_PAYLOAD);
    expect(maxConcurrent).toBe(2);
  });

  it('passes full BodyComposition payload to each exporter', async () => {
    const e1 = mockExporter('garmin');
    await dispatchExports([e1], SAMPLE_PAYLOAD);
    expect(e1.export).toHaveBeenCalledWith(SAMPLE_PAYLOAD);
    const arg = vi.mocked(e1.export).mock.calls[0][0];
    expect(arg).toHaveProperty('weight', 75.5);
    expect(arg).toHaveProperty('impedance', 500);
    expect(arg).toHaveProperty('metabolicAge', 28);
  });
});
