import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MqttExporter } from '../../src/exporters/mqtt.js';
import { WebhookExporter } from '../../src/exporters/webhook.js';
import { InfluxDbExporter } from '../../src/exporters/influxdb.js';
import { NtfyExporter } from '../../src/exporters/ntfy.js';
import { GarminExporter } from '../../src/exporters/garmin.js';
import type { MqttConfig } from '../../src/exporters/config.js';

const { mockEndAsync, mockConnectAsync } = vi.hoisted(() => {
  const mockEndAsync = vi.fn().mockResolvedValue(undefined);
  const mockConnectAsync = vi.fn().mockResolvedValue({
    publishAsync: vi.fn(),
    endAsync: mockEndAsync,
  });
  return { mockEndAsync, mockConnectAsync };
});

vi.mock('mqtt', () => ({
  connectAsync: mockConnectAsync,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Exporter healthchecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectAsync.mockResolvedValue({
      publishAsync: vi.fn(),
      endAsync: mockEndAsync,
    });
    mockEndAsync.mockResolvedValue(undefined);
  });

  describe('MqttExporter.healthcheck()', () => {
    const config: MqttConfig = {
      brokerUrl: 'mqtt://localhost:1883',
      topic: 'test',
      qos: 1,
      retain: true,
      clientId: 'ble-scale-sync',
      haDiscovery: false,
      haDeviceName: 'BLE Scale',
    };

    it('returns success when connect succeeds', async () => {
      const exporter = new MqttExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(true);
      expect(mockConnectAsync).toHaveBeenCalledTimes(1);
      expect(mockEndAsync).toHaveBeenCalledTimes(1);
    });

    it('returns failure when connect fails', async () => {
      mockConnectAsync.mockRejectedValue(new Error('connection refused'));
      const exporter = new MqttExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('connection refused');
    });

    it('uses -healthcheck clientId suffix', async () => {
      const exporter = new MqttExporter(config);
      await exporter.healthcheck();
      expect(mockConnectAsync).toHaveBeenCalledWith(
        'mqtt://localhost:1883',
        expect.objectContaining({ clientId: 'ble-scale-sync-healthcheck' }),
      );
    });
  });

  describe('WebhookExporter.healthcheck()', () => {
    const config = {
      url: 'https://example.com/hook',
      method: 'POST',
      headers: {},
      timeout: 10_000,
    };

    it('returns success on 200 HEAD', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const exporter = new WebhookExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/hook', {
        method: 'HEAD',
        signal: expect.any(AbortSignal),
      });
    });

    it('returns failure on non-2xx', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      const exporter = new WebhookExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 503');
    });

    it('returns failure on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const exporter = new WebhookExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });

  describe('InfluxDbExporter.healthcheck()', () => {
    const config = {
      url: 'http://localhost:8086',
      token: 'my-token',
      org: 'my-org',
      bucket: 'my-bucket',
      measurement: 'body_composition',
    };

    it('calls /health endpoint and returns success on 200', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const exporter = new InfluxDbExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8086/health', {
        signal: expect.any(AbortSignal),
      });
    });

    it('returns failure on non-2xx', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      const exporter = new InfluxDbExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 503');
    });

    it('returns failure on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const exporter = new InfluxDbExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });

  describe('NtfyExporter.healthcheck()', () => {
    const config = {
      url: 'https://ntfy.sh',
      topic: 'my-scale',
      title: 'Scale Measurement',
      priority: 3,
    };

    it('calls /v1/health and returns success on 200', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const exporter = new NtfyExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('https://ntfy.sh/v1/health', {
        signal: expect.any(AbortSignal),
      });
    });

    it('strips trailing slashes from URL', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const exporter = new NtfyExporter({ ...config, url: 'https://ntfy.sh///' });
      const result = await exporter.healthcheck();
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('https://ntfy.sh/v1/health', {
        signal: expect.any(AbortSignal),
      });
    });

    it('returns failure on error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const exporter = new NtfyExporter(config);
      const result = await exporter.healthcheck();
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });

  describe('GarminExporter', () => {
    it('does not have healthcheck method', () => {
      const exporter = new GarminExporter();
      expect(exporter.healthcheck).toBeUndefined();
    });
  });
});
