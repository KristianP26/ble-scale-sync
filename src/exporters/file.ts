import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import type { BodyComposition } from '../interfaces/scale-adapter.js';
import type { Exporter, ExportContext, ExportResult } from '../interfaces/exporter.js';
import type { ExporterSchema } from '../interfaces/exporter-schema.js';
import type { FileConfig } from './config.js';
import { errMsg } from '../utils/error.js';

const log = createLogger('File');

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const CSV_COLUMNS = [
  'timestamp',
  'weight',
  'impedance',
  'bmi',
  'body_fat_percent',
  'water_percent',
  'bone_mass',
  'muscle_mass',
  'visceral_fat',
  'physique_rating',
  'bmr',
  'metabolic_age',
  'user',
] as const;

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
      fs.appendFileSync(filePath, CSV_COLUMNS.join(',') + '\n');
    }

    const row = [
      timestamp,
      data.weight.toFixed(2),
      data.impedance,
      data.bmi.toFixed(1),
      data.bodyFatPercent.toFixed(1),
      data.waterPercent.toFixed(1),
      data.boneMass.toFixed(1),
      data.muscleMass.toFixed(1),
      data.visceralFat,
      data.physiqueRating,
      data.bmr,
      data.metabolicAge,
      csvEscape(user),
    ].join(',');

    fs.appendFileSync(filePath, row + '\n');
  }

  private appendJsonl(
    filePath: string,
    data: BodyComposition,
    timestamp: string,
    user: string,
  ): void {
    const entry: Record<string, unknown> = {
      timestamp,
      weight: data.weight,
      impedance: data.impedance,
      bmi: data.bmi,
      bodyFatPercent: data.bodyFatPercent,
      waterPercent: data.waterPercent,
      boneMass: data.boneMass,
      muscleMass: data.muscleMass,
      visceralFat: data.visceralFat,
      physiqueRating: data.physiqueRating,
      bmr: data.bmr,
      metabolicAge: data.metabolicAge,
    };

    if (user) {
      entry.user = user;
    }

    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  }
}
