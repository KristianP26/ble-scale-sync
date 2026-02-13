import type { ExporterName } from '../exporters/config.js';

export interface ConfigFieldDef {
  key: string;
  label: string;
  type: 'string' | 'password' | 'number' | 'boolean' | 'select';
  required: boolean;
  default?: string | number | boolean;
  description?: string;
  validate?: (value: string) => string | null;
  choices?: { label: string; value: string | number }[];
}

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
  fields: ConfigFieldDef[];
  supportsGlobal: boolean;
  supportsPerUser: boolean;
  dependencies?: DependencyCheck[];
}
