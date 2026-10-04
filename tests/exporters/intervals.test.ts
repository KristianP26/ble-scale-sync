import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntervalsExporter, toLocalDate } from '../../src/exporters/intervals.js';
import type { IntervalsConfig } from '../../src/exporters/config.js';
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

const defaultConfig: IntervalsConfig = {
  athleteId: 'i123456',
  apiKey: 'abcdef123',
};

const expectedAuth = `Basic ${btoa('API_KEY:abcdef123')}`;

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const ATHLETE_URL = 'https://intervals.icu/api/v1/athlete/i123456';

/** fetch calls to the wellness endpoint, leaving out the athlete timezone lookup. */
function wellnessCalls() {
  return mockFetch.mock.calls.filter(([url]) => String(url).includes('/wellness/'));
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(wellnessCalls()[0][1].body as string);
}

describe('toLocalDate()', () => {
  it('formats a date as local YYYY-MM-DD', () => {
    expect(toLocalDate(new Date(2024, 0, 5, 23, 30))).toBe('2024-01-05');
    expect(toLocalDate(new Date(2024, 11, 31, 1, 0))).toBe('2024-12-31');
  });
});

describe('IntervalsExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('has name "intervals"', () => {
    const exporter = new IntervalsExporter(defaultConfig);
    expect(exporter.name).toBe('intervals');
  });

  it('supports back-dating', () => {
    const exporter = new IntervalsExporter(defaultConfig);
    expect(exporter.supportsBackdate).toBe(true);
  });

  it("PUTs to today's wellness record for a live reading", async () => {
    const exporter = new IntervalsExporter(defaultConfig);
    await exporter.export(samplePayload);

    const today = toLocalDate(new Date());
    expect(mockFetch).toHaveBeenCalledWith(
      `https://intervals.icu/api/v1/athlete/i123456/wellness/${today}`,
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('back-dates the URL to context.timestamp for a historical reading', async () => {
    const context: ExportContext = { timestamp: new Date(2024, 2, 14, 9, 0) };
    const exporter = new IntervalsExporter(defaultConfig);
    await exporter.export(samplePayload, context);

    expect(wellnessCalls()[0][0]).toBe(
      'https://intervals.icu/api/v1/athlete/i123456/wellness/2024-03-14',
    );
  });

  it('sends HTTP Basic auth with the literal API_KEY username', async () => {
    const exporter = new IntervalsExporter(defaultConfig);
    await exporter.export(samplePayload);

    const headers = wellnessCalls()[0][1].headers;
    expect(headers.Authorization).toBe(expectedAuth);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends weight and body fat in the JSON body', async () => {
    const exporter = new IntervalsExporter(defaultConfig);
    await exporter.export(samplePayload);

    const body = lastBody();
    expect(body.weight).toBe(80);
    expect(body.bodyFat).toBe(18.5);
  });

  it('returns failure on a non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const exporter = new IntervalsExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 403');
  });

  it('does not retry a 4xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const exporter = new IntervalsExporter(defaultConfig);
    await exporter.export(samplePayload);

    // Bad API key / athlete ID cannot succeed on retry — fail fast.
    expect(wellnessCalls()).toHaveLength(1);
  });

  it('retries on failure (3 total attempts)', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const exporter = new IntervalsExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
    expect(wellnessCalls()).toHaveLength(3);
  });

  it('succeeds on retry after an initial failure', async () => {
    let wellnessAttempts = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/wellness/') && ++wellnessAttempts === 1) throw new Error('temporary');
      return { ok: true, status: 200 };
    });
    const exporter = new IntervalsExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(wellnessCalls()).toHaveLength(2);
  });

  // Intervals.icu keys wellness by the athlete's local day, and defines
  // "today" in the athlete's timezone. The day used to come from the host's
  // clock, and a Docker container without TZ runs in UTC, so a weigh-in at
  // 00:30 in Bratislava (22:30 UTC) overwrote the previous day's weight.
  describe('calendar day in the athlete timezone', () => {
    function athleteTz(timezone: unknown) {
      mockFetch.mockImplementation(async (url: string) =>
        url === ATHLETE_URL
          ? { ok: true, status: 200, json: async () => ({ id: 'i123456', timezone }) }
          : { ok: true, status: 200 },
      );
    }

    // 10:00 UTC is already the next day at UTC+14 and still this day for any
    // host timezone the test machine is likely to run in.
    const at = new Date('2024-03-14T10:00:00Z');

    it('uses the timezone from the athlete profile', async () => {
      athleteTz('Pacific/Kiritimati');
      const exporter = new IntervalsExporter(defaultConfig);
      await exporter.export(samplePayload, { timestamp: at });

      expect(wellnessCalls()[0][0]).toBe(`${ATHLETE_URL}/wellness/2024-03-15`);
    });

    it('looks the timezone up once per exporter', async () => {
      athleteTz('Pacific/Kiritimati');
      const exporter = new IntervalsExporter(defaultConfig);
      await exporter.export(samplePayload, { timestamp: at });
      await exporter.export(samplePayload, { timestamp: at });

      expect(mockFetch.mock.calls.filter(([url]) => url === ATHLETE_URL)).toHaveLength(1);
    });

    it('falls back to the host day for a timezone it does not know', async () => {
      athleteTz('Not/A_Zone');
      const exporter = new IntervalsExporter(defaultConfig);
      await exporter.export(samplePayload, { timestamp: at });

      expect(wellnessCalls()[0][0]).toBe(`${ATHLETE_URL}/wellness/${toLocalDate(at)}`);
    });

    it('falls back to the host day when the profile cannot be read', async () => {
      mockFetch.mockImplementation(async (url: string) =>
        url === ATHLETE_URL ? { ok: false, status: 500 } : { ok: true, status: 200 },
      );
      const exporter = new IntervalsExporter(defaultConfig);
      const result = await exporter.export(samplePayload, { timestamp: at });

      expect(result.success).toBe(true);
      expect(wellnessCalls()[0][0]).toBe(`${ATHLETE_URL}/wellness/${toLocalDate(at)}`);
    });
  });

  describe('healthcheck()', () => {
    it("GETs today's wellness record and returns success on 200", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const exporter = new IntervalsExporter(defaultConfig);
      const result = await exporter.healthcheck();

      expect(result.success).toBe(true);
      const today = toLocalDate(new Date());
      expect(mockFetch).toHaveBeenCalledWith(
        `https://intervals.icu/api/v1/athlete/i123456/wellness/${today}`,
        expect.objectContaining({ headers: { Authorization: expectedAuth } }),
      );
      // healthcheck is a read — no PUT method
      expect(mockFetch.mock.calls[0][1].method).toBeUndefined();
    });

    it('returns failure on a non-2xx response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401 });
      const exporter = new IntervalsExporter(defaultConfig);
      const result = await exporter.healthcheck();

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 401');
    });

    it('returns failure on a network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const exporter = new IntervalsExporter(defaultConfig);
      const result = await exporter.healthcheck();

      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });
});
