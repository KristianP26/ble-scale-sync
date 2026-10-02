import type { ExporterName } from '../exporters/config.js';

/** What every field carries, whatever kind it is. */
interface ConfigFieldBase {
  key: string;
  label: string;
  required: boolean;
  description?: string;
  /** Extra check on the RAW typed text. Return null when it is acceptable. */
  validate?: (value: string) => string | null;
}

export interface ConfigFieldChoice {
  label: string;
  value: string | number;
}

/**
 * A wizard field, discriminated by `type`.
 *
 * One flat interface used to allow every default for every kind of field, so
 * `type: 'number'` with `default: 'abc'` type-checked - and so did a REQUIRED
 * select with no choices, which `promptField()` answers by returning
 * `field.default`, i.e. `undefined` for a field that has no default. `required`
 * enforced nothing on that path.
 *
 * `choices` is a non-empty tuple rather than an array, so "a select with
 * nothing to select" cannot be written down in the first place; the runtime
 * guard that remains is for the case TypeScript cannot see.
 */
export type ConfigFieldDef =
  | (ConfigFieldBase & { type: 'string' | 'password'; default?: string })
  | (ConfigFieldBase & { type: 'number'; default?: number })
  | (ConfigFieldBase & { type: 'boolean'; default?: boolean })
  | (ConfigFieldBase & {
      type: 'select';
      default?: string | number;
      choices: readonly [ConfigFieldChoice, ...ConfigFieldChoice[]];
    });

export interface DependencyCheck {
  name: string;
  checkCommand: string;
  fallbackCommand?: string;
  installInstructions: string;
}

export interface ExporterSchema {
  name: ExporterName;
  displayName: string;
  description: string;
  fields: readonly ConfigFieldDef[];
  supportsGlobal: boolean;
  supportsPerUser: boolean;
  dependencies?: DependencyCheck[];
}
