import { z } from 'zod';
import {
  BOOL_WORDS_HINT,
  configPathKey,
  parseBoolWord,
  parseDecimal,
  resolveEnvReferencesTracked,
} from './env-refs.js';

/** Passes are bounded; every pass converts at least one value or stops. */
const MAX_PASSES = 5;

/**
 * Resolve `${VAR}` references in a parsed config tree and validate it, turning
 * a reference into a number or a boolean where the schema asks for one (G-21).
 *
 * A reference resolves to a string, so `port: ${ESPHOME_PORT}` used to fail
 * with "expected number, received string". The schema itself is what knows
 * which fields are numbers and booleans, so this lets it say so: every
 * `invalid_type` issue that expects a number or a boolean, at a path whose
 * whole value was one reference, gets that value converted, and the tree is
 * parsed again. Booleans take the same words as the env overrides.
 *
 * A value that does not convert stays a validation error, reworded to name the
 * variable. The value itself is never part of the message: it may be a secret.
 *
 * Throws, like `resolveEnvReferences`, when a referenced variable is not set.
 */
export function safeParseWithEnvRefs<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): ReturnType<S['safeParse']> {
  const { value: data, wholeRefs } = resolveEnvReferencesTracked(raw);
  return safeParseResolved(schema, data, wholeRefs);
}

/** {@link safeParseWithEnvRefs} for a tree already resolved by `resolveEnvReferencesTracked`. */
export function safeParseResolved<S extends z.ZodType>(
  schema: S,
  data: unknown,
  wholeRefs: ReadonlyMap<string, string>,
): ReturnType<S['safeParse']> {
  const unconvertible = new Map<string, string>();

  for (let pass = 0; ; pass++) {
    const result = schema.safeParse(data) as ReturnType<S['safeParse']>;
    if (result.success) return result;

    let converted = false;
    if (pass < MAX_PASSES) {
      for (const issue of result.error.issues) {
        const expected = expectedScalar(issue);
        if (!expected) continue;
        const key = configPathKey(issue.path);
        const varName = wholeRefs.get(key);
        if (varName === undefined || unconvertible.has(key)) continue;
        const current = getAt(data, issue.path);
        if (typeof current !== 'string') continue;
        const value = expected === 'number' ? parseDecimal(current) : parseBoolWord(current);
        if (value === undefined) {
          unconvertible.set(
            key,
            expected === 'number'
              ? `Environment variable '${varName}' is not a number`
              : `Environment variable '${varName}' is not a boolean (${BOOL_WORDS_HINT})`,
          );
          continue;
        }
        setAt(data, issue.path, value);
        converted = true;
      }
    }
    if (converted) continue;

    if (unconvertible.size === 0) return result;
    const issues = result.error.issues.map((issue) => {
      const message = expectedScalar(issue) && unconvertible.get(configPathKey(issue.path));
      return message ? { ...issue, message } : issue;
    });
    return { success: false, error: new z.ZodError(issues) } as ReturnType<S['safeParse']>;
  }
}

function expectedScalar(issue: z.core.$ZodIssue): 'number' | 'boolean' | null {
  if (issue.code !== 'invalid_type') return null;
  if (issue.expected === 'number') return 'number';
  if (issue.expected === 'boolean') return 'boolean';
  return null;
}

function getAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

function setAt(root: unknown, path: ReadonlyArray<PropertyKey>, value: unknown): void {
  const parent = getAt(root, path.slice(0, -1));
  if (parent === null || typeof parent !== 'object') return;
  (parent as Record<PropertyKey, unknown>)[path[path.length - 1]] = value;
}
