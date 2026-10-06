/**
 * What a save changes in config.yaml, shown before the save prompt so the
 * person sees what "Save" will do. The output goes to a terminal whose
 * scrollback ends up pasted into public issues, so it is built from the
 * PARSED values, never from the text: a line-based mask let secrets through
 * in a webhook `headers` string, a quoted value containing ` #`, a block
 * scalar, a flow map, an alias, a URL with a token in it and a commented-out
 * password. Only key paths and values that went through `displayValue` are
 * printed; comments and raw lines never are.
 */
import { parseDocument } from 'yaml';
import { EXPORTER_SCHEMAS } from '../exporters/registry.js';

export const MASK = '********';

/** The single line returned when either side does not parse; it never quotes the file. */
export const UNREADABLE_LINE =
  '(the changes cannot be shown: config.yaml is not valid YAML before or after the edit)';

const MAX_VALUE = 60;
const MAX_SEGMENT = 40;

/**
 * Every field the wizard asks for as a password, taken from the exporter
 * schemas so a new exporter's secret is masked without anyone remembering to
 * list it here.
 */
const PASSWORD_FIELD_KEYS: ReadonlySet<string> = new Set(
  EXPORTER_SCHEMAS.flatMap((s) =>
    s.fields.filter((f) => f.type === 'password').map((f) => f.key.toLowerCase()),
  ),
);

/**
 * Secrets outside the exporter schemas: the ESPHome proxy key, the Xiaomi
 * bind key, the Beurer PIN and the Home Assistant token (ble.ha_bluetooth).
 * `topic` too: on a public ntfy server the topic name is the only thing
 * between a stranger and the measurements. It hides the MQTT topic as well,
 * the cheaper mistake.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'encryption_key',
  'bind_key',
  'beurer_pin',
  'token',
  'topic',
]);

/**
 * A key that merely sounds like a secret is masked too. This also hides a few
 * harmless values (token_dir, passive), which is the cheaper mistake.
 */
const SECRET_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|api[_-]?key|auth|cookie|credential|private)/i;

/**
 * Everything below these keys is masked whatever it is called: a webhook's
 * headers carry credentials under any name (X-Gotify-Key) and, as a plain
 * string, as "Authorization: Bearer ..., X-Other: ...".
 */
const SECRET_SUBTREES: ReadonlySet<string> = new Set(['headers']);

/** A `${VAR}` reference names a variable and reveals nothing, so it stays visible. */
const WHOLE_ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    PASSWORD_FIELD_KEYS.has(k) ||
    SECRET_KEYS.has(k) ||
    SECRET_SUBTREES.has(k) ||
    SECRET_KEY_PATTERN.test(k)
  );
}

interface Leaf {
  /** Matches the same setting on both sides; built from the raw keys, never displayed. */
  id: string;
  /** What is printed for the setting. */
  path: string;
  secret: boolean;
  value: unknown;
  /** Comparison key; never displayed. */
  canon: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** C0/C1 controls and the two Unicode line separators: a value must stay on its line. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

function escapeControl(s: string): string {
  let out = '';
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (!isControl(code)) out += c;
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function segment(s: string): string {
  return truncate(escapeControl(s), MAX_SEGMENT);
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isPlainObject(v)) return '{}';
  if (typeof v === 'string') return `s:${JSON.stringify(v)}`;
  return `${typeof v}:${String(v)}`;
}

/** Only a host name, an IP literal or a `${VAR}`; anything else in that place is hidden. */
const SAFE_HOST =
  /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\]|\$\{[A-Za-z_][A-Za-z0-9_]*\})(?::(?:\d{1,5}|\$\{[A-Za-z_][A-Za-z0-9_]*\}))?$/;
const URL_IN_TEXT = /\b([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s/?#]*)(\S*)/g;
const EMAIL = /^([^\s@])[^\s@]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/;

/**
 * A URL keeps only its scheme and host: webhook ids (Slack, Discord, Home
 * Assistant) sit in the path, ntfy takes `?auth=` and a broker URL can carry
 * `user:password@`. An email keeps its domain.
 */
function sanitizeText(s: string): string {
  const noUrls = s.replace(URL_IN_TEXT, (_m, scheme: string, authority: string, rest: string) => {
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    const shown = SAFE_HOST.test(host) ? host : '***';
    return `${scheme}://${shown}${rest ? '/...' : ''}`;
  });
  return noUrls.replace(/\S*@\S*/g, (word) => {
    const email = EMAIL.exec(word);
    if (email) return `${email[1]}***@${email[2]}`;
    // user:password@host without a scheme: only the part after the last @ stays.
    return `***@${word.slice(word.lastIndexOf('@') + 1)}`;
  });
}

/**
 * The values stored under a secret key, on either side. An anchor puts the
 * same value under a harmless key too (`shared: &pw hunter2` ...
 * `password: *pw`), and a URL or a header string can embed it, so a value
 * that contains one is masked wherever it appears.
 */
class KnownSecrets {
  private readonly exact = new Set<string>();
  private readonly long: string[] = [];

  add(v: unknown): void {
    if (Array.isArray(v)) return v.forEach((e) => this.add(e));
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint') return;
    const s = String(v);
    if (s === '' || WHOLE_ENV_REF.test(s)) return;
    this.exact.add(s);
    // Shorter ones only by equality: a PIN of 12 would otherwise hide every value with a 12 in it.
    if (s.length >= 4) this.long.push(s);
  }

  within(s: string): boolean {
    return this.exact.has(s) || this.long.some((secret) => s.includes(secret));
  }
}

function displayValue(v: unknown, secret: boolean, known: KnownSecrets): string {
  if (Array.isArray(v)) {
    return truncate(`[${v.map((e) => displayValue(e, secret, known)).join(', ')}]`, MAX_VALUE);
  }
  if (isPlainObject(v)) return '{}';
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  if (s === '') return "''";
  if (WHOLE_ENV_REF.test(s)) return s;
  if (secret || known.within(s)) return MASK;
  if (typeof v === 'number' || typeof v === 'boolean') return s;
  return truncate(escapeControl(sanitizeText(s)), MAX_VALUE);
}

/** One label per item, or null when the items are labelled by index. */
function slugLabels(items: unknown[]): string[] | null {
  const slugs = items.map((item) => (isPlainObject(item) ? item.slug : undefined));
  if (!slugs.every((s): s is string => typeof s === 'string' && s !== '')) return null;
  return new Set(slugs).size === slugs.length ? slugs : null;
}

/**
 * A key inside a secret (a header name, say) is shown only when it looks like
 * a name: `Authorization Bearer abc:` written by mistake would otherwise
 * print the token as a key.
 */
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

function displayKey(key: string, secret: boolean): string {
  if (secret && !PLAIN_NAME.test(key)) return '***';
  return segment(key);
}

function flatten(
  value: unknown,
  at: { id: string; path: string },
  secret: boolean,
  out: Leaf[],
): void {
  if (Array.isArray(value) && value.some((e) => Array.isArray(e) || isPlainObject(e))) {
    // Inside a secret, only the index: a slug or type there is not a label.
    const slugs = secret ? null : slugLabels(value);
    value.forEach((item, i) => {
      const slug = slugs?.[i];
      const type =
        !secret && isPlainObject(item) && typeof item.type === 'string' ? item.type : undefined;
      const label =
        slug !== undefined ? segment(slug) : type !== undefined ? `${i}:${segment(type)}` : `${i}`;
      const id = slug !== undefined ? `s:${slug}` : type !== undefined ? `${i}:${type}` : `${i}`;
      flatten(item, { id: `${at.id}\u0000[${id}]`, path: `${at.path}[${label}]` }, secret, out);
    });
    return;
  }
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) {
      const childSecret = secret || isSecretKey(key);
      const name = displayKey(key, secret);
      const path = at.path === '' ? name : `${at.path}.${name}`;
      flatten(child, { id: `${at.id}\u0000.${key}`, path }, childSecret, out);
    }
    return;
  }
  out.push({ id: at.id, path: at.path, secret, value, canon: canon(value) });
}

/** The leaves of a config text, or null when it is not a YAML mapping. */
function leavesOf(text: string): Leaf[] | null {
  try {
    // parseDocument and a silent log level: parse() prints warnings, and a
    // warning can quote the source (a stringified collection key, say).
    const doc = parseDocument(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, {
      prettyErrors: false,
      logLevel: 'silent',
    });
    if (doc.errors.length > 0) return null;
    const root: unknown = doc.toJS();
    if (root === null || root === undefined) return [];
    if (!isPlainObject(root)) return null;
    if (Object.keys(root).length === 0) return [];
    const out: Leaf[] = [];
    flatten(root, { id: '', path: '' }, false, out);
    return out;
  } catch {
    return null;
  }
}

/**
 * The settings that differ between `before` and `after`, one per line:
 * `~ path: old -> new`, `+ path: value` and `- path: value`, in the order of
 * the new config with removed settings next to where they were. A secret is
 * `********`, and a change whose two sides look the same once masked is
 * `~ path: (changed)`. null when nothing differs.
 */
export function renderConfigDiff(
  before: string,
  after: string,
  opts: { maxLines?: number } = {},
): string[] | null {
  const maxLines = opts.maxLines ?? 200;
  const oldLeaves = leavesOf(before);
  const newLeaves = leavesOf(after);
  if (oldLeaves === null || newLeaves === null) return [UNREADABLE_LINE];

  const known = new KnownSecrets();
  for (const l of [...oldLeaves, ...newLeaves]) if (l.secret) known.add(l.value);
  const show = (l: Leaf): string => displayValue(l.value, l.secret, known);

  const oldById = new Map(oldLeaves.map((l) => [l.id, l]));
  const newIndex = new Map(newLeaves.map((l, i) => [l.id, i]));

  // A removed setting is listed after the last setting before it that still exists.
  const removedAt = new Map<number, Leaf[]>();
  let anchor = -1;
  for (const leaf of oldLeaves) {
    const i = newIndex.get(leaf.id);
    if (i !== undefined) {
      anchor = i;
      continue;
    }
    removedAt.set(anchor, [...(removedAt.get(anchor) ?? []), leaf]);
  }

  const lines: string[] = [];
  const removed = (at: number): void => {
    for (const l of removedAt.get(at) ?? []) {
      lines.push(`- ${l.path}: ${show(l)}`);
    }
  };
  removed(-1);
  newLeaves.forEach((l, i) => {
    const old = oldById.get(l.id);
    const shown = show(l);
    if (old === undefined) {
      lines.push(`+ ${l.path}: ${shown}`);
    } else if (old.canon !== l.canon) {
      const was = show(old);
      lines.push(was === shown ? `~ ${l.path}: (changed)` : `~ ${l.path}: ${was} -> ${shown}`);
    }
    removed(i);
  });

  if (lines.length === 0) return null;
  if (lines.length > maxLines) {
    const hidden = lines.length - maxLines;
    return [...lines.slice(0, maxLines), `... ${hidden} more change(s) not shown`];
  }
  return lines;
}
