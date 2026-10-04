import type { PromptProvider, PromptChoice } from './types.js';

// --- Real provider (wraps @inquirer/prompts) ---

export async function createRealPromptProvider(): Promise<PromptProvider> {
  const inquirer = await import('@inquirer/prompts');

  // Extra space after prefix icons to prevent overlap in ambiguous-width terminals
  const theme = { prefix: { idle: '?', done: '\u2714 ' } };

  return {
    async input(message, opts) {
      return inquirer.input({
        message,
        default: opts?.default,
        theme,
        validate: opts?.validate
          ? (v: string) => {
              const result = opts.validate!(v);
              return result === true ? true : result;
            }
          : undefined,
      });
    },

    async select<T = string>(message: string, choices: PromptChoice<T>[]): Promise<T> {
      return inquirer.select({
        message,
        theme,
        loop: false,
        choices: choices.map((c) => ({
          name: c.name,
          value: c.value,
          description: c.description,
        })),
      });
    },

    async confirm(message, opts) {
      return inquirer.confirm({ message, default: opts?.default, theme });
    },

    async checkbox<T = string>(message: string, choices: PromptChoice<T>[]): Promise<T[]> {
      return inquirer.checkbox({
        message,
        theme,
        choices: choices.map((c) => ({
          name: c.name,
          value: c.value,
          checked: c.checked,
        })),
      });
    },

    async password(message, opts) {
      return inquirer.password({
        message,
        mask: '*',
        theme,
        validate: opts?.validate
          ? (v: string) => {
              const result = opts.validate!(v);
              return result === true ? true : result;
            }
          : undefined,
      });
    },
  };
}

// --- Mock provider (for tests) ---

export function createMockPromptProvider(
  answers: (string | number | boolean | string[])[],
): PromptProvider {
  let index = 0;

  function next(): unknown {
    if (index >= answers.length) {
      throw new Error(`Mock prompt provider exhausted — asked for answer #${index + 1}`);
    }
    return answers[index++];
  }

  return {
    async input() {
      return String(next());
    },
    async select() {
      return next() as never;
    },
    async confirm() {
      return Boolean(next());
    },
    async checkbox() {
      return next() as never;
    },
    async password() {
      return String(next());
    },
  };
}
