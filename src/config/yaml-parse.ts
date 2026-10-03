import { parse as parseYaml, YAMLError } from 'yaml';

/**
 * Parse config YAML without leaking the source into the error.
 *
 * The `yaml` library's error message carries a code frame of the offending
 * line, and some messages embed the raw token (an unquoted `*secret` becomes
 * "Unresolved alias ...: secret"). A config line very often holds a password
 * or token, and these messages end up in logs that users paste into public
 * issues. So the error we throw names only the file, the position, the error
 * code and the key on that line, never the value.
 */
export function parseConfigYaml(raw: string, sourcePath: string): unknown {
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new Error(describeYamlError(err, raw, sourcePath));
  }
}

const QUOTE_HINT = 'If that value is a password or token, put it in quotes.';

function describeYamlError(err: unknown, raw: string, sourcePath: string): string {
  if (err instanceof YAMLError) {
    const pos = err.linePos?.[0];
    if (!pos) return `Invalid YAML in ${sourcePath} (${err.code}). ${QUOTE_HINT}`;
    const lineText = raw.split(/\r?\n/)[pos.line - 1] ?? '';
    const key = /^\s*(?:-\s+)?([A-Za-z0-9_.-]+)\s*:/.exec(lineText)?.[1];
    return (
      `Invalid YAML in ${sourcePath} at line ${pos.line}, column ${pos.col}` +
      (key ? ` (key '${key}')` : '') +
      `: ${err.code}. The line is not printed because it may hold a secret. ${QUOTE_HINT}`
    );
  }
  // An unresolved alias is raised as a plain ReferenceError whose message ends
  // with the alias name, i.e. the unquoted value itself.
  if (err instanceof Error && err.message.startsWith('Unresolved alias')) {
    return (
      `Invalid YAML in ${sourcePath}: a value starts with '*', which YAML reads as an alias. ` +
      QUOTE_HINT
    );
  }
  return `Invalid YAML in ${sourcePath}. ${QUOTE_HINT}`;
}
