import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { loadAdvertFixtures } from '../helpers/replay/broadcast.js';
import { loadFixtures } from '../helpers/replay/session.js';

/**
 * toMatchFileSnapshot writes a golden but never deletes one, so a trace that
 * is renamed or dropped leaves its old golden behind, still looking pinned.
 * The files under golden/sessions/ and golden/adverts/ must be exactly the
 * traces the loaders return.
 */

const here = fileURLToPath(new URL('.', import.meta.url));

function filesUnder(kind: 'sessions' | 'adverts'): string[] {
  return readdirSync(join(here, kind), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(here, join(d.parentPath, d.name)).split(sep).join('/'))
    .sort();
}

describe('golden inventory', () => {
  it('golden/sessions/ holds one file per session trace and nothing else', async () => {
    const traces = (await loadFixtures()).flatMap((f) =>
      Object.keys(f.traces).map((name) => `sessions/${f.family}/${name}.json`),
    );
    expect(filesUnder('sessions')).toEqual(traces.sort());
  });

  it('golden/adverts/ holds one file per advert trace and nothing else', async () => {
    const traces = (await loadAdvertFixtures()).flatMap((f) =>
      Object.keys(f.traces).map((name) => `adverts/${f.family}/${name}.json`),
    );
    expect(filesUnder('adverts')).toEqual(traces.sort());
  });
});
