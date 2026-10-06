import type { PromptChoice } from './types.js';

/**
 * The prompt provider has no select default; Enter picks the first choice, so
 * the current value goes first. Unknown or undefined `current` leaves the order.
 */
export function currentFirst<T>(
  choices: PromptChoice<T>[],
  current: T | undefined,
): PromptChoice<T>[] {
  const at = choices.findIndex((c) => c.value === current);
  if (at > 0) choices.unshift(...choices.splice(at, 1));
  return choices;
}
