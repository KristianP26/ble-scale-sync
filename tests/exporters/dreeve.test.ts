import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DreeveExporter } from '../../src/exporters/dreeve.js';
import type { DreeveConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';
import type { ExportContext } from '../../src/interfaces/exporter.js';

const sample: BodyComposition = {
  weight: 80,
  impedance: 500,
  bmi: 23.9,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 62.4,
  visceralFat: 8,
  physiqueRating: 5,
  bmr: 1750,
  metabolicAge: 30,
};

const config: DreeveConfig = {
  baseUrl: 'https://fit.example.com',
  token: 'drv_abc123',
  unitSystem: 'metric',
};

const weightsUrl = 'https://fit.example.com/api/v1/athlete/weights';
const statusUrl = 'https://fit.example.com/api/v1/status';
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function bodyOfCall(index = 0): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[index][1].body as string);
}

describe('DreeveExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('has name "dreeve" and supports back-dating', () => {
    const exporter = new DreeveExporter(config);
    expect(exporter.name).toBe('dreeve');
    expect(exporter.supportsBackdate).toBe(true);
  });

  it('POSTs a metric weight with bearer auth and a local calendar date', async () => {
    const context: ExportContext = { timestamp: new Date(2024, 2, 14, 9, 0) };
    await new DreeveExporter(config).export(sample, context);

    expect(mockFetch).toHaveBeenCalledWith(
      weightsUrl,
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer drv_abc123',
          'Content-Type': 'application/json',
        },
      }),
    );
    expect(bodyOfCall()).toEqual({ on: '2024-03-14', weight: 80 });
  });

  it('converts kilograms to pounds for an Imperial Dreeve instance', async () => {
    await new DreeveExporter({ ...config, unitSystem: 'imperial' }).export(sample);

    expect(bodyOfCall().weight).toBe(176.37);
  });

  it('normalizes a trailing slash in the base URL', async () => {
    await new DreeveExporter({ ...config, baseUrl: 'https://fit.example.com/' }).export(sample);

    expect(mockFetch.mock.calls[0][0]).toBe(weightsUrl);
  });

  it('returns a failure without retrying a 4xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });

    const result = await new DreeveExporter(config).export(sample);

    expect(result).toEqual({ success: false, error: 'HTTP 401' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await new DreeveExporter(config).export(sample);

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('healthchecks the status endpoint with bearer auth', async () => {
    const result = await new DreeveExporter(config).healthcheck();

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith(
      statusUrl,
      expect.objectContaining({ headers: { Authorization: 'Bearer drv_abc123' } }),
    );
  });
});
