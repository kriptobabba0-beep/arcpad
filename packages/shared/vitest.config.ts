import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `abi-parity` needs `contracts/out/`, i.e. Foundry. It runs through
    // `test:abi` / `vitest.abi.config.ts` in its own CI job; `abi-parity`'s own
    // selection-gap gate asserts that job exists.
    exclude: [...configDefaults.exclude, 'test/abi-parity.test.ts'],
  },
})
