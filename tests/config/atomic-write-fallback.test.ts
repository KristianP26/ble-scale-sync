import { describe, it, expect, afterEach, vi } from 'vitest';

// The Docker file-mount setup documented in the README cannot be renamed over
// (EBUSY), so atomicWrite takes its in-place branch. writeFileSync applies
// `mode` only when it CREATES the file, and that branch exists precisely
// because the file already exists - so without the explicit chmod the mode
// stays whatever the existing file had, which is the 0644 this whole fix is
// about.
//
// This lives in its own file because it has to mock node:fs at module scope.
// vi.spyOn(fs, 'renameSync') does NOT work here: the ESM module namespace is
// not configurable, so it throws "Cannot redefine property" on Linux. It threw
// only in CI, because the assertions are skipped on Windows.
let renameThrows: NodeJS.ErrnoException | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameThrows) throw renameThrows;
      return actual.renameSync(...args);
    },
  };
});

const { mkdtempSync, writeFileSync, statSync, rmSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { atomicWrite } = await import('../../src/config/write.js');

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bss-aw-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  renameThrows = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('atomicWrite in-place fallback', () => {
  it.skipIf(process.platform === 'win32')('chmods to 0600 when the rename is refused', () => {
    const dir = tempDir();
    const file = join(dir, 'config.yaml');
    writeFileSync(file, 'version: 1\n', { mode: 0o644 });

    const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
    err.code = 'EBUSY';
    renameThrows = err;

    atomicWrite(file, 'version: 1\nusers: []\n');

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('users: []');
  });

  it.skipIf(process.platform === 'win32')('removes the tmp file on the fallback path', () => {
    const dir = tempDir();
    const file = join(dir, 'config.yaml');
    writeFileSync(file, 'version: 1\n', { mode: 0o644 });

    const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
    err.code = 'EPERM';
    renameThrows = err;

    atomicWrite(file, 'version: 1\n');

    expect(() => statSync(file + '.tmp')).toThrow();
  });

  it('rethrows a rename failure it does not know how to fall back from', () => {
    const dir = tempDir();
    const file = join(dir, 'config.yaml');
    writeFileSync(file, 'version: 1\n');

    const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
    err.code = 'ENOSPC';
    renameThrows = err;

    expect(() => atomicWrite(file, 'version: 2\n')).toThrow(/ENOSPC/);
    // And the tmp file is cleaned up rather than left behind.
    expect(() => statSync(file + '.tmp')).toThrow();
  });
});
