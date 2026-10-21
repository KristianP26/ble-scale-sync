import { bleLog } from '../types.js';

/**
 * First time per key at `level`, after that at debug: for lines whose state
 * repeats every cycle while it lasts. One per module; `reset` is its test seam.
 */
export function onceLog() {
  const said = new Set<string>();
  const log = (key: string, level: 'info' | 'warn', message: string): void => {
    if (said.has(key)) {
      bleLog.debug(message);
      return;
    }
    said.add(key);
    bleLog[level](message);
  };
  return Object.assign(log, { reset: () => said.clear() });
}
