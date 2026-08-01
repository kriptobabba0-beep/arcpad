import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `abi-parity` needs `contracts/out/`, i.e. Foundry. It runs through
    // `test:abi` / `vitest.abi.config.ts` in its own CI job; `abi-parity`'s own
    // selection-gap gate asserts that job exists.
    exclude: [
      ...configDefaults.exclude,
      'test/abi-parity.test.ts',
      // `test/chain/**` spawns anvil and deploys the compiled artifacts. It
      // runs through `test:chain` / `vitest.chain.config.ts` in its own CI
      // job; the selection-gap gate in `abi-parity.test.ts` asserts BOTH jobs
      // exist, and a second gate asserts this exclusion is here.
      'test/chain/**',
    ],
  },
})
