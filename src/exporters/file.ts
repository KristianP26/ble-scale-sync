import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { FileConfig } from './config.js';
import { errMsg } from '../utils/error.js';
import { CSV_METRIC_KEYS, METRICS, METRIC_KEYS } from './metrics.js';

const log = createLogger('File');

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Fixed columns: a metric only some weigh-ins carry goes to JSONL only (#497).
const CSV_COLUMNS = ['timestamp', ...CSV_METRIC_KEYS.map((k) => METRICS[k].column), 'user'];

export const fileSchema: ExporterSchema = {
  name: 'file',
  displayName: 'File (CSV/JSONL)',
  description: 'Append readings to a local CSV or JSONL file',
  fields: [
    {
      key: 'file_path',
      label: 'File Path',
      type: 'string',
      required: true,
      description: 'Path to the output file (e.g. ./measurements.csv)',
    },
    {
      key: 'format',
      label: 'Format',
      type: 'select',
      required: false,
      default: 'csv',
      choices: [
        { label: 'CSV', value: 'csv' },
        { label: 'JSONL', value: 'jsonl' },
      ],
    },
  ],
  supportsGlobal: true,
  supportsPerUser: true,
};

/**
 * Every weigh-in, with names and body composition, so owner-only like the
 * retry queue (D014). The default 0666 & ~umask made it 0644, readable by
 * every local account. Node applies `mode` only when the file is created, so
 * a file created by an older version keeps its permissions.
 */
const OWNER_ONLY = { mode: 0o600 } as const;

export class FileExporter implements Exporter {
  readonly name = 'file';
  readonly supportsBackdate = true;
  private readonly config: FileConfig;

  constructor(config: FileConfig) {
    this.config = config;
  }

  async healthcheck(): Promise<ExportResult> {
    try {
      const dir = path.dirname(this.config.filePath);
      fs.accessSync(dir, fs.constants.W_OK);
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  async export(data: BodyComposition, context?: ExportContext): Promise<ExportResult> {
    try {
      const filePath = this.config.filePath;
      const format = this.config.format;
      const timestamp = (context?.timestamp ?? new Date()).toISOString();
      const user = context?.userName ?? '';

      if (format === 'jsonl') {
        this.appendJsonl(filePath, data, timestamp, user);
      } else {
        this.appendCsv(filePath, data, timestamp, user);
      }

      log.info(`Measurement appended to ${filePath}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  private appendCsv(
    filePath: string,
    data: BodyComposition,
    timestamp: string,
    user: string,
  ): void {
    const needsHeader = !fs.existsSync(filePath) || fs.statSync(filePath).size === 0;

    if (needsHeader) {
      fs.appendFileSync(filePath, CSV_COLUMNS.join(',') + '\n', OWNER_ONLY);
    }

    // A withheld value (null, #497) is an empty cell, never the word null.
    const metrics = CSV_METRIC_KEYS.map((k) => {
      const v = data[k];
      if (v === null) return '';
      const { decimals } = METRICS[k];
      return decimals === undefined ? v : v.toFixed(decimals);
    });
    const row = [timestamp, ...metrics, csvEscape(user)].join(',');

    fs.appendFileSync(filePath, row + '\n', OWNER_ONLY);
  }

  private appendJsonl(
    filePath: string,
    data: BodyComposition,
    timestamp: string,
    user: string,
  ): void {
    const entry: Record<string, unknown> = {
      timestamp,
      ...Object.fromEntries(
        METRIC_KEYS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]),
      ),
    };

    if (user) {
      entry.user = user;
    }

    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', OWNER_ONLY);
  }
}
