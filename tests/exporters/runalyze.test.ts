import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunalyzeExporter } from '../../src/exporters/runalyze.js';
import type { RunalyzeConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';
import type { ExportContext } from '../../src/interfaces/exporter.js';

const samplePayload: BodyComposition = {
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

const defaultConfig: RunalyzeConfig = { token: 'tok-abc123' };

const METRIC_URL = 'https://runalyze.com/api/v1/metrics/bodyComposition';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Build a fetch Response stub. */
function res(opts: { ok?: boolean; status?: number; body?: string }) {
  const status = opts.status ?? 200;
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    text: async () => opts.body ?? '',
  };
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[0][1].body as string);
}

describe('RunalyzeExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(res({ ok: true, status: 200 }));
  });

  it('has name "runalyze"', () => {
    expect(new RunalyzeExporter(defaultConfig).name).toBe('runalyze');
  });

  it('supports back-dating', () => {
    expect(new RunalyzeExporter(defaultConfig).supportsBackdate).toBe(true);
  });

  it('POSTs to the bodyComposition metric with the token header', async () => {
    await new RunalyzeExporter(defaultConfig).export(samplePayload);

    expect(mockFetch).toHaveBeenCalledWith(METRIC_URL, expect.objectContaining({ method: 'POST' }));
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.token).toBe('tok-abc123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('maps weight + percentages, converting muscle/bone mass to percent of weight', async () => {
    await new RunalyzeExporter(defaultConfig).export(samplePayload);

    const body = lastBody();
    expect(body.weight).toBe(80);
    expect(body.fat_percentage).toBe(18.5);
    expect(body.water_percentage).toBe(55.2);
    // 62.4 / 80 * 100 = 78.0 ; 3.1 / 80 * 100 = 3.875 -> 3.9
    expect(body.muscle_percentage).toBe(78);
    expect(body.bone_percentage).toBe(3.9);
  });

  it('omits an optional metric when its source value is 0', async () => {
    await new RunalyzeExporter(defaultConfig).export({ ...samplePayload, boneMass: 0 });

    const body = lastBody();
    expect(body).not.toHaveProperty('bone_percentage');
    expect(body.muscle_percentage).toBe(78);
  });

  // #497: withheld values (null) are left out like unmeasured ones.
  it('sends only the weight when the body composition was withheld', async () => {
    await new RunalyzeExporter(defaultConfig).export({
      ...samplePayload,
      bodyFatPercent: null,
      waterPercent: null,
      boneMass: null,
      muscleMass: null,
      visceralFat: null,
      physiqueRating: null,
    });

    expect(Object.keys(lastBody()).sort()).toEqual(['date_time', 'weight']);
  });

  it('uses the current time for a live reading', async () => {
    const before = Date.now();
    await new RunalyzeExporter(defaultConfig).export(samplePayload);
    const after = Date.now();

    const ts = new Date(lastBody().date_time as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('back-dates date_time to context.timestamp for a historical reading', async () => {
    const context: ExportContext = { timestamp: new Date(2024, 2, 14, 9, 0) };
    await new RunalyzeExporter(defaultConfig).export(samplePayload, context);

    expect(lastBody().date_time).toBe(new Date(2024, 2, 14, 9, 0).toISOString());
  });

  it('returns failure on a non-2xx response', async () => {
    mockFetch.mockResolvedValue(res({ ok: false, status: 500 }));
    const result = await new RunalyzeExporter(defaultConfig).export(samplePayload);
    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 500');
  });

  it('does not retry a 4xx response', async () => {
    mockFetch.mockResolvedValue(res({ ok: false, status: 400 }));
    await new RunalyzeExporter(defaultConfig).export(samplePayload);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast (no retry) when an HTTP 200 carries a "No valid token" body', async () => {
    mockFetch.mockResolvedValue(res({ ok: true, status: 200, body: '{"error":"No valid token"}' }));
    const result = await new RunalyzeExporter(defaultConfig).export(samplePayload);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Runalyze rejected the API token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on a network error (3 total attempts)', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const result = await new RunalyzeExporter(defaultConfig).export(samplePayload);
    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on retry after an initial failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(res({ ok: true, status: 200 }));
    const result = await new RunalyzeExporter(defaultConfig).export(samplePayload);
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  describe('healthcheck()', () => {
    it('returns success on 200', async () => {
      mockFetch.mockResolvedValue(res({ ok: true, status: 200 }));
      const result = await new RunalyzeExporter(defaultConfig).healthcheck();
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        METRIC_URL,
        expect.objectContaining({ headers: { token: 'tok-abc123' } }),
      );
      // healthcheck is a read; no POST method
      expect(mockFetch.mock.calls[0][1].method).toBeUndefined();
    });

    it('returns success on 403 (token valid, read gated on a paid tier)', async () => {
      mockFetch.mockResolvedValue(res({ ok: false, status: 403 }));
      const result = await new RunalyzeExporter(defaultConfig).healthcheck();
      expect(result.success).toBe(true);
    });

    it('returns failure on 401', async () => {
      mockFetch.mockResolvedValue(res({ ok: false, status: 401 }));
      const result = await new RunalyzeExporter(defaultConfig).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 401');
    });

    it('returns failure when the body reports an invalid token on a 200', async () => {
      mockFetch.mockResolvedValue(res({ ok: true, status: 200, body: 'No valid token' }));
      const result = await new RunalyzeExporter(defaultConfig).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid token');
    });

    it('returns failure on a network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await new RunalyzeExporter(defaultConfig).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });
});
