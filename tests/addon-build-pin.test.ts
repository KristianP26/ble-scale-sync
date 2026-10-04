import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Guard for the add-on base image pin (review I-03, the #318 trap).
 *
 * The Supervisor builds the add-on locally FROM the image named in build.yaml.
 * While that was the floating `:latest`, an add-on reporting version X could
 * wrap any application version: whatever `:latest` was at install time, which
 * right after a release is still the previous one. build.yaml now names the
 * exact release the add-on reports, and release-please moves both together.
 *
 * release-please itself is not a dependency here, so its Generic updater is
 * mirrored below (version scope only, anything else throws). Source:
 * googleapis/release-please, src/updaters/generic.ts.
 *
 * Line endings are normalized: Windows checkouts have core.autocrlf on.
 */
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

const BUILD_PATH = 'ble-scale-sync-addon/build.yaml';
const CONFIG_PATH = 'ble-scale-sync-addon/config.yaml';
const IMAGE = 'ghcr.io/kristianp26/ble-scale-sync';
const ARCHES = ['amd64', 'aarch64', 'armv7'];

const build = lf(readFileSync(resolve(BUILD_PATH), 'utf8'));
const config = lf(readFileSync(resolve(CONFIG_PATH), 'utf8'));
const rpConfig = JSON.parse(readFileSync(resolve('.release-please-config.json'), 'utf8')) as {
  packages: Record<string, { 'extra-files'?: Array<string | { type?: string; path: string }> }>;
};

// Same patterns as release-please's Generic updater. Not global on purpose:
// the updater replaces the FIRST semver-looking string on each line.
const VERSION_REGEX = /\d+\.\d+\.\d+(-[\w.]+)?(\+[-\w.]+)?/;
const INLINE_REGEX = /x-release-please-(major|minor|patch|version-date|version|date)/;
const BLOCK_START_REGEX = /x-release-please-start-(major|minor|patch|version-date|version|date)/;
const BLOCK_END_REGEX = /x-release-please-end/;

function genericUpdate(content: string, version: string): string {
  let inBlock = false;
  const onlyVersion = (scope: string): void => {
    if (scope !== 'version') throw new Error(`scope ${scope} is not mirrored by this test`);
  };
  return content
    .split('\n')
    .map((line) => {
      const inline = INLINE_REGEX.exec(line);
      if (inline) {
        onlyVersion(inline[1]);
        return line.replace(VERSION_REGEX, version);
      }
      if (inBlock) {
        if (BLOCK_END_REGEX.test(line)) inBlock = false;
        return line.replace(VERSION_REGEX, version);
      }
      const start = BLOCK_START_REGEX.exec(line);
      if (start) {
        onlyVersion(start[1]);
        inBlock = true;
      }
      return line;
    })
    .join('\n');
}

const reportedVersion = (yamlText: string): unknown =>
  (parse(yamlText) as { version?: unknown }).version;

const buildFrom = (yamlText: string): Record<string, unknown> =>
  (parse(yamlText) as { build_from: Record<string, unknown> }).build_from;

describe('add-on base image pin (I-03)', () => {
  it('builds every architecture FROM the release the add-on reports, not :latest', () => {
    const version = reportedVersion(config);
    expect(typeof version, `no version in ${CONFIG_PATH}`).toBe('string');
    const from = buildFrom(build);
    expect(Object.keys(from).sort()).toEqual([...ARCHES].sort());
    for (const arch of ARCHES) {
      expect(from[arch], `${BUILD_PATH} build_from.${arch}`).toBe(`${IMAGE}:${version}`);
    }
  });

  it('lets release-please rewrite build.yaml in the same package as the add-on config', () => {
    const extra = rpConfig.packages['.']?.['extra-files'] ?? [];
    const generic = (path: string): boolean =>
      extra.some((f) => typeof f === 'object' && f.type === 'generic' && f.path === path);
    // Both in the root package: release-please gives every extra file of a
    // package that package's next version, so the two cannot drift apart.
    expect(generic(CONFIG_PATH), `${CONFIG_PATH} missing from extra-files`).toBe(true);
    expect(generic(BUILD_PATH), `${BUILD_PATH} missing from extra-files`).toBe(true);
  });

  it('carries markers that move every pinned tag, and nothing else, to the next version', () => {
    const next = '98.76.54';
    const bumped = genericUpdate(build, next);
    for (const arch of ARCHES) {
      expect(buildFrom(bumped)[arch], `build_from.${arch} after a release`).toBe(
        `${IMAGE}:${next}`,
      );
    }
    // The only lines that change are the three image references.
    const before = build.split('\n');
    const changed = bumped.split('\n').filter((line, i) => line !== before[i]);
    expect(changed).toHaveLength(ARCHES.length);
    // The add-on config, run through the same updater, lands on the same version.
    expect(reportedVersion(genericUpdate(config, next))).toBe(next);
  });
});
