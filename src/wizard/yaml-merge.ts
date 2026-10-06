import { parseDocument, isCollection, isMap, isScalar, isSeq } from 'yaml';
import type { Document } from 'yaml';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function keyOf(key: unknown): string {
  return isScalar(key) ? String(key.value) : String(key);
}

/** The `slug` of a YAML map node, or undefined. */
function slugOfNode(node: unknown): string | undefined {
  if (!isMap(node)) return undefined;
  const slug = node.get('slug');
  return typeof slug === 'string' ? slug : undefined;
}

function joinComments(a: string | undefined, b: string | undefined): string | undefined {
  return a && b ? `${a}\n${b}` : (a ?? b);
}

/**
 * The comment lines after a block collection, its own trailing comment and
 * that of its last child. yaml attaches a comment that ends a block to that
 * block, also one that is written as the introduction of the next key.
 */
function trailingComment(node: unknown): string | undefined {
  if (!isCollection(node) || node.flow) return undefined;
  const last = node.items[node.items.length - 1];
  const inner = isMap(node) ? (last as { value?: unknown } | undefined)?.value : last;
  return joinComments(trailingComment(inner), node.comment ?? undefined);
}

/**
 * Bring `node` in line with `value`, reusing every node that survives so its
 * comments stay attached. Returns the node to put in the parent's place.
 */
function sync(doc: Document, node: unknown, value: unknown): unknown {
  if (isPlainObject(value) && isMap(node)) {
    // undefined is how the wizard removes a key; the old stringify dropped it too.
    const wanted = Object.entries(value).filter(([, v]) => v !== undefined);
    const names = new Set(wanted.map(([k]) => k));
    // A dropped block takes its trailing comment with it, and that comment is
    // often the one above the next key. It moves to the next key kept, or
    // to the end of this map when nothing after it is kept.
    let carried: string | undefined;
    node.items = node.items.filter((pair) => {
      if (!names.has(keyOf(pair.key))) {
        carried = joinComments(carried, trailingComment(pair.value));
        return false;
      }
      if (carried !== undefined && isScalar(pair.key)) {
        pair.key.commentBefore = joinComments(carried, pair.key.commentBefore ?? undefined);
        carried = undefined;
      }
      return true;
    });
    if (carried !== undefined) node.comment = joinComments(node.comment ?? undefined, carried);
    for (const [k, v] of wanted) {
      const pair = node.items.find((p) => keyOf(p.key) === k);
      if (pair) pair.value = sync(doc, pair.value, v);
      else node.items.push(doc.createPair(k, v));
    }
    return node;
  }

  if (Array.isArray(value) && isSeq(node)) {
    const old = [...node.items];
    // yaml keeps the comment above the first item on the sequence itself, so
    // removing the first user left that user's comment above the next one.
    // It goes with the item instead, like the comments above later items.
    const first = old[0];
    if (node.commentBefore && isCollection(first) && !first.commentBefore) {
      first.commentBefore = node.commentBefore;
      node.commentBefore = undefined;
    }
    // Users are matched by slug, so removing the first user does not move the
    // second user's comments onto the third. Anything else goes by position.
    // Two users with one slug (saved through "Save anyway?") would both match
    // the first node and one would overwrite the other, so a duplicate slug
    // falls back to position, and no node is ever used twice.
    const slugs = value.map((v) =>
      isPlainObject(v) && typeof v.slug === 'string' ? v.slug : undefined,
    );
    const bySlug = slugs.every((s) => s !== undefined) && new Set(slugs).size === slugs.length;
    const used = new Set<unknown>();
    node.items = value.map((v, i) => {
      let match: unknown = bySlug
        ? old.find((n) => !used.has(n) && slugOfNode(n) === slugs[i])
        : old[i];
      if (used.has(match)) match = undefined;
      if (match === undefined) return doc.createNode(v);
      used.add(match);
      return sync(doc, match, v);
    }) as typeof node.items;
    return node;
  }

  if (isScalar(node) && isPrimitive(value)) {
    // Changing the value in place keeps the comment and the quoting style.
    if (node.value !== value) node.value = value;
    return node;
  }

  return doc.createNode(value);
}

/**
 * Serialize `value` as an edit of the YAML text `raw`: comments, key order and
 * quoting of everything that is kept stay as they were. Returns undefined when
 * `raw` is not a YAML mapping, so the caller can fall back to a fresh file.
 *
 * The wizard used to stringify the whole object, so saving in edit mode threw
 * away every comment in config.yaml. The app's own write (last_known_weight)
 * has always kept them.
 */
export function mergeIntoYaml(raw: string, value: Record<string, unknown>): string | undefined {
  const doc = parseDocument(raw);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return undefined;
  sync(doc, doc.contents, value);
  return doc.toString({ lineWidth: 0 });
}
