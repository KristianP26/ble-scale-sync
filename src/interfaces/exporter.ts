import type { BodyComposition } from './scale-adapter.js';
import type { UserConfig, WeightUnit } from '../config/schema.js';

/**
 * The outcome of one export attempt.
 *
 * A union rather than `success: boolean` plus an independent `error?: string`,
 * which allowed two states that mean nothing: a failure with no reason, and a
 * success carrying an error. Every construction site in `src/` already paired
 * them correctly - this stops the next one from having to remember.
 *
 * `error?: undefined` on the success arm rather than omitting the property, so
 * a result can still be spread or built conditionally without a cast.
 */
export type ExportResult = { success: true; error?: undefined } | { success: false; error: string };

/** Per-exporter outcome inside a dispatch. Same contract as ExportResult. */
export type ExportResultDetail = { name: string } & (
  { ok: true; error?: undefined } | { ok: false; error: string }
);

export interface ExportContext {
  userName?: string;
  userSlug?: string;
  userConfig?: UserConfig;
  driftWarning?: string;
  /** Display unit for weight-valued fields (`scale.weight_unit`); values stay in kg. */
  weightUnit?: WeightUnit;
  /**
   * When the reading was measured. The processor sets it on EVERY dispatch,
   * live or not, and the retry queue redelivers with the same value, so all
   * attempts at one reading carry one time (D027, F-04, F-06). Exporters that
   * write a time (`supportsBackdate`) must use this rather than `new Date()`;
   * the `?? new Date()` fallbacks only cover a caller outside the processor.
   */
  timestamp?: Date;
  /**
   * True when the reading is a stored record from the scale's memory rather
   * than a weigh-in happening now (D027). `dispatchExports` then skips every
   * exporter without `supportsBackdate`, which cannot say "this happened on
   * Tuesday". Deliberately separate from `timestamp`: a timestamp alone no
   * longer means "historical", because live readings carry one too.
   */
  historical?: boolean;
  /** Outcome of the other exporters; only set for exporters with `reportsExports`. */
  exportResults?: ExportResultDetail[];
}

export interface Exporter {
  readonly name: string;
  /** True when this exporter records `context.timestamp` as the measurement time. Historical readings skip exporters without it. */
  readonly supportsBackdate?: boolean;
  /** True when this exporter runs after the others and receives their outcomes in `context.exportResults`. */
  readonly reportsExports?: boolean;
  export(data: BodyComposition, context?: ExportContext): Promise<ExportResult>;
  healthcheck?(): Promise<ExportResult>;
}
