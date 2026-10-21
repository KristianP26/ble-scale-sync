import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Type-contract files (`*.test-d.ts`) are checked, not executed.
     *
     * The root `tsc --noEmit` only covers `src`, so nothing else type-checks
     * `tests/`. This runs tsc over `src` plus every test file
     * (tsconfig.typecheck.json); an error outside a `-d` file is a source error
     * and fails the run like a failing test.
     */
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.typecheck.json',
      exclude: [...configDefaults.typecheck.exclude, '.claude/**'],
    },
    // Agent worktrees live under .claude/worktrees/, each with its own tests/ on
    // another commit; a run from the repo root must not collect them.
    exclude: [...configDefaults.exclude, '.claude/**'],
    env: {
      /**
       * Exporter retries wait between attempts (see src/utils/retry.ts). The
       * suite drives them against mocked fetch and MQTT clients, so there is
       * nothing to wait for and the real backoff would add roughly a minute
       * across the failure-path tests. A test that is ABOUT the backoff sets
       * its own delay through withRetry's options.
       */
      BLE_RETRY_BASE_DELAY_MS: '0',
    },
  },
});
