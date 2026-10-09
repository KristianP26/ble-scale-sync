import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WgerExporter } from '../../src/exporters/wger.js';
import type { WgerConfig } from '../../src/exporters/config.js';
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

const config: WgerConfig = {
  baseUrl: 'https://wger.example',
  token: 'tok-1',
  syncMeasurements: true,
};

const BASE = 'https://wger.example/api/v2';

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

/** A UUID like the ones wger (2.6+) uses as ids, distinct per n. */
function uuid(n: number): string {
  return `0199a3c4-5d6e-7f80-9a1b-${String(n).padStart(12, '0')}`;
}

/** Default happy-path router: configurable category list, category creation, then 201s. */
function routeHappy(existing: Array<{ id: string | number; name: string; unit: string }> = []) {
  let nextId = 100;
  mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/measurement-category/') && method === 'GET') {
      return Promise.resolve(res({ count: existing.length, next: null, results: existing }));
    }
    if (url.endsWith('/measurement-category/') && method === 'POST') {
      return Promise.resolve(res({ id: uuid(nextId++), name: 'x', unit: 'x' }, { status: 201 }));
    }
    if (url.endsWith('/measurement/') && method === 'POST') {
      return Promise.resolve(res({ id: 1 }, { status: 201 }));
    }
    if (url.endsWith('/weightentry/') && method === 'POST') {
      return Promise.resolve(res({ id: 1 }, { status: 201 }));
    }
    return Promise.resolve(res({}, { status: 200 }));
  });
}

function calls(method: string, suffix: string) {
  return mockFetch.mock.calls.filter(
    ([url, init]) => (init?.method ?? 'GET') === method && (url as string).endsWith(suffix),
  );
}

describe('WgerExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeHappy();
  });

  it('has name "wger" and supports back-dating', () => {
    const e = new WgerExporter(config);
    expect(e.name).toBe('wger');
    expect(e.supportsBackdate).toBe(true);
  });

  it('POSTs a weight entry with the Token header and date+weight body', async () => {
    await new WgerExporter(config).export(sample, { timestamp: new Date(2024, 2, 14, 9, 0) });

    const weightCalls = calls('POST', '/weightentry/');
    expect(weightCalls).toHaveLength(1);
    expect(weightCalls[0][0]).toBe(`${BASE}/weightentry/`);
    expect(weightCalls[0][1].headers.Authorization).toBe('Token tok-1');
    const body = JSON.parse(weightCalls[0][1].body as string);
    expect(body.weight).toBe(80);
    expect(body.date).toBe('2024-03-14');
    expect(body).not.toHaveProperty('user');
  });

  it('uses the current local date for a live reading', async () => {
    await new WgerExporter(config).export(sample);
    const body = JSON.parse(calls('POST', '/weightentry/')[0][1].body as string);
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('auto-creates missing categories then posts a measurement per metric', async () => {
    await new WgerExporter(config).export(sample);

    // 4 categories created (fat, water, muscle, bone) and 4 measurements posted.
    expect(calls('POST', '/measurement-category/')).toHaveLength(4);
    const measurements = calls('POST', '/measurement/');
    expect(measurements).toHaveLength(4);
    const fat = measurements
      .map((c) => JSON.parse(c[1].body as string))
      .find((b) => b.value === 18.5);
    expect(fat).toBeDefined();
    // Body Fat is the first category created
    expect(fat.category).toBe(uuid(100));
    expect(fat.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reuses an existing category id and does not recreate it', async () => {
    routeHappy([{ id: uuid(7), name: 'Body Fat', unit: '%' }]);
    await new WgerExporter(config).export(sample);

    // Only the 3 missing categories are created (Body Fat already exists).
    expect(calls('POST', '/measurement-category/')).toHaveLength(3);
    const fat = calls('POST', '/measurement/')
      .map((c) => JSON.parse(c[1].body as string))
      .find((b) => b.value === 18.5);
    expect(fat.category).toBe(uuid(7));
  });

  it('passes the integer category id of a wger older than 2.6 back unchanged', async () => {
    routeHappy([{ id: 7, name: 'Body Fat', unit: '%' }]);
    await new WgerExporter(config).export(sample);

    const fat = calls('POST', '/measurement/')
      .map((c) => JSON.parse(c[1].body as string))
      .find((b) => b.value === 18.5);
    expect(fat.category).toBe(7);
  });

  it('skips a metric whose value is 0', async () => {
    await new WgerExporter(config).export({ ...sample, boneMass: 0 });
    const values = calls('POST', '/measurement/').map((c) => JSON.parse(c[1].body as string).value);
    expect(values).not.toContain(0);
    expect(values).toHaveLength(3);
  });

  it('caches categories across exports (lists only once)', async () => {
    const e = new WgerExporter(config);
    await e.export(sample);
    await e.export(sample);
    expect(calls('GET', '/measurement-category/')).toHaveLength(1);
  });

  it('does not touch measurements when syncMeasurements is false', async () => {
    await new WgerExporter({ ...config, syncMeasurements: false }).export(sample);
    expect(calls('POST', '/weightentry/')).toHaveLength(1);
    expect(calls('GET', '/measurement-category/')).toHaveLength(0);
    expect(calls('POST', '/measurement/')).toHaveLength(0);
  });

  it('normalizes a trailing slash in the base URL', async () => {
    await new WgerExporter({ ...config, baseUrl: 'https://wger.example/' }).export(sample);
    expect(calls('POST', '/weightentry/')[0][0]).toBe(`${BASE}/weightentry/`);
  });

  it('fails the export when the weight POST fails', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        (url as string).endsWith('/weightentry/')
          ? res({ detail: 'err' }, { status: 500 })
          : res({ count: 0, next: null, results: [] }),
      ),
    );
    const result = await new WgerExporter({ ...config, syncMeasurements: false }).export(sample);
    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 500');
  });

  it('does not retry a 4xx weight response', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        (url as string).endsWith('/userprofile/')
          ? res({ weight_unit: 'kg' })
          : res({ detail: 'bad' }, { status: 400 }),
      ),
    );
    await new WgerExporter({ ...config, syncMeasurements: false }).export(sample);
    expect(calls('POST', '/weightentry/')).toHaveLength(1);
  });

  it('treats a measurement failure as non-fatal (weight still succeeds)', async () => {
    mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if ((url as string).endsWith('/measurement/') && method === 'POST') {
        return Promise.resolve(res({ detail: 'err' }, { status: 500 }));
      }
      if ((url as string).endsWith('/measurement-category/') && method === 'GET') {
        return Promise.resolve(res({ count: 0, next: null, results: [] }));
      }
      return Promise.resolve(res({ id: 1 }, { status: 201 }));
    });
    const result = await new WgerExporter(config).export(sample);
    expect(result.success).toBe(true);
  });

  // F-03: wger stores a weight entry in the unit of the user's profile, and
  // the API takes no unit. Kilograms written to a pound profile were stored
  // as pounds, 2.2 times too light.
  describe('profile weight unit (F-03)', () => {
    function routeProfile(profile: unknown, status = 200) {
      const happy = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation((url: string, init?: { method?: string }) =>
        (url as string).endsWith('/userprofile/') && (init?.method ?? 'GET') === 'GET'
          ? Promise.resolve(res(profile, { status }))
          : happy(url, init),
      );
    }
    const weightSent = () =>
      JSON.parse(calls('POST', '/weightentry/')[0][1].body as string).weight as number;

    it('writes pounds to an account whose profile is in pounds', async () => {
      routeProfile({ username: 'a', weight_unit: 'lb' });
      const result = await new WgerExporter(config).export(sample);
      expect(result.success).toBe(true);
      expect(weightSent()).toBe(176.37);
    });

    it('writes kilograms to an account whose profile is in kilograms', async () => {
      routeProfile({ username: 'a', weight_unit: 'kg' });
      await new WgerExporter(config).export(sample);
      expect(weightSent()).toBe(80);
    });

    it('reads the profile on every export, so a changed unit is followed', async () => {
      const e = new WgerExporter({ ...config, syncMeasurements: false });
      routeProfile({ weight_unit: 'kg' });
      await e.export(sample);
      routeProfile({ weight_unit: 'lb' });
      await e.export(sample);
      const sent = calls('POST', '/weightentry/').map(
        (c) => JSON.parse(c[1].body as string).weight,
      );
      expect(sent).toEqual([80, 176.37]);
    });

    it('does not write a weight it cannot put in the right unit', async () => {
      routeProfile({ detail: 'no' }, 401);
      const result = await new WgerExporter(config).export(sample);
      expect(result.success).toBe(false);
      expect(calls('POST', '/weightentry/')).toHaveLength(0);
    });

    it('refuses a unit it does not know instead of guessing', async () => {
      routeProfile({ weight_unit: 'st' });
      const result = await new WgerExporter(config).export(sample);
      expect(result.success).toBe(false);
      expect(result.error).toContain("'st'");
      expect(calls('POST', '/weightentry/')).toHaveLength(0);
    });
  });

  describe('healthcheck()', () => {
    it('returns success on 200 from userprofile', async () => {
      mockFetch.mockResolvedValue(res({ id: 1 }, { status: 200 }));
      const result = await new WgerExporter(config).healthcheck();
      expect(result.success).toBe(true);
      const call = mockFetch.mock.calls.find(([url]) => (url as string).endsWith('/userprofile/'));
      expect(call).toBeDefined();
      expect(call![1].headers.Authorization).toBe('Token tok-1');
    });

    it('returns failure on 401', async () => {
      mockFetch.mockResolvedValue(res({ detail: 'no' }, { status: 401 }));
      const result = await new WgerExporter(config).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 401');
    });

    it('returns failure on a network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await new WgerExporter(config).healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });
});
