import { defineConfig, devices } from '@playwright/test'

/**
 * FOUR PROJECTS, THREE OF THEM GATES AND ONE OF THEM AN OPEN CELL.
 *
 *   local-chain  every PR. Anvil + a production build, NO DATABASE.
 *   local-db     every PR in CI. The same build against a Postgres service.
 *   audit        every PR. axe, keyboard, budgets, third-party requests.
 *   arc          Arc testnet. Measures the ONE thing anvil cannot: that the
 *                6-decimal ERC-20 view and the 18-decimal native view are two
 *                readings of one balance. Skipped without `E2E_ARC`, and the
 *                skip is REPORTED rather than silent.
 *
 * `forbidOnly` in CI, and retries are ZERO on purpose. A flaky end-to-end test
 * that passes on retry is a flaky application; hiding it behind a retry count
 * turns a real defect into a slow build.
 */
const CI = process.env.CI === 'true' || process.env.CI === '1'

export default defineConfig({
  testDir: './e2e',
  // The chain scenario is SEQUENTIAL BY CONSTRUCTION: step 4 asserts the
  // progress step 3 measured as zero. Parallel workers would interleave trades
  // on one curve and every reserve assertion would become a race.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: CI ? [['github'], ['list']] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
    // Third-party requests are ASSERTED to be zero (Task 16 step 4). Leaving
    // the default `serviceWorkers: 'allow'` would let a future service worker
    // answer from cache and make that assertion vacuous.
    serviceWorkers: 'block',
  },
  /*
   * EVERY `testMatch` IS ANCHORED AT `e2e/`, AND THE REASON IS EMBARRASSING
   * AND EXACT.
   *
   * `testMatch` is applied to the ABSOLUTE path, and this repository lives at
   * `D:\pumpfunforarc\`. An unanchored `/arc[\\/]/` therefore matched
   * `pumpfunfor|arc\|web\e2e\local\...` -- i.e. EVERY spec file -- so the Arc
   * project silently re-ran the entire local suite against the local server
   * and reported 112 passing tests where there are 56. A green run that is
   * twice the size it should be is the same class of defect as a gate that
   * matches a comment: the thing doing the matching was never looking at what
   * it claimed to guard. Measured, not reasoned about: the run said 112.
   */
  projects: [
    {
      name: 'local-chain',
      testMatch: /[\\/]e2e[\\/]local[\\/][^\\/]+\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'local-db',
      testMatch: /[\\/]e2e[\\/]db[\\/][^\\/]+\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'audit',
      testMatch: /[\\/]e2e[\\/]audit[\\/][^\\/]+\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'arc',
      testMatch: /[\\/]e2e[\\/]arc[\\/][^\\/]+\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
