#!/usr/bin/env node
/**
 * Config edits that run.sh makes before the app starts.
 *
 *   merge-weights <fresh> <persistent>
 *     Copy each user's last_known_weight (matched by slug) from the previously
 *     persisted config into the freshly generated or copied one, and write the
 *     result to <persistent>. Exit 0 on success, 1 when <fresh> is not valid
 *     YAML (run.sh then falls back to a plain copy).
 *
 *   proxy-liveness <file> <minutes>
 *     Set ble.proxy_liveness_timeout_min in <file> unless the file sets it.
 *     Exit 0 written, 3 the file already sets it, 4 value out of range,
 *     5 the file is not a mapping (or ble is not one).
 *
 *   check-env-refs <file>
 *     List the config paths whose value references ${SUPERVISOR_TOKEN} or
 *     ${HASSIO_TOKEN}, one per line, never a value. The app refuses those
 *     references; run.sh uses this to stop with a clear message instead of
 *     starting an app that exits at once. Exit 0 none, 6 at least one, 7 the
 *     file is not valid YAML (the app reports that itself).
 *
 *   drop-supervisor-token <file>
 *     Delete `ble.ha_bluetooth.token` when it is exactly ${SUPERVISOR_TOKEN}
 *     and `ble.ha_bluetooth.url` is the Supervisor's websocket proxy: the app
 *     reads that token itself for this URL. The rest of the file keeps its
 *     values, but not its exact text: line folding and a comment attached to
 *     the key can change. Exit 0 the line was removed, 7 the file is not valid
 *     YAML, 8 nothing to remove (the file is not written in either case).
 *
 * The edits go through the `yaml` package the app itself reads config.yaml
 * with (YAML 1.2), loaded from the image's own node_modules. They used to run
 * through PyYAML, which is YAML 1.1: a load and dump of the whole document
 * rewrote values the app then read as a different type. `beurer_pin: 0123`
 * reached the app as 83 (octal), an unquoted MAC as a base-60 integer, a
 * quoted password "1e5" came back unquoted as the number 100000, and a slug
 * `no` became false. Reading and writing with the app's own parser cannot
 * change what the app reads, and a file that needs no edit is written back
 * byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

function load(path) {
  const text = readFileSync(path, 'utf8');
  return { text, doc: parseDocument(text) };
}

/** Slugs compare as text: an unquoted `slug: 123` and a quoted "123" are one user. */
function slugKey(value) {
  return value === null || value === undefined ? null : String(value);
}

function usersOf(doc) {
  const users = isMap(doc.contents) ? doc.contents.get('users', true) : undefined;
  return isSeq(users) ? users.items.filter((u) => isMap(u)) : [];
}

function mergeWeights(freshPath, persistentPath) {
  const fresh = load(freshPath);
  if (fresh.doc.errors.length > 0) {
    console.error(`merge-weights: ${freshPath} is not valid YAML`);
    return 1;
  }

  const oldWeights = new Map();
  let old = null;
  try {
    old = load(persistentPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // A persisted file that no longer parses has nothing to preserve.
  if (old && old.doc.errors.length === 0) {
    for (const user of usersOf(old.doc)) {
      const slug = slugKey(user.get('slug'));
      const weight = user.get('last_known_weight');
      if (slug && typeof weight === 'number') oldWeights.set(slug, weight);
    }
  }

  let merged = 0;
  for (const user of usersOf(fresh.doc)) {
    const slug = slugKey(user.get('slug'));
    if (slug && oldWeights.has(slug)) {
      user.set('last_known_weight', oldWeights.get(slug));
      merged++;
    }
  }

  writeFileSync(persistentPath, merged > 0 ? fresh.doc.toString() : fresh.text);
  if (merged > 0) console.log(`Preserved last_known_weight for ${merged} user(s)`);
  return 0;
}

function proxyLiveness(path, raw) {
  if (!/^\d+$/.test(raw)) return 4;
  const value = Number(raw);
  if (value > 1440) return 4;

  const { doc } = load(path);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return 5;
  const ble = doc.contents.get('ble', true);
  if (ble === undefined || (isScalar(ble) && ble.value === null)) {
    doc.contents.set('ble', doc.createNode({ proxy_liveness_timeout_min: value }));
  } else if (!isMap(ble)) {
    return 5;
  } else if (ble.has('proxy_liveness_timeout_min')) {
    return 3;
  } else {
    ble.set('proxy_liveness_timeout_min', value);
  }
  writeFileSync(path, doc.toString());
  return 0;
}

/** Mirrors SUPERVISOR_WS_PATHS and isSupervisorUrl in src/ble/handler-ha-bluetooth/supervisor.ts. */
const SUPERVISOR_WS_PATHS = ['/core/websocket', '/core/api/websocket'];

function isSupervisorUrl(raw) {
  try {
    const u = new URL(raw);
    return (
      (u.protocol === 'ws:' || u.protocol === 'http:') &&
      u.hostname === 'supervisor' &&
      u.port === '' &&
      SUPERVISOR_WS_PATHS.includes(u.pathname) &&
      u.username === '' &&
      u.password === '' &&
      u.search === '' &&
      u.hash === ''
    );
  } catch {
    return false;
  }
}

/**
 * The one legacy shape that is dropped instead of refused: the Supervisor URL
 * with the token line the add-on guide used to show.
 */
function dropSupervisorToken(path) {
  const { doc } = load(path);
  if (doc.errors.length > 0) return 7;
  try {
    doc.toJS();
  } catch {
    return 7;
  }
  const ble = isMap(doc.contents) ? doc.contents.get('ble', true) : undefined;
  const ha = isMap(ble) ? ble.get('ha_bluetooth', true) : undefined;
  if (!isMap(ha)) return 8;
  const token = ha.get('token', true);
  const url = ha.get('url', true);
  if (!isScalar(token) || token.value !== '${SUPERVISOR_TOKEN}') return 8;
  if (!isScalar(url) || typeof url.value !== 'string' || !isSupervisorUrl(url.value)) return 8;
  ha.delete('token');
  let text;
  try {
    // lineWidth 0: the default folds a scalar longer than 80 columns into a continuation.
    text = doc.toString({ lineWidth: 0 });
  } catch {
    // An alias elsewhere in the file points at the deleted token: leave the file alone
    // and let check-env-refs refuse it with its own message.
    return 8;
  }
  writeFileSync(path, text);
  return 0;
}

/** Mirrors BLOCKED_ENV_REFS and the reference syntax of src/config/env-refs.ts. */
const BLOCKED_ENV_REFS = ['SUPERVISOR_TOKEN', 'HASSIO_TOKEN'];
const ENV_REF_REGEX = /\$(\$?)\{([^}]+)}/g;

function pathText(path) {
  const text = path
    .map((p, i) =>
      typeof p === 'number'
        ? `[${p}]`
        : (i ? '.' : '') + String(p).replace(/[^A-Za-z0-9_.-]/g, '?'),
    )
    .join('');
  return text || '(root)';
}

function collectBlocked(value, path, found) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(ENV_REF_REGEX)) {
      if (!m[1] && BLOCKED_ENV_REFS.includes(m[2].toUpperCase())) found.add(pathText(path));
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => collectBlocked(item, [...path, i], found));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectBlocked(item, [...path, key], found);
  }
}

function checkEnvRefs(path) {
  const { doc } = load(path);
  if (doc.errors.length > 0) return 7;
  let data;
  try {
    data = doc.toJS();
  } catch {
    // An alias with no anchor throws here, without an entry in doc.errors.
    return 7;
  }
  const found = new Set();
  collectBlocked(data, [], found);
  if (found.size === 0) return 0;
  console.log([...found].slice(0, 20).join('\n'));
  return 6;
}

const [command, ...args] = process.argv.slice(2);
let code;
if (command === 'merge-weights' && args.length === 2) {
  code = mergeWeights(args[0], args[1]);
} else if (command === 'proxy-liveness' && args.length === 2) {
  code = proxyLiveness(args[0], args[1]);
} else if (command === 'check-env-refs' && args.length === 1) {
  code = checkEnvRefs(args[0]);
} else if (command === 'drop-supervisor-token' && args.length === 1) {
  code = dropSupervisorToken(args[0]);
} else {
  console.error(
    'Usage: addon-config.mjs merge-weights <fresh> <persistent>\n' +
      '       addon-config.mjs proxy-liveness <file> <minutes>\n' +
      '       addon-config.mjs check-env-refs <file>\n' +
      '       addon-config.mjs drop-supervisor-token <file>',
  );
  code = 2;
}
process.exit(code);
