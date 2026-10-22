import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { nodeVersionWarning, parseEnginesRange } from '../../src/runtime/node-version.js';

/**
 * Synthetic ranges keep these tests stable when engines.node moves; only the
 * guards at the end read the real package.json.
 */

const R = '^22.23.4 || ^24.22.1 || >=26.12.1';
const ALL = '22.23.4+, 24.22.1+ or 26.12.1+';

const older = (v: string, expects: string): string =>
  `Node.js ${v} is older than this release expects (${expects}); update Node.js`;
const unsupported = (v: string, use: string): string =>
  `Node.js ${v} is not supported by this release; use ${use}`;

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const pkg = createRequire(import.meta.url)('../../package.json') as {
  engines: { node: string };
};

describe('nodeVersionWarning', () => {
  it('stays silent on every version the range accepts', () => {
    for (const v of ['22.23.4', '22.99.0', '24.22.1', '26.12.1', '27.0.0', '28.1.0']) {
      expect(nodeVersionWarning(v, R), v).toBeUndefined();
    }
  });

  it('names the minimum of its own line when the version is older on that line', () => {
    expect(nodeVersionWarning('22.23.2', R)).toBe(older('22.23.2', '22.23.4+'));
    expect(nodeVersionWarning('22.9.9', R)).toBe(older('22.9.9', '22.23.4+'));
    expect(nodeVersionWarning('24.21.9', R)).toBe(older('24.21.9', '24.22.1+'));
    expect(nodeVersionWarning('26.12.0', R)).toBe(older('26.12.0', '26.12.1+'));
    expect(nodeVersionWarning('26.1.0', R)).toBe(older('26.1.0', '26.12.1+'));
  });

  it('lists every line when the version is older than all of them', () => {
    expect(nodeVersionWarning('20.19.5', R)).toBe(older('20.19.5', ALL));
    expect(nodeVersionWarning('21.7.3', R)).toBe(older('21.7.3', ALL));
  });

  it('calls an odd line between two supported lines unsupported, not older', () => {
    expect(nodeVersionWarning('23.11.0', R)).toBe(unsupported('23.11.0', ALL));
    expect(nodeVersionWarning('25.2.0', R)).toBe(unsupported('25.2.0', ALL));
  });

  it('gives no update advice above a range of ^ lines only', () => {
    expect(nodeVersionWarning('26.0.0', '^22.23.4 || ^24.22.1')).toBe(
      unsupported('26.0.0', '22.23.4+ or 24.22.1+'),
    );
  });

  it('handles a range of one line, and the upper end of ^', () => {
    expect(nodeVersionWarning('20.0.0', '>=22.23.4')).toBe(older('20.0.0', '22.23.4+'));
    expect(nodeVersionWarning('23.0.0', '^22.23.4')).toBe(unsupported('23.0.0', '22.23.4+'));
  });

  it('names the lowest minimum of the major, not the first one', () => {
    expect(nodeVersionWarning('22.20.0', '>=22.30.0 || ^22.23.4')).toBe(
      older('22.20.0', '22.23.4+'),
    );
  });

  it('stays silent on a range it does not fully read, and never throws', () => {
    const ranges: unknown[] = [
      '^22.23.4 || 23.x',
      '>=22.23.4 <23',
      '22.x',
      '~22.23.4',
      '>= 22.23.4',
      '>=v22.0.0',
      '^22 || >=26.12.1',
      '^0.1.2',
      '^22.23.4 ||',
      '',
      '*',
      undefined,
      null,
      42,
      {},
    ];
    for (const range of ranges) {
      expect(parseEnginesRange(range), String(range)).toBeUndefined();
      for (const v of ['23.1.0', '20.0.0']) {
        expect(nodeVersionWarning(v, range), `${v} vs ${String(range)}`).toBeUndefined();
      }
    }
  });

  it('judges a prerelease the way npm does, and is silent on non-semver versions', () => {
    expect(nodeVersionWarning('26.0.0-rc.1', R)).toBe(older('26.0.0-rc.1', '26.12.1+'));
    expect(nodeVersionWarning('22.23.4-pre', R)).toBe(older('22.23.4-pre', '22.23.4+'));
    expect(nodeVersionWarning('23.0.0-rc.1', R)).toBe(unsupported('23.0.0-rc.1', ALL));
    expect(nodeVersionWarning('20.0.0-pre', R)).toBe(older('20.0.0-pre', ALL));
    for (const v of ['22.23.5-pre', '24.30.0-rc.1', '27.0.0-nightly20261020abcdef1234']) {
      expect(nodeVersionWarning(v, R), v).toBeUndefined();
    }
    for (const v of [
      'v22.23.2',
      '22.23',
      '',
      '022.23.4',
      '22.23.2+build',
      '22.23.2-01',
      '22.23.2-',
      '1234567890123456.0.0',
    ]) {
      expect(nodeVersionWarning(v, R), v).toBeUndefined();
    }
  });
});

describe('engines.node guards', () => {
  it('the real engines.node is a range this module reads', () => {
    const lines = parseEnginesRange(pkg.engines.node);
    expect(
      lines,
      `engines.node "${pkg.engines.node}" is not a range src/runtime/node-version.ts reads`,
    ).toBeDefined();
    expect(lines!.length).toBeGreaterThanOrEqual(1);
  });

  it('no source file repeats a minimum version from engines.node', () => {
    const minima = (parseEnginesRange(pkg.engines.node) ?? []).map((l) => l.min.join('.'));
    expect(minima.length).toBeGreaterThanOrEqual(1);
    const files = readdirSync(SRC, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.ts'))
      .map((d) => join(d.parentPath, d.name));
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const min of minima) {
        const re = new RegExp(`(?<![\\d.])${min.replace(/\./g, '\\.')}(?!\\.?\\d)`);
        if (re.test(text)) hits.push(`${file} names ${min}`);
      }
    }
    expect(hits, 'read it from package.json engines instead').toEqual([]);
  });
});
