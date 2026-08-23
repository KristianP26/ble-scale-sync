import type { BodyComposition } from './scale-adapter.js';
import type { UserConfig, WeightUnit } from '../config/schema.js';

export interface ExportResult {
  success: boolean;
  error?: string;
}

export interface ExportResultDetail {
  name: string;
  ok: boolean;
  error?: string;
}

export interface ExportContext {
  userName?: string;
  userSlug?: string;
  userConfig?: UserConfig;
  driftWarning?: string;
  /** Display unit for weight-valued fields (`scale.weight_unit`); values stay in kg. */
  weightUnit?: WeightUnit;
  /** Original measurement time for historical readings replayed from a scale's offline cache. */
  timestamp?: Date;
  /** Outcome of the other exporters; only set for exporters with `reportsExports`. */
  exportResults?: ExportResultDetail[];
}

export interface Exporter {
  readonly name: string;
  /** True when this exporter honours `context.timestamp`. Historical readings skip exporters without it. */
  readonly supportsBackdate?: boolean;
  /** True when this exporter runs after the others and receives their outcomes in `context.exportResults`. */
  readonly reportsExports?: boolean;
  export(data: BodyComposition, context?: ExportContext): Promise<ExportResult>;
  healthcheck?(): Promise<ExportResult>;
}
