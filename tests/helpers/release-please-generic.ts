/**
 * Mirror of release-please's Generic updater for the pin guard tests (the
 * add-on base image and the compose example images). release-please itself is
 * not a dependency here, so the updater is copied below (version scope only,
 * anything else throws). Source: googleapis/release-please,
 * src/updaters/generic.ts.
 */

/** Line endings are normalized: Windows checkouts have core.autocrlf on. */
export const lf = (s: string): string => s.replace(/\r\n/g, '\n');

// Same patterns as release-please's Generic updater. Not global on purpose:
// the updater replaces the FIRST semver-looking string on each line.
const VERSION_REGEX = /\d+\.\d+\.\d+(-[\w.]+)?(\+[-\w.]+)?/;
const INLINE_REGEX = /x-release-please-(major|minor|patch|version-date|version|date)/;
const BLOCK_START_REGEX = /x-release-please-start-(major|minor|patch|version-date|version|date)/;
const BLOCK_END_REGEX = /x-release-please-end/;

export function genericUpdate(content: string, version: string): string {
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
