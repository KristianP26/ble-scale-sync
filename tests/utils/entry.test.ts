import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../../src/utils/entry.js';

/**
 * The entry guard of src/run.ts. node hands the main module its realpath as
 * import.meta.url while argv[1] keeps the symlinked path, so `node
 * <link>/dist/run.js` has to match too. 'junction' makes the directory link
 * work on Windows without Developer Mode; POSIX ignores the type.
 */
describe('isMainModule()', () => {
  let dir = '';
  let real = '';
  let link = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'entry-'));
    real = join(dir, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'run.js'), '');
    writeFileSync(join(real, 'other.js'), '');
    link = join(dir, 'link');
    symlinkSync(real, link, 'junction');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const url = () => pathToFileURL(join(real, 'run.js')).href;

  it('matches argv[1] given as the real path', () => {
    expect(isMainModule(url(), join(real, 'run.js'))).toBe(true);
  });

  it('matches argv[1] given through a symlinked directory', () => {
    expect(isMainModule(url(), join(link, 'run.js'))).toBe(true);
  });

  it('does not match another script', () => {
    expect(isMainModule(url(), join(link, 'other.js'))).toBe(false);
  });

  it('is false without argv[1] and does not throw on a path that does not exist', () => {
    expect(isMainModule(url(), undefined)).toBe(false);
    expect(isMainModule(url(), join(dir, 'missing.js'))).toBe(false);
  });
});
