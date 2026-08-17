import { defineConfig } from 'vitest/config'

/**
 * THE PARITY RUN, ON ITS OWN.
 *
 * `test/abi-parity.test.ts` needs `contracts/out/`, which needs Foundry.
 * `pnpm -r test` has to stay runnable on a machine that has no Solidity
 * toolchain, so the file is excluded from the default config and gets this one
 * instead -- invoked by `pnpm --filter @arcpad/shared test:abi`, which the
 * `abi-parity` CI job runs after `forge build`.
 *
 * A separate CONFIG, not a CLI filename filter: vitest applies `exclude` to
 * positional filters too, so `vitest run test/abi-parity.test.ts` against the
 * default config would match nothing and exit green having run zero tests.
 */
export default defineConfig({
  test: {
    include: ['test/abi-parity.test.ts'],
  },
})
