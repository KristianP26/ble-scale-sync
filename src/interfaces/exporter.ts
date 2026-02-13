import type { BodyComposition } from './scale-adapter.js';
import type { UserConfig } from '../config/schema.js';

export interface ExportResult {
  success: boolean;
  error?: string;
}

export interface ExportContext {
  userName?: string;
  userSlug?: string;
  userConfig?: UserConfig;
  driftWarning?: string;
}

export interface Exporter {
  readonly name: string;
  export(data: BodyComposition, context?: ExportContext): Promise<ExportResult>;
  healthcheck?(): Promise<ExportResult>;
}
