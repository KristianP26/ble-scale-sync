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

function postedBodies(): Array<Record<string, unknown>> {
  return calls('POST', '/measurements').map((c) => JSON.parse(c[1].body as string));
}

/** Answer each POST by its `type`, so one metric can be refused while the rest go through. */
function respondByType(statusFor: (type: string) => number) {
  mockFetch.mockImplementation(async (_url: string, init?: { body?: string }) => {
    const type = init?.body ? (JSON.parse(init.body).type as string) : '';
    return res({ id: 1 }, { status: statusFor(type) });
  });
}

describe('HealthLogExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(res({ id: 1 }, { status: 201 }));
  });

  it('has name "healthlog" and supports back-dating', () => {
    const e = new HealthLogExporter(config);
    expect(e.name).toBe('healthlog');
    expect(e.supportsBackdate).toBe(true);
  });

  it('POSTs the weight with the Bearer token and the reading time', async () => {
    const timestamp = new Date(2024, 2, 14, 9, 0);
    await new HealthLogExporter(config).export(sample, { timestamp });

    const posts = calls('POST', '/measurements');
    expect(posts).toHaveLength(6);
    expect(posts[0][0]).toBe(`${BASE}/api/measurements`);
    expect(posts[0][1].headers.Authorization).toBe('Bearer tok-1');
    expect(postedBodies()[0]).toEqual({
      type: 'WEIGHT',
      value: 80,
      measuredAt: timestamp.toISOString(),
    });
  });

  it('sends every metric with its HealthLog type and value', async () => {
    await new HealthLogExporter(config).export(sample);

    expect(postedBodies().map(({ type, value }) => ({ type, value }))).toEqual([
      { type: 'WEIGHT', value: 80 },
      { type: 'BODY_FAT', value: 18.5 },
      // HealthLog stores body water in kg: 80 kg * 55.2 % = 44.16 kg, not 55.2.
      { type: 'TOTAL_BODY_WATER', value: 44.16 },
      { type: 'MUSCLE_MASS', value: 62.4 },
      { type: 'BONE_MASS', value: 3.1 },
      { type: 'VISCERAL_FAT', value: 8 },
    ]);
  });

  it('sends only type, value and measuredAt (no source or unit)', async () => {
    await new HealthLogExporter(config).export(sample);

    // A scoped ingest token is refused with 422 when the body names a source,
    // and HealthLog derives the unit from the type itself.
    for (const body of postedBodies()) {
      expect(Object.keys(body).sort()).toEqual(['measuredAt', 'type', 'value']);
    }
  });

  it('sends the current time as an ISO timestamp for a live reading', async () => {
    await new HealthLogExporter(config).export(sample);
    expect(postedBodies()[0].measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('skips a metric whose value is 0', async () => {
    await new HealthLogExporter(config).export({ ...sample, boneMass: 0 });
    const types = postedBodies().map((b) => b.type);
    expect(types).not.toContain('BONE_MASS');
    expect(types).toHaveLength(5);
  });

  it('skips a visceral fat rating above the 30 HealthLog accepts', async () => {
    await new HealthLogExporter(config).export({ ...sample, visceralFat: 31 });
    const types = postedBodies().map((b) => b.type);
    expect(types).not.toContain('VISCERAL_FAT');
    expect(types).toHaveLength(5);
  });

  it('still sends a visceral fat rating of exactly 30', async () => {
    await new HealthLogExporter(config).export({ ...sample, visceralFat: 30 });
    expect(postedBodies().find((b) => b.type === 'VISCERAL_FAT')?.value).toBe(30);
  });

  it('sends only the weight when syncMeasurements is false', async () => {
    await new HealthLogExporter({ ...config, syncMeasurements: false }).export(sample);
    expect(postedBodies().map(({ type, value }) => ({ type, value }))).toEqual([
      { type: 'WEIGHT', value: 80 },
    ]);
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

  it('treats a 409 on the weight as already recorded, not a failure', async () => {
    respondByType(() => 409);

    const result = await new HealthLogExporter(config).export(sample);
    expect(result.success).toBe(true);
    // The body composition still goes out after a duplicate weight.
    expect(postedBodies().map((b) => b.type)).toEqual([
      'WEIGHT',
      'BODY_FAT',
      'TOTAL_BODY_WATER',
      'MUSCLE_MASS',
      'BONE_MASS',
      'VISCERAL_FAT',
    ]);
  });

  it('treats a 409 on a body-composition metric as already recorded', async () => {
    respondByType((type) => (type === 'BODY_FAT' ? 409 : 201));
    const warn = vi.spyOn(console, 'warn');

    const result = await new HealthLogExporter(config).export(sample);
    expect(result.success).toBe(true);
    expect(postedBodies().filter((b) => b.type === 'BODY_FAT')).toHaveLength(1);
    // A duplicate is not reported as a failed metric.
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/BODY_FAT measurement failed/);
    warn.mockRestore();
  });

  it('treats a body-composition failure as non-fatal (weight still succeeds)', async () => {
    respondByType((type) => (type === 'WEIGHT' ? 201 : 500));

    const result = await new HealthLogExporter(config).export(sample);
    expect(result.success).toBe(true);
  });

  describe('healthcheck()', () => {
    it('probes the public version endpoint without sending the token', async () => {
      mockFetch.mockResolvedValue(res({ version: '1.0.0' }, { status: 200 }));
      const result = await new HealthLogExporter(config).healthcheck();
      expect(result.success).toBe(true);
      const call = mockFetch.mock.calls.find(([url]) => (url as string).endsWith('/version'));
      expect(call![0]).toBe(`${BASE}/api/version`);
      expect(call![1].headers).not.toHaveProperty('Authorization');
    });

    it('returns failure on a server error', async () => {
      mockFetch.mockResolvedValue(res({ detail: 'down' }, { status: 503 }));
      const result = await new HealthLogExporter(config).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 503');
    });

    it('returns failure on a network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await new HealthLogExporter(config).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });
});
