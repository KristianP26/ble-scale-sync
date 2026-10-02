import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthLogExporter } from '../../src/exporters/healthlog.js';
import type { HealthLogConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

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

const config: HealthLogConfig = {
  baseUrl: 'https://healthlog.example',
  token: 'tok-1',
  syncMeasurements: true,
};

const BASE = 'https://healthlog.example';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function res(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const status = opts.status ?? 200;
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function calls(method: string, suffix: string) {
  return mockFetch.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === method && (url as string).endsWith(suffix),
  );
}

describe('HealthLogExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(res({ success: true }, { status: 200 }));
  });

  it('has name "healthlog" and supports back-dating', () => {
    const e = new HealthLogExporter(config);
    expect(e.name).toBe('healthlog');
    expect(e.supportsBackdate).toBe(true);
  });

  it('POSTs a metrics entry with the Token header and date', async () => {
    const timestamp = new Date(2024, 2, 14, 9, 0);
    await new HealthLogExporter(config).export(sample, { timestamp });

    const weightCalls = calls('POST', '/measurements');
    expect(weightCalls).toHaveLength(6);
    expect(weightCalls[0][0]).toBe(`${BASE}/api/measurements`);
    expect(weightCalls[0][1].headers.Authorization).toBe('Bearer tok-1');
    const body = JSON.parse(weightCalls[0][1].body as string);
    expect(body.type).toBe('WEIGHT');
    expect(body.value).toBe(80);
    expect(body.measuredAt).toBe(timestamp.toISOString());
    expect(body).not.toHaveProperty('user');
  });

  it('uses the current local date for a live reading', async () => {
    await new HealthLogExporter(config).export(sample);
    const body = JSON.parse(calls('POST', '/measurements')[0][1].body as string);
    expect(body.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('skips a metric whose value is 0', async () => {
    await new HealthLogExporter(config).export({ ...sample, boneMass: 0 });
    const values = calls('POST', '/measurements').map((c) => JSON.parse(c[1].body as string).value);
    expect(values).not.toContain(0);
    expect(values).toHaveLength(5);
  });

  it('does not touch measurements when syncMeasurements is false', async () => {
    await new HealthLogExporter({ ...config, syncMeasurements: false }).export(sample);

    const postCalls = calls('POST', '/measurements');
    expect(postCalls).toHaveLength(1);

    const body = JSON.parse(postCalls[0][1].body as string);
    expect(body.type).toBe('WEIGHT');
    expect(body.value).toBe(80);
  });

  it('normalizes a trailing slash in the base URL', async () => {
    await new HealthLogExporter({ ...config, baseUrl: 'https://healthlog.example/' }).export(
      sample,
    );
    expect(calls('POST', '/measurements')[0][0]).toBe(`${BASE}/api/measurements`);
  });

  it('fails the export when the weight POST fails', async () => {
    mockFetch.mockResolvedValue(res({ detail: 'err' }, { status: 500 }));

    const result = await new HealthLogExporter({ ...config, syncMeasurements: false }).export(
      sample,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 500');
  });

  it('does not retry a 4xx weight response', async () => {
    mockFetch.mockResolvedValue(res({ detail: 'bad' }, { status: 400 }));
    await new HealthLogExporter({ ...config, syncMeasurements: false }).export(sample);
    expect(calls('POST', '/measurements')).toHaveLength(1);
  });

  it('treats a measurement failure as non-fatal (weight still succeeds)', async () => {
    mockFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};

      if (body.type && body.type !== 'WEIGHT') {
        return res({ detail: 'err' }, { status: 500 });
      }
      return res({ id: 1 }, { status: 201 });
    });

    const result = await new HealthLogExporter(config).export(sample);
    expect(result.success).toBe(true);
  });

  describe('healthcheck()', () => {
    it('returns success on 200 from version', async () => {
      mockFetch.mockResolvedValue(res({ id: 1 }, { status: 200 }));
      const result = await new HealthLogExporter(config).healthcheck();
      expect(result.success).toBe(true);
      const call = mockFetch.mock.calls.find(([url]) => (url as string).endsWith('/version'));
      expect(call).toBeDefined();
      expect(call![1].headers.Authorization).toBe('Bearer tok-1');
    });

    it('returns failure on 401', async () => {
      mockFetch.mockResolvedValue(res({ detail: 'no' }, { status: 401 }));
      const result = await new HealthLogExporter(config).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 401');
    });

    it('returns failure on a network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await new HealthLogExporter(config).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });
});
