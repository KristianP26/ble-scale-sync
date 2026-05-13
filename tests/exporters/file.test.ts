import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileExporter } from '../../src/exporters/file.js';
import type { FileConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  appendFileSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { W_OK: 2 },
}));

import * as fs from 'node:fs';

const samplePayload: BodyComposition = {
  weight: 72.5,
  impedance: 485,
  bmi: 23.1,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 58.4,
  visceralFat: 6,
  physiqueRating: 5,
  bmr: 1650,
  metabolicAge: 25,
};

const csvConfig: FileConfig = {
  filePath: '/tmp/measurements.csv',
  format: 'csv',
};

const jsonlConfig: FileConfig = {
  filePath: '/tmp/measurements.jsonl',
  format: 'jsonl',
};

describe('FileExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as ReturnType<typeof fs.statSync>);
  });

  it('has name "file"', () => {
    const exporter = new FileExporter(csvConfig);
    expect(exporter.name).toBe('file');
  });

  // ─── CSV ──────────────────────────────────────────────────────────────────

  describe('CSV format', () => {
    it('writes header + data row to new file', async () => {
      const exporter = new FileExporter(csvConfig);
      const result = await exporter.export(samplePayload);

      expect(result.success).toBe(true);
      expect(fs.appendFileSync).toHaveBeenCalledTimes(2);

      const headerCall = vi.mocked(fs.appendFileSync).mock.calls[0];
      expect(headerCall[0]).toBe('/tmp/measurements.csv');
      expect(headerCall[1]).toContain('timestamp,weight,impedance');
      expect(headerCall[1]).toContain('user\n');

      const dataCall = vi.mocked(fs.appendFileSync).mock.calls[1];
      const row = dataCall[1] as string;
      expect(row).toContain('72.50');
      expect(row).toContain('485');
      expect(row).toContain('23.1');
      expect(row).toContain('18.5');
      expect(row).toContain('\n');
    });

    it('skips header when file exists and is not empty', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as ReturnType<typeof fs.statSync>);

      const exporter = new FileExporter(csvConfig);
      await exporter.export(samplePayload);

      expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
      const row = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
      expect(row).not.toContain('timestamp,weight');
    });

    it('writes header when file exists but is empty', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as ReturnType<typeof fs.statSync>);

      const exporter = new FileExporter(csvConfig);
      await exporter.export(samplePayload);

      expect(fs.appendFileSync).toHaveBeenCalledTimes(2);
    });

    it('includes user name in CSV row', async () => {
      const exporter = new FileExporter(csvConfig);
      await exporter.export(samplePayload, { userName: 'kristian' });

      const dataCall = vi.mocked(fs.appendFileSync).mock.calls[1];
      const row = dataCall[1] as string;
      expect(row).toContain('kristian');
    });

    it('escapes user name containing commas in CSV', async () => {
      const exporter = new FileExporter(csvConfig);
      await exporter.export(samplePayload, { userName: 'Doe, Jane' });

      const dataCall = vi.mocked(fs.appendFileSync).mock.calls[1];
      const row = dataCall[1] as string;
      expect(row).toContain('"Doe, Jane"');
    });

    it('escapes user name containing double quotes in CSV', async () => {
      const exporter = new FileExporter(csvConfig);
      await exporter.export(samplePayload, { userName: 'The "Boss"' });

      const dataCall = vi.mocked(fs.appendFileSync).mock.calls[1];
      const row = dataCall[1] as string;
      expect(row).toContain('"The ""Boss"""');
    });

    it('leaves user column empty when no context', async () => {
      const exporter = new FileExporter(csvConfig);
      await exporter.export(samplePayload);

      const dataCall = vi.mocked(fs.appendFileSync).mock.calls[1];
      const row = dataCall[1] as string;
      expect(row).toMatch(/,\n$/);
    });
  });

  // ─── JSONL ────────────────────────────────────────────────────────────────

  describe('JSONL format', () => {
    it('appends valid JSON line', async () => {
      const exporter = new FileExporter(jsonlConfig);
      const result = await exporter.export(samplePayload);

      expect(result.success).toBe(true);
      expect(fs.appendFileSync).toHaveBeenCalledTimes(1);

      const line = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
      expect(line).toContain('\n');

      const parsed = JSON.parse(line.trim());
      expect(parsed.weight).toBe(72.5);
      expect(parsed.impedance).toBe(485);
      expect(parsed.bmi).toBe(23.1);
      expect(parsed.timestamp).toBeDefined();
    });

    it('includes user field when context has userName', async () => {
      const exporter = new FileExporter(jsonlConfig);
      await exporter.export(samplePayload, { userName: 'alice' });

      const line = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(line.trim());
      expect(parsed.user).toBe('alice');
    });

    it('omits user field when no userName in context', async () => {
      const exporter = new FileExporter(jsonlConfig);
      await exporter.export(samplePayload);

      const line = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(line.trim());
      expect(parsed.user).toBeUndefined();
    });
  });

  // ─── Healthcheck ──────────────────────────────────────────────────────────

  describe('healthcheck', () => {
    it('returns success when directory is writable', async () => {
      vi.mocked(fs.accessSync).mockReturnValue(undefined);
      const exporter = new FileExporter(csvConfig);
      const result = await exporter.healthcheck!();
      expect(result.success).toBe(true);
    });

    it('returns failure when directory is not writable', async () => {
      vi.mocked(fs.accessSync).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      const exporter = new FileExporter(csvConfig);
      const result = await exporter.healthcheck!();
      expect(result.success).toBe(false);
      expect(result.error).toContain('EACCES');
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns failure when appendFileSync throws', async () => {
      vi.mocked(fs.appendFileSync).mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      const exporter = new FileExporter(csvConfig);
      const result = await exporter.export(samplePayload);

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });
  });

  // ─── Back-date support ────────────────────────────────────────────────────

  describe('back-date', () => {
    // The 'error handling' describe above sets mockImplementation(() => throw)
    // on appendFileSync. vi.clearAllMocks() resets call history but NOT
    // implementations, so we have to re-mock appendFileSync as a no-op here.
    beforeEach(() => {
      vi.mocked(fs.appendFileSync).mockImplementation(() => undefined);
    });

    it('declares supportsBackdate=true', () => {
      const exporter = new FileExporter(csvConfig);
      expect(exporter.supportsBackdate).toBe(true);
    });

    it('writes context.timestamp as ISO string in CSV row', async () => {
      const exporter = new FileExporter(csvConfig);
      const ts = new Date('2025-07-01T07:15:00Z');
      await exporter.export(samplePayload, { timestamp: ts });
      const dataCall = vi.mocked(fs.appendFileSync).mock.calls[1];
      const row = dataCall[1] as string;
      expect(row).toContain('2025-07-01T07:15:00.000Z');
    });

    it('writes context.timestamp in JSONL entry', async () => {
      const exporter = new FileExporter(jsonlConfig);
      const ts = new Date('2025-07-01T07:15:00Z');
      await exporter.export(samplePayload, { timestamp: ts });
      const entry = JSON.parse(vi.mocked(fs.appendFileSync).mock.calls[0][1] as string) as {
        timestamp: string;
      };
      expect(entry.timestamp).toBe('2025-07-01T07:15:00.000Z');
    });
  });
});
