import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramExporter } from '../../src/exporters/telegram.js';
import type { TelegramConfig } from '../../src/exporters/config.js';
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

const defaultConfig: TelegramConfig = {
  botToken: '123456:ABC-DEF',
  chatId: '987654321',
  title: 'Scale Measurement',
  silent: false,
  reportExports: false,
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function lastBody(): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[0][1].body as string);
}

describe('TelegramExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('has name "telegram"', () => {
    const exporter = new TelegramExporter(defaultConfig);
    expect(exporter.name).toBe('telegram');
  });

  it('does not support back-dating', () => {
    const exporter = new TelegramExporter(defaultConfig);
    expect(exporter.supportsBackdate).toBeUndefined();
  });

  it('posts to the sendMessage endpoint with the bot token in the path', async () => {
    const exporter = new TelegramExporter(defaultConfig);
    await exporter.export(samplePayload);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:ABC-DEF/sendMessage',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends a JSON body with Content-Type header', async () => {
    const exporter = new TelegramExporter(defaultConfig);
    await exporter.export(samplePayload);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(lastBody().chat_id).toBe('987654321');
  });

  it('formats the message with title and emoji', async () => {
    const exporter = new TelegramExporter({ ...defaultConfig, title: 'My Scale' });
    await exporter.export(samplePayload);

    const text = lastBody().text as string;
    expect(text.startsWith('My Scale\n')).toBe(true);
    expect(text).toContain('⚖️');
    expect(text).toContain('🏋️');
    expect(text).toContain('💧');
    expect(text).toContain('🫀');
    expect(text).toContain('📅');
    expect(text).toContain('80.00 kg');
    expect(text).toContain('BMI 23.9');
    expect(text).toContain('Body Fat 18.5%');
    expect(text).toContain('Muscle 62.40 kg');
    expect(text).toContain('Bone 3.10 kg');
    expect(text).toContain('BMR 1750 kcal');
    expect(text).toContain('Physique 5');
  });

  it('exposes reportsExports from the config', () => {
    expect(new TelegramExporter(defaultConfig).reportsExports).toBe(false);
    expect(new TelegramExporter({ ...defaultConfig, reportExports: true }).reportsExports).toBe(
      true,
    );
  });

  it('appends one line per export result', async () => {
    const exporter = new TelegramExporter({ ...defaultConfig, reportExports: true });
    await exporter.export(samplePayload, {
      exportResults: [
        { name: 'garmin', ok: true },
        { name: 'influxdb', ok: false, error: 'HTTP 401' },
      ],
    });

    const text = lastBody().text as string;
    expect(text.endsWith('\n✅ garmin\n❌ influxdb: HTTP 401')).toBe(true);
  });

  it('formats weight-valued fields in the configured unit', async () => {
    const exporter = new TelegramExporter(defaultConfig);
    await exporter.export(samplePayload, { weightUnit: 'lbs' });

    const text = lastBody().text as string;
    expect(text).toContain('⚖️ 176.37 lbs');
    expect(text).toContain('Muscle 137.57 lbs');
    expect(text).toContain('Bone 6.83 lbs');
    expect(text).not.toContain('kg');
  });

  it('prepends [Name] when context has userName', async () => {
    const context: ExportContext = { userName: 'Dad', userSlug: 'dad' };
    const exporter = new TelegramExporter(defaultConfig);
    await exporter.export(samplePayload, context);

    const text = lastBody().text as string;
    expect(text).toContain('[Dad] ⚖️');
  });

  it('does not prepend a prefix when context is undefined', async () => {
    const exporter = new TelegramExporter(defaultConfig);
    await exporter.export(samplePayload);

    const text = lastBody().text as string;
    expect(text).not.toContain('[');
  });

  it('appends a drift warning when present', async () => {
    const exporter = new TelegramExporter(defaultConfig);
    await exporter.export(samplePayload, {
      userName: 'Dad',
      driftWarning: 'Weight 76 kg is near the lower boundary',
    });

    const text = lastBody().text as string;
    expect(text).toContain('⚠️');
    expect(text).toContain('near the lower boundary');
  });

  it('sets disable_notification from the silent option', async () => {
    const loud = new TelegramExporter(defaultConfig);
    await loud.export(samplePayload);
    expect(lastBody().disable_notification).toBe(false);

    mockFetch.mockClear();
    const silent = new TelegramExporter({ ...defaultConfig, silent: true });
    await silent.export(samplePayload);
    expect(lastBody().disable_notification).toBe(true);
  });

  it('returns failure on non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
    const exporter = new TelegramExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 401');
  });

  it('does not retry a 4xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
    const exporter = new TelegramExporter(defaultConfig);
    await exporter.export(samplePayload);

    // A bad bot token / chat ID cannot succeed on retry — fail fast.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on failure (3 total attempts)', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const exporter = new TelegramExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on retry after an initial failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const exporter = new TelegramExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  describe('healthcheck()', () => {
    it('calls getChat with the chat ID and returns success on 200', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const exporter = new TelegramExporter(defaultConfig);
      const result = await exporter.healthcheck();

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bot123456:ABC-DEF/getChat?chat_id=987654321',
        { signal: expect.any(AbortSignal) },
      );
    });

    it('returns failure on a non-2xx response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400 });
      const exporter = new TelegramExporter(defaultConfig);
      const result = await exporter.healthcheck();

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 400');
    });

    it('returns failure on a network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const exporter = new TelegramExporter(defaultConfig);
      const result = await exporter.healthcheck();

      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });
});
