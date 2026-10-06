import type { AppConfig } from '../config/schema.js';

// --- Platform info ---

export interface PlatformInfo {
  os: 'linux' | 'darwin' | 'win32';
  arch: string;
  hasDocker: boolean;
  /** Some Python answered --version. */
  hasPython: boolean;
  /** The interpreter to run the Garmin scripts with: Python 3.12+, or null. */
  pythonCommand: string | null;
  /**
   * `major.minor` of pythonCommand; with no pythonCommand, of the first older
   * interpreter found, for the message that names it.
   */
  pythonVersion?: string;
  btGid?: number;
  /** Running inside a container (Docker): files written outside a mount are lost. */
  inContainer?: boolean;
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
  prompts: PromptProvider;
  /** Secrets to append to the .env beside the config when it is saved. */
  pendingEnv?: Map<string, string>;
  /**
   * Set by the summary step once config.yaml is written. The section menu
   * ends only then, so a declined or failed save goes back to the menu
   * instead of dropping every answer.
   */
  saved?: boolean;
}

// --- Wizard step ---

export interface WizardStep {
  id: string;
  title: string;
  order: number;
  run(ctx: WizardContext): Promise<void>;
  shouldRun?(ctx: WizardContext): boolean;
}
