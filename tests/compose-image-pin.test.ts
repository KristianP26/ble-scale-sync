import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { genericUpdate, lf } from './helpers/release-please-generic.js';

/**
 * Guard for the image tag of the compose examples.
 *
 * A compose file on `:latest` follows whatever the registry serves at the next
 * pull, so a user who copied the example got new code without having asked for
 * it. Both examples now name the release they were published with, and
 * release-please moves the tag with every release (generic updater, the
 * marker at the end of the image line), the same way it moves the add-on pin
 * (tests/addon-build-pin.test.ts). The one-off `docker run --rm` commands in
 * the docs stay on `:latest` on purpose.
 *
 * The generic updater is mirrored in tests/helpers/release-please-generic.ts.
 */
const IMAGE = 'ghcr.io/kristianp26/ble-scale-sync';
const COMPOSE_FILES = ['docker-compose.example.yml', 'docker-compose.mqtt-proxy.yml'];

const read = (path: string): string => lf(readFileSync(resolve(path), 'utf8'));

const pkgVersion = (JSON.parse(read('package.json')) as { version: string }).version;
const manifestVersion = (
  JSON.parse(read('.release-please-manifest.json')) as Record<string, string>
)['.'];
const rpConfig = JSON.parse(read('.release-please-config.json')) as {
  packages: Record<string, { 'extra-files'?: Array<string | { type?: string; path: string }> }>;
};

const imageOf = (yamlText: string): unknown =>
  (parse(yamlText) as { services: Record<string, { image?: unknown }> }).services['ble-scale-sync']
    ?.image;

describe('compose example image pin', () => {
  it.each(COMPOSE_FILES)('%s names the release of package.json, not :latest', (path) => {
    expect(imageOf(read(path))).toBe(`${IMAGE}:${pkgVersion}`);
  });

  it('keeps package.json in step with the release-please manifest', () => {
    expect(manifestVersion).toBe(pkgVersion);
  });

  it('lets release-please rewrite both files in the root package', () => {
    const extra = rpConfig.packages['.']?.['extra-files'] ?? [];
    for (const path of COMPOSE_FILES) {
      const registered = extra.some(
        (f) => typeof f === 'object' && f.type === 'generic' && f.path === path,
      );
      expect(registered, `${path} missing from extra-files`).toBe(true);
    }
  });

  it.each(COMPOSE_FILES)('%s: a release moves the tag and changes nothing else', (path) => {
    const next = '98.76.54';
    const before = read(path);
    const bumped = genericUpdate(before, next);
    expect(imageOf(bumped)).toBe(`${IMAGE}:${next}`);
    const was = before.split('\n');
    const changed = bumped.split('\n').filter((line, i) => line !== was[i]);
    expect(changed).toHaveLength(1);
  });
});
