import { describe, it, expect, vi } from 'vitest';
import { freshAdapter, loadFixtures, replaySession } from '../helpers/replay/session.js';

/**
 * Session goldens (D074): every trace a module under tests/fixtures/ exports
 * as `session` goes through the real waitForRawReading, and what came out
 * (writes, subscribes, reading, history, payload, when and how it settled) is
 * pinned in golden/sessions/<family>/<trace>.json.
 *
 * Rule: a refactor commit never changes a file under tests/golden/. A golden
 * that has to change goes in a commit of its own that says why
 * (`npx vitest run tests/golden -u` writes it; review the diff).
 */

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

for (const f of await loadFixtures()) {
  describe(`${f.family}: ${f.adapter}`, () => {
    for (const [name, trace] of Object.entries(f.traces)) {
      it(`${name} (${trace.provenance}: ${trace.source})`, async () => {
        const result = await replaySession(freshAdapter(f), trace, f);
        await expect(JSON.stringify(result, null, 2) + '\n').toMatchFileSnapshot(
          `./sessions/${f.family}/${name}.json`,
        );
      });
    }
  });
}
