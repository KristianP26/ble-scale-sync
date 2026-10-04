import type { PromptChoice, PromptProvider } from '../../src/wizard/types.js';

export type ScriptedAnswer = string | boolean | string[];

/**
 * A prompt provider that answers by prompt text and otherwise behaves like a
 * user pressing Enter: an input returns its default, a confirm its default, a
 * select its first choice, a checkbox the choices that start checked, and a
 * password an empty string.
 *
 * Each scripted answer is used once, in order, so the same prompt asked twice
 * (once per user, say) can get two different answers. Unlike
 * createMockPromptProvider it runs `validate`, and records a rejection instead
 * of looping, so an answer the real wizard would refuse shows up in `rejected`.
 */
export function scriptedPrompts(answers: Array<[RegExp, ScriptedAnswer]>) {
  const pending = [...answers];
  const rejected: string[] = [];
  const asked: string[] = [];
  const take = (message: string): ScriptedAnswer | undefined => {
    asked.push(message);
    // A step that re-asks forever on Enter would otherwise hang the test.
    if (asked.length > 500) throw new Error(`Prompt loop: still asking "${message}"`);
    const i = pending.findIndex(([re]) => re.test(message));
    if (i < 0) return undefined;
    const [, answer] = pending[i];
    pending.splice(i, 1);
    return answer;
  };
  const check = (message: string, value: string, validate?: (v: string) => string | true) => {
    const verdict = validate?.(value) ?? true;
    if (verdict !== true) rejected.push(`${message} ${value}: ${verdict}`);
  };

  const prompts: PromptProvider = {
    async input(message, opts) {
      const answer = take(message);
      const value = typeof answer === 'string' ? answer : (opts?.default ?? '');
      check(message, value, opts?.validate);
      return value;
    },
    async password(message, opts) {
      const answer = take(message);
      const value = typeof answer === 'string' ? answer : '';
      check(message, value, opts?.validate);
      return value;
    },
    async select<T>(message: string, choices: PromptChoice<T>[]): Promise<T> {
      const answer = take(message);
      return (choices.find((c) => c.value === answer) ?? choices[0]).value;
    },
    async confirm(message, opts) {
      const answer = take(message);
      return typeof answer === 'boolean' ? answer : (opts?.default ?? false);
    },
    async checkbox<T>(message: string, choices: PromptChoice<T>[]): Promise<T[]> {
      const answer = take(message);
      if (Array.isArray(answer)) {
        return choices.filter((c) => answer.includes(String(c.value))).map((c) => c.value);
      }
      return choices.filter((c) => c.checked).map((c) => c.value);
    },
  };
  return { prompts, rejected, asked, pending };
}
