/**
 * Verify the adapter and exporter counts published in the docs against the code
 * (#366).
 *
 * Adding an adapter or an exporter used to mean hand-editing the same number in
 * eight places with nothing checking them, and they drifted: `docs/faq.md` once
 * shipped 33 in its JSON-LD block and 32 in the prose two lines below, on the
 * same public page.
 *
 * Three numbers, and the distinction between the first two is deliberate:
 *
 *   registry   every adapter the app instantiates, including the generic
 *              StandardGattScaleAdapter catch-all
 *   protocol   registry minus that catch-all, which is what the docs mean by
 *              "protocol adapters"
 *   exporters  entries in the exporter registry
 *
 * Each occurrence below declares which of the three it carries, so a page that
 * quotes the registry count where it means the protocol count fails rather than
 * being accepted as "a number near the word adapter".
 *
 * Run it:
 *
 *   npm run check:counts          verify, exit 1 naming every mismatch
 *   npm run check:counts:write    rewrite the occurrences to match the code
 *
 * The counts are also asserted against the real registries at runtime in
 * `tests/check-counts.test.ts`. That cross-check is the important half: the
 * regexes here are cheap and keep this file runnable by bare `node` with no
 * install step, but a silently-wrong derivation combined with `write` would
 * rewrite eight public files to the wrong number, which is worse than the drift
 * this exists to stop.
 *
 * Deliberately NOT checked here: `CLAUDE.md` and `.claude/docs/` also carry
 * these counts, and both are local-only files excluded from git. A public
 * script that read them would fail in CI on a clean checkout.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Anchored to this module, not to cwd, so the CLI and the test agree. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const SCALES_INDEX = path.join(REPO_ROOT, 'src/scales/index.ts');
export const EXPORTERS_REGISTRY = path.join(REPO_ROOT, 'src/exporters/registry.ts');

export interface Counts {
  registry: number;
  protocol: number;
  exporters: number;
}

export type CountName = 'registry' | 'protocol' | 'exporters';

/**
 * Derive the three numbers from the two registry sources.
 *
 * Throws rather than guessing when the generic adapter cannot be found exactly
 * once: without it the protocol count silently equals the registry count, and
 * `write` would then propagate an off-by-one into every public page.
 */
export function deriveCounts(scalesIndex: string, exportersRegistry: string): Counts {
  const registry = (scalesIndex.match(/new [A-Za-z0-9_]+Adapter\(/g) ?? []).length;
  const generic = (scalesIndex.match(/new StandardGattScaleAdapter\(/g) ?? []).length;
  const exporters = (exportersRegistry.match(/^\s*schema: \w*Schema,$/gm) ?? []).length;

  if (registry === 0) throw new Error('No adapters found in src/scales/index.ts');
  if (generic !== 1) {
    throw new Error(
      `Expected exactly one StandardGattScaleAdapter in src/scales/index.ts, found ${generic}. ` +
        'The protocol count is the registry count minus that one generic catch-all, so this ' +
        'has to be unambiguous.',
    );
  }
  if (exporters === 0) throw new Error('No exporters found in src/exporters/registry.ts');

  return { registry, protocol: registry - generic, exporters };
}

export interface Occurrence {
  /** Repo-relative path. */
  file: string;
  /** Must match exactly once, with one capture group per entry in `counts`. */
  pattern: RegExp;
  /** Which count each capture group carries, in order. */
  counts: CountName[];
  /** Human description, used in failure messages. */
  label: string;
}

/**
 * Every public occurrence of a derived count.
 *
 * Patterns are deliberately anchored to their surrounding words rather than
 * hunting for a bare number. A rewording that breaks a pattern makes the check
 * fail loudly, which is the point: a pattern that silently stopped matching
 * would disarm the check without anybody noticing, and that is the same class
 * of failure this issue is about.
 */
export const OCCURRENCES: Occurrence[] = [
  {
    file: 'docs/public/logo.svg',
    // Anchored to the text node. An unanchored `>(\d+)\.(\d+)<` happens to
    // match only this today, but one added <text> or <tspan> would make it
    // ambiguous.
    pattern: /(<text\b[^>]*>)(\d+)\.(\d+)(<\/text>)/,
    counts: ['protocol', 'exporters'],
    label: 'logo, <protocol>.<exporters>',
  },
  {
    file: 'docs/faq.md',
    pattern: /There are (\d+) scale adapters/,
    counts: ['protocol'],
    label: 'FAQ JSON-LD answer',
  },
  {
    file: 'docs/faq.md',
    pattern: /full list of (\d+) adapters/,
    counts: ['protocol'],
    label: 'FAQ prose',
  },
  {
    file: 'docs/alternatives.md',
    pattern: /(\d+) protocol adapters/,
    counts: ['protocol'],
    label: 'comparison table',
  },
  {
    file: 'docs/guide/supported-scales.md',
    pattern: /\*\*(\d+) protocol adapters\*\*/,
    counts: ['protocol'],
    label: 'supported scales intro',
  },
  {
    file: 'docs/index.md',
    pattern: /title: (\d+) Export Targets/,
    counts: ['exporters'],
    label: 'home page feature card',
  },
  {
    file: 'CONTRIBUTING.md',
    pattern: /for all (\d+) adapters/,
    counts: ['protocol'],
    label: 'contributing, test coverage note',
  },
  {
    file: 'README.md',
    pattern: /\[(\d+) export targets\]/,
    counts: ['exporters'],
    label: 'README feature list',
  },
];

export interface Mismatch {
  file: string;
  label: string;
  line: number;
  which: CountName;
  expected: number;
  found: number;
}

/** 1-based line number of a character offset. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * The single match of `occ` in `text`, with group offsets.
 *
 * Global so "matched more than once" is detectable rather than silently taking
 * the first, and `d` so the rewriter can splice individual capture groups. That
 * matters: replacing a match by joining its capture groups drops every literal
 * character BETWEEN them, which turned `>35.11<` into `>3511<` and `for all 35
 * adapters` into `35` the first time this was written.
 */
function matchAllOnce(text: string, occ: Occurrence): RegExpMatchArray {
  const flags = `${occ.pattern.flags.replace(/[gd]/g, '')}gd`;
  const global = new RegExp(occ.pattern.source, flags);
  const found = [...text.matchAll(global)];
  if (found.length !== 1) {
    throw new Error(
      `${occ.file}: expected the ${occ.label} pattern to match exactly once, matched ` +
        `${found.length} time(s). Pattern: ${occ.pattern.source}`,
    );
  }
  return found[0];
}

/**
 * The capture-group indices that carry counts.
 *
 * The logo pattern wraps its two numbers in surrounding groups so `write` can
 * rebuild the tag, so the count groups are not always 1..n. Anything that is
 * purely numeric is a count group; the rest is context.
 */
function countGroups(match: RegExpMatchArray, occ: Occurrence): number[] {
  const numeric: number[] = [];
  for (let i = 1; i < match.length; i++) {
    if (/^\d+$/.test(match[i] ?? '')) numeric.push(i);
  }
  if (numeric.length !== occ.counts.length) {
    throw new Error(
      `${occ.file}: the ${occ.label} pattern captured ${numeric.length} number(s), ` +
        `but ${occ.counts.length} count(s) were declared for it.`,
    );
  }
  return numeric;
}

/** Mismatches for one occurrence, empty when it already agrees with the code. */
export function checkText(text: string, occ: Occurrence, counts: Counts): Mismatch[] {
  const match = matchAllOnce(text, occ);
  const groups = countGroups(match, occ);
  const out: Mismatch[] = [];
  groups.forEach((groupIndex, i) => {
    const which = occ.counts[i]!;
    const expected = counts[which];
    const found = Number(match[groupIndex]);
    if (found !== expected) {
      out.push({
        file: occ.file,
        label: occ.label,
        line: lineOf(text, match.index ?? 0),
        which,
        expected,
        found,
      });
    }
  });
  return out;
}

/**
 * `text` with this occurrence's numbers replaced by the derived counts.
 *
 * Splices each count group in place using its own offsets, back to front so the
 * earlier offsets stay valid. Everything outside those groups, including the
 * literal `.` between the logo's two numbers and the words around each count,
 * is left byte for byte alone.
 */
export function applyText(text: string, occ: Occurrence, counts: Counts): string {
  const match = matchAllOnce(text, occ);
  const groups = countGroups(match, occ);
  const indices = (match as RegExpMatchArray & { indices?: Array<[number, number] | undefined> })
    .indices;
  if (!indices) throw new Error('Regex match indices unavailable');

  const edits = groups.map((group, i) => {
    const span = indices[group];
    if (!span) throw new Error(`${occ.file}: capture group ${group} did not participate`);
    return { span, value: String(counts[occ.counts[i]!]) };
  });
  edits.sort((a, b) => b.span[0] - a.span[0]);

  let out = text;
  for (const edit of edits) {
    out = out.slice(0, edit.span[0]) + edit.value + out.slice(edit.span[1]);
  }
  return out;
}

function readCounts(): Counts {
  return deriveCounts(
    readFileSync(SCALES_INDEX, 'utf-8'),
    readFileSync(EXPORTERS_REGISTRY, 'utf-8'),
  );
}

function main(argv: string[]): void {
  const write = argv.includes('write');
  const counts = readCounts();

  // Group by file: docs/faq.md carries two occurrences, and a naive
  // read-modify-write per occurrence would let the second write clobber the
  // first.
  const byFile = new Map<string, Occurrence[]>();
  for (const occ of OCCURRENCES) {
    const list = byFile.get(occ.file) ?? [];
    list.push(occ);
    byFile.set(occ.file, list);
  }

  const mismatches: Mismatch[] = [];
  for (const [file, occurrences] of byFile) {
    const absolute = path.join(REPO_ROOT, file);
    const original = readFileSync(absolute, 'utf-8');
    let text = original;
    for (const occ of occurrences) {
      if (write) text = applyText(text, occ, counts);
      else mismatches.push(...checkText(text, occ, counts));
    }
    if (write && text !== original) {
      writeFileSync(absolute, text);
      console.log(`updated ${file}`);
    }
  }

  if (write) {
    console.log(
      `Counts written: ${counts.protocol} protocol adapters ` +
        `(${counts.registry} in the registry), ${counts.exporters} exporters.`,
    );
    return;
  }

  if (mismatches.length > 0) {
    for (const m of mismatches) {
      console.error(
        `${m.file}:${m.line} ${m.label} says ${m.found}, the ${m.which} count is ${m.expected}`,
      );
    }
    console.error('\nRun `npm run check:counts:write` to fix these.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `Counts agree: ${counts.protocol} protocol adapters ` +
      `(${counts.registry} in the registry), ${counts.exporters} exporters.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
