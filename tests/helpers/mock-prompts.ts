import type { PromptProvider } from '../../src/wizard/types.js';

/**
 * A prompt provider that hands out `answers` in order, whatever is asked, and
 * throws once they run out. Only for flows where the order is the point, like
 * the runner's section menu; a step's prompts are better answered by text
 * with scriptedPrompts, which survives a prompt being added or reordered.
 */
export function createMockPromptProvider(
  answers: (string | number | boolean | string[])[],
): PromptProvider {
  let index = 0;

  function next(): unknown {
    if (index >= answers.length) {
      throw new Error(`Mock prompt provider exhausted - asked for answer #${index + 1}`);
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
