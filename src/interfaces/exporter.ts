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
  /**
   * Original measurement time when the reading came from a scale's offline
   * cache. Exporters that set `supportsBackdate=true` MUST honour this value
   * (write the original time instead of `now()`). Exporters without
   * back-dating support are filtered out by the orchestrator before
   * `export()` is called when this is set, so they do not need to handle it.
   */
  timestamp?: Date;
}

export interface Exporter {
  readonly name: string;
  /**
   * Set to true if this exporter writes the original measurement time when
   * `context.timestamp` is provided. Default (undefined) means historical
   * readings are skipped for this exporter.
   */
  readonly supportsBackdate?: boolean;
  export(data: BodyComposition, context?: ExportContext): Promise<ExportResult>;
  healthcheck?(): Promise<ExportResult>;
}
