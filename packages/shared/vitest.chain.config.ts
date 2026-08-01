import { defineConfig } from 'vitest/config'

/**
 * THE DIFFERENTIAL RUN, ON ITS OWN.
 *
 * `test/chain/**` spawns `anvil` and deploys the compiled artifacts, so it
 * needs Foundry on PATH and `contracts/out/` present. `pnpm -r test` has to
 * stay runnable on a machine with neither, so these files are excluded from the
 * default config and get this one instead -- invoked by
 * `pnpm --filter @arcpad/shared test:chain`, which the `chain-differential` CI
 * job runs after `forge build`.
 *
 * A separate CONFIG, not a CLI path filter: vitest applies `exclude` to
 * positional filters too, so `vitest run test/chain/...` against the default
 * config would match nothing and exit green having run zero tests.
 *
 * The timeout is per FILE and generous: a run deploys four contracts and
 * executes several hundred transactions against a real EVM.
 */
export default defineConfig({
  test: {
    include: ['test/chain/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 300_000,
    // One anvil at a time. Two suites racing for ports is a class of flake
    // nobody should have to debug.
    fileParallelism: false,
  },
})
