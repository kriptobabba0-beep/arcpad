import { defineConfig, devices } from '@playwright/test'

/**
 * THE ARC LEG, WITH ITS OWN SETUP -- AND WITH ZERO LINES CHANGED IN THE OTHER
 * THREE.
 *
 * `playwright.config.ts` runs `e2e/global-setup.ts` for EVERY project: it starts
 * anvil, writes a devchain env file, builds the app against that devchain and
 * starts it. The Arc spec needs the opposite -- an app built against Arc testnet
 * -- and reads its URL from `E2E_ARC_BASE_URL`, which nothing ever set. So
 * `--project=arc` supplied exactly the wrong app and none of the right one, and
 * all five Arc tests skipped on every invocation. Measured 2026-08-09, before
 * this file existed: `1 passed, 5 skipped (37.6s)`, of which the 37.6s was an
 * anvil and a devchain build that the leg then did not use.
 *
 * WHY A SECOND CONFIG RATHER THAN A BRANCH IN `global-setup.ts`. That file is
 * shared by `local-chain`, `local-db` and `audit`, and its own comments record
 * an incident where an unanchored `testMatch` made the Arc project silently
 * re-run the whole local suite and report 112 passing tests where there are 56.
 * A branch would have to know which projects were SELECTED -- and
 * `FullConfig.projects` is not filtered by `--project`. MEASURED with a
 * throwaway three-project config: `--project=beta` ran exactly one test and
 * still handed `globalSetup` `["alpha","beta","gamma"]`. The branch would have
 * been keyed on a value that cannot distinguish the cases. A separate config
 * needs no such signal, and "the other legs are unchanged" stops being an
 * argument and becomes a diff of zero lines.
 *
 * `playwright.config.ts` KEEPS its `arc` project. A bare `playwright test` there
 * still runs the spec's self-report and still skips the five, which is the right
 * behaviour for a devchain run: the OPEN CELL is the point.
 */
const CI = process.env.CI === 'true' || process.env.CI === '1'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  // ZERO RETRIES, as in the shared config. A flaky end-to-end test that passes
  // on retry is a flaky application, and against a live chain the temptation to
  // paper over a real timing defect is strongest.
  retries: 0,
  // Longer than the shared config's 90s: every step here crosses the public
  // internet to a real chain, where the shared config's steps cross a loopback
  // socket to an anvil. The tests are the same shape; the round trips are not.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: CI ? [['github'], ['list']] : [['list']],
  globalSetup: './e2e/arc-global-setup.ts',
  globalTeardown: './e2e/arc-global-teardown.ts',
  use: {
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      /*
       * ANCHORED AT `e2e/arc/`, AND THE REASON IS COPIED FROM THE SHARED CONFIG
       * BECAUSE IT IS STILL TRUE HERE. `testMatch` runs against the ABSOLUTE
       * path and this repository lives at `D:\pumpfunforarc\`, so an unanchored
       * `/arc[\\/]/` matches `pumpfunfor|arc\|web\e2e\local\...` -- every spec
       * file in the suite. That is exactly how a green run once reported 112
       * passing tests where there are 56.
       */
      name: 'arc',
      testMatch: /[\\/]e2e[\\/]arc[\\/][^\\/]+\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
