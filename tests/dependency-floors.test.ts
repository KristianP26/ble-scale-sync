import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimum versions of transitive dependencies that a fix depends on. The
 * lockfile pins what `npm ci` installs, so a regeneration that slides back to
 * an older copy fails here.
 *
 * `ws` comes in through mqtt (which allows older copies) and `tar` through the
 * optional native build chain of @abandonware/noble and node-ble, which still
 * asks for tar 6. The `overrides` in package.json hold both above their floor.
 * Remove the tar entry here together with its override.
 *
 * Only the root lockfile: worker/ has its own.
 */
const FLOORS: Record<string, string> = { ws: '8.21.0', tar: '7.5.19', zod: '4.6.6' };

/** Packages the project depends on directly: the range in package.json is the floor. */
const DIRECT: Record<string, string> = { zod: '^4.6.7' };

interface Lock {
  packages: Record<string, { version?: string }>;
}

const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8')) as Lock;
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};

/** Numeric compare of the major.minor.patch core; a pre-release tag is ignored. */
function atLeast(version: string, floor: string): boolean {
  const a = version.split('-')[0].split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function copiesOf(name: string): Array<[string, string]> {
  const suffix = `node_modules/${name}`;
  return Object.entries(lock.packages)
    .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
    .map(([path, entry]) => [path, entry.version ?? '']);
}

describe('dependency floors', () => {
  it('compares versions numerically', () => {
    expect(atLeast('8.21.0', '8.21.0')).toBe(true);
    expect(atLeast('8.23.0', '8.21.0')).toBe(true);
    expect(atLeast('8.9.0', '8.21.0')).toBe(false);
    expect(atLeast('6.2.1', '7.5.19')).toBe(false);
    expect(atLeast('7.10.0', '7.5.19')).toBe(true);
    expect(atLeast('9.0.0', '8.21.0')).toBe(true);
  });

  for (const [name, floor] of Object.entries(FLOORS)) {
    it(`every ${name} in the lockfile is ${floor} or newer`, () => {
      const copies = copiesOf(name);
      expect(copies.length, `no ${name} in package-lock.json`).toBeGreaterThan(0);
      for (const [path, version] of copies) {
        expect(atLeast(version, floor), `${path} is ${version}`).toBe(true);
      }
    });

    if (name in DIRECT) continue;
    it(`package.json keeps ${name} above ${floor} for a regenerated lockfile`, () => {
      expect(pkg.overrides?.[name]).toBe(`^${floor}`);
    });
  }

  // `npm i -g` and `npx` resolve by this range, not by the lockfile. A newer range
  // (a Dependabot bump) is fine; only a range that allows the old copy again is not.
  for (const [name, range] of Object.entries(DIRECT)) {
    it(`package.json asks for ${name} ${range} or newer`, () => {
      const asked = pkg.dependencies?.[name] ?? '';
      expect(asked, `${name} has no range in package.json`).toMatch(/^[\^~]?\d+\.\d+\.\d+$/);
      expect(atLeast(asked.replace(/^[\^~]/, ''), range.replace(/^[\^~]/, '')), asked).toBe(true);
    });
  }
});
