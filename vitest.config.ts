import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Type-contract files (`*.test-d.ts`) are checked, not executed.
     *
     * The root `tsc --noEmit` only covers `src`, so a `@ts-expect-error` under
     * `tests/` was never verified by CI - it could go stale in silence, which is
     * the exact failure those assertions exist to catch. This runs tsc over
     * `src` plus the `-d` files; see tsconfig.typecheck.json for why it is not
     * pointed at the whole test tree.
     */
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.typecheck.json',
    },
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
