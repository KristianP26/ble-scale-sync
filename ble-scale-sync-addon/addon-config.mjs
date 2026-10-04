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
 * Both edits go through the `yaml` package the app itself reads config.yaml
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

const [command, ...args] = process.argv.slice(2);
let code;
if (command === 'merge-weights' && args.length === 2) {
  code = mergeWeights(args[0], args[1]);
} else if (command === 'proxy-liveness' && args.length === 2) {
  code = proxyLiveness(args[0], args[1]);
} else {
  console.error(
    'Usage: addon-config.mjs merge-weights <fresh> <persistent>\n' +
      '       addon-config.mjs proxy-liveness <file> <minutes>',
  );
  code = 2;
}
process.exit(code);
