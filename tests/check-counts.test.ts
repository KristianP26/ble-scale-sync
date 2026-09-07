import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  SCALES_INDEX,
  EXPORTERS_REGISTRY,
  OCCURRENCES,
  deriveCounts,
  checkText,
  applyText,
  type Occurrence,
} from '../src/tools/check-counts.js';
import { adapters } from '../src/scales/index.js';
import { StandardGattScaleAdapter } from '../src/scales/standard-gatt.js';
import { EXPORTER_REGISTRY } from '../src/exporters/registry.js';

/**
 * Guard for #366. Adding an adapter or an exporter means the same number
 * appears in eight public places, and nothing used to check them against the
 * code: `docs/faq.md` once shipped 33 in its JSON-LD block and 32 in the prose
 * two lines below.
 *
 * This is the enforcement point rather than a CI step, matching how #294 is
 * guarded for the add-on changelog: it runs inside the jobs branch protection
 * already requires, so no workflow change is needed for it to gate a merge.
 */
const counts = deriveCounts(
  readFileSync(SCALES_INDEX, 'utf8'),
  readFileSync(EXPORTERS_REGISTRY, 'utf8'),
);

describe('derived counts', () => {
  // The cross-check that makes the rest trustworthy. The tool reads the two
  // registry files with regexes so it stays runnable by bare `node` with no
  // install step, and a silently wrong derivation combined with its `write`
  // mode would rewrite eight public files to the wrong number.
  it('agrees with the registries as the app actually builds them', () => {
    expect(counts.registry).toBe(adapters.length);
    expect(counts.exporters).toBe(EXPORTER_REGISTRY.length);

    const generic = adapters.filter((a) => a instanceof StandardGattScaleAdapter).length;
    expect(generic).toBe(1);
    expect(counts.protocol).toBe(adapters.length - generic);
  });

  it('refuses to guess when the generic catch-all cannot be found exactly once', () => {
    // Without it the protocol count silently equals the registry count, and the
    // off-by-one would be written into every public page.
    expect(() => deriveCounts('new FooAdapter();\nnew BarAdapter();', 'schema: XSchema,')).toThrow(
      /exactly one StandardGattScaleAdapter/,
    );
  });

  it('counts the registry, the generic and the exporters from source text', () => {
    const scales = [
      'new FooAdapter(),',
      'new BarAdapter(),',
      'new StandardGattScaleAdapter(),',
    ].join('\n');
    const exporters = ['    schema: MqttSchema,', '    schema: GarminSchema,'].join('\n');
    expect(deriveCounts(scales, exporters)).toEqual({ registry: 3, protocol: 2, exporters: 2 });
  });
});

describe('published counts', () => {
  const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

  it.each(OCCURRENCES.map((o) => [`${o.file} (${o.label})`, o] as const))(
    '%s matches the code',
    (_name, occ: Occurrence) => {
      expect(checkText(read(occ.file), occ, counts)).toEqual([]);
    },
  );

  it('names the file, the line and which count when one drifts', () => {
    const occ = OCCURRENCES.find((o) => o.file === 'CONTRIBUTING.md')!;
    const text = `line one\nline two\n- something for all 99 adapters here\n`;
    expect(checkText(text, occ, counts)).toEqual([
      {
        file: 'CONTRIBUTING.md',
        label: occ.label,
        line: 3,
        which: 'protocol',
        expected: counts.protocol,
        found: 99,
      },
    ]);
  });

  it('fails loudly when a pattern stops matching, rather than skipping it', () => {
    // A silently skipped occurrence is the exact failure mode this guards
    // against, so a reworded sentence has to break the build.
    const occ = OCCURRENCES.find((o) => o.file === 'CONTRIBUTING.md')!;
    expect(() => checkText('nothing to see here', occ, counts)).toThrow(/matched 0 time/);
    expect(() => checkText('for all 1 adapters, for all 2 adapters', occ, counts)).toThrow(
      /matched 2 time/,
    );
  });
});

describe('rewriting', () => {
  it('keeps the literal text between two capture groups', () => {
    // Regression: rebuilding the match by joining its capture groups drops
    // every literal character between them, which turned the logo's `>35.11<`
    // into `>3511<` and `for all 35 adapters` into a bare `35`.
    const occ = OCCURRENCES.find((o) => o.file === 'docs/public/logo.svg')!;
    const svg = '<svg><text x="64" fill="#38bdf8">1.2</text></svg>';
    expect(applyText(svg, occ, { registry: 36, protocol: 35, exporters: 11 })).toBe(
      '<svg><text x="64" fill="#38bdf8">35.11</text></svg>',
    );
  });

  it('leaves the surrounding words alone in a prose occurrence', () => {
    const occ = OCCURRENCES.find((o) => o.file === 'CONTRIBUTING.md')!;
    const text = 'and `onConnected()` for all 99 adapters\n';
    expect(applyText(text, occ, counts)).toBe(
      `and \`onConnected()\` for all ${counts.protocol} adapters\n`,
    );
  });

  it('is a no-op on text that already agrees', () => {
    for (const occ of OCCURRENCES) {
      const original = readFileSync(path.join(REPO_ROOT, occ.file), 'utf8');
      expect(applyText(original, occ, counts)).toBe(original);
    }
  });
});
