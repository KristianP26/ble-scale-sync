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
  /** Original measurement time for historical readings replayed from a scale's offline cache. */
  timestamp?: Date;
}

export interface Exporter {
  readonly name: string;
  /** True when this exporter honours `context.timestamp`. Historical readings skip exporters without it. */
  readonly supportsBackdate?: boolean;
  export(data: BodyComposition, context?: ExportContext): Promise<ExportResult>;
  healthcheck?(): Promise<ExportResult>;
}
