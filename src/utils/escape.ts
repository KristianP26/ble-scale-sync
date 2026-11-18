/**
 * Escaping of terminal control characters for log output (ADR D108).
 *
 * Two strengths, because two kinds of text reach the log:
 * - `escapeControlChars` is the logger's net for every line. It keeps LF and TAB,
 *   which multi-line messages, stack traces and config errors rely on, and does
 *   not touch backslashes (Windows paths and JSON would double).
 * - `escapeForLog` is for text that came from a peer (a BLE name, a proxy
 *   payload). It escapes LF and TAB too, so such text cannot start a line of
 *   its own, and backslash, so an escaped character stays distinguishable from
 *   the literal characters that spell it.
 *
 * Both escape C0, DEL, the C1 controls (xterm honours U+009B and U+009D as CSI
 * and OSC introducers in UTF-8) and U+2028/U+2029 (line breaks for anything that
 * splits on Unicode newlines).
 */

function hexEscape(c: string): string {
  const code = c.charCodeAt(0);
  return code > 0xff
    ? `\\u${code.toString(16).padStart(4, '0')}`
    : `\\x${code.toString(16).padStart(2, '0')}`;
}

/** Everything but LF (0x0a) and TAB (0x09). */
const LOGGER_CLASS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g;
const STRICT_CLASS = /[\\\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

/** Logger variant: keeps LF and TAB, folds CRLF to LF, escapes the rest. */
export function escapeControlChars(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(LOGGER_CLASS, hexEscape);
}

/** Strict variant for text from a peer: every control character and backslash is escaped. */
export function escapeForLog(text: string): string {
  return text.replace(STRICT_CLASS, hexEscape);
}
