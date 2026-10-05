import type { PromptChoice, PromptProvider } from '../../src/wizard/types.js';

export type ScriptedAnswer = string | boolean | string[];

/**
 * A prompt provider that answers by prompt text and otherwise behaves like a
 * user pressing Enter: an input returns its default, a confirm its default, a
 * select its first choice, a checkbox the choices that start checked, and a
 * password an empty string.
 *
 * Each scripted answer is used once, in order, so the same prompt asked twice
 * (once per user, say) can get two different answers. Unlike the positional
 * createMockPromptProvider (mock-prompts.ts) it runs `validate`, and records a
 * rejection instead of looping, so an answer the real wizard would refuse
 * shows up in `rejected`.
 *
 * An answer that cannot be given to the prompt it matched (a select or
 * checkbox value that is not one of the choices, a string for a confirm, a
 * boolean for an input) is recorded in `rejected` too, and the prompt then
 * behaves as on Enter. Silently taking the default instead let a test pass
 * down a path it never meant to take.
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
  const misfit = (message: string, answer: ScriptedAnswer, why: string): undefined => {
    rejected.push(`${message} ${JSON.stringify(answer)}: ${why}`);
    return undefined;
  };
  /** The scripted answer when it has the kind the prompt takes, else undefined (Enter). */
  const takeAs = <K extends 'string' | 'boolean'>(
    message: string,
    kind: K,
    prompt: string,
  ): (K extends 'string' ? string : boolean) | undefined => {
    const answer = take(message);
    if (answer === undefined) return undefined;
    if (typeof answer !== kind) return misfit(message, answer, `not an answer for ${prompt}`);
    return answer as K extends 'string' ? string : boolean;
  };

  const prompts: PromptProvider = {
    async input(message, opts) {
      const value = takeAs(message, 'string', 'an input') ?? opts?.default ?? '';
      check(message, value, opts?.validate);
      return value;
    },
    async password(message, opts) {
      const value = takeAs(message, 'string', 'a password') ?? '';
      check(message, value, opts?.validate);
      return value;
    },
    async select<T>(message: string, choices: PromptChoice<T>[]): Promise<T> {
      const answer = take(message);
      if (answer === undefined) return choices[0].value;
      const chosen = choices.find((c) => c.value === answer);
      if (chosen) return chosen.value;
      misfit(message, answer, `matches none of ${JSON.stringify(choices.map((c) => c.value))}`);
      return choices[0].value;
    },
    async confirm(message, opts) {
      return takeAs(message, 'boolean', 'a confirm') ?? opts?.default ?? false;
    },
    async checkbox<T>(message: string, choices: PromptChoice<T>[]): Promise<T[]> {
      const answer = take(message);
      const enter = () => choices.filter((c) => c.checked).map((c) => c.value);
      if (answer === undefined) return enter();
      if (!Array.isArray(answer)) return misfit(message, answer, 'not a list') ?? enter();
      const values = choices.map((c) => String(c.value));
      const unknown = answer.filter((a) => !values.includes(a));
      if (unknown.length > 0) {
        misfit(message, answer, `${JSON.stringify(unknown)} not among ${JSON.stringify(values)}`);
      }
      return choices.filter((c) => answer.includes(String(c.value))).map((c) => c.value);
    },
  };
  return { prompts, rejected, asked, pending };
}
