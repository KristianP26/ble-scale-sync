import { describe, it, expect, vi } from 'vitest';
import { loadAdvertFixtures, replayAdverts } from '../helpers/replay/broadcast.js';

/**
 * Advertisement goldens (D074): every trace a module under tests/fixtures/
 * exports as `adverts` goes through the registry, evaluateAdvertisement and
 * the proxy watchers' grace and dedup windows, and what came out per advert
 * (decision, live weight, reading, what the watcher did with it, warnings) and
 * what reached the queue is pinned in golden/adverts/<family>/<trace>.json.
 *
 * Rule: a refactor commit never changes a file under tests/golden/. A golden
 * that has to change goes in a commit of its own that says why
 * (`npx vitest run tests/golden -u` writes it; review the diff).
 */

vi.spyOn(console, 'log').mockImplementation(() => {});

for (const f of await loadAdvertFixtures()) {
  describe(`${f.family}: ${f.adapter}`, () => {
    for (const [name, trace] of Object.entries(f.traces)) {
      it(`${name} (${trace.provenance}: ${trace.source})`, async () => {
        const result = replayAdverts(f, trace);
        await expect(JSON.stringify(result, null, 2) + '\n').toMatchFileSnapshot(
          `./adverts/${f.family}/${name}.json`,
        );
      });
    }
  });
}
