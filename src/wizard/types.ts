import type { AppConfig } from '../config/schema.js';

// --- Platform info ---

export interface PlatformInfo {
  os: 'linux' | 'darwin' | 'win32';
  arch: string;
  hasDocker: boolean;
  hasPython: boolean;
  pythonCommand: string | null;
  btGid?: number;
}

// --- Prompt provider (DI for testability) ---

export interface PromptChoice<T = string> {
  name: string;
  value: T;
  description?: string;
  /** checkbox only: starts ticked, so Enter keeps it selected. */
  checked?: boolean;
}

export interface PromptProvider {
  input(
    message: string,
    opts?: { default?: string; validate?: (v: string) => string | true },
  ): Promise<string>;
  select<T = string>(message: string, choices: PromptChoice<T>[]): Promise<T>;
  confirm(message: string, opts?: { default?: boolean }): Promise<boolean>;
  checkbox<T = string>(message: string, choices: PromptChoice<T>[]): Promise<T[]>;
  password(message: string, opts?: { validate?: (v: string) => string | true }): Promise<string>;
}

// --- Wizard context ---

export interface WizardContext {
  config: Partial<AppConfig>;
  configPath: string;
  isEditMode: boolean;
  nonInteractive: boolean;
  platform: PlatformInfo;
  stepHistory: string[];
  prompts: PromptProvider;
}

// --- Wizard step ---

export interface WizardStep {
  id: string;
  title: string;
  order: number;
  run(ctx: WizardContext): Promise<void>;
  shouldRun?(ctx: WizardContext): boolean;
}

// --- Back navigation sentinel ---

export class BackNavigation {
  readonly _tag = 'BackNavigation';
}
