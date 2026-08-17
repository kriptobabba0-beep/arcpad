import { dirname, join } from 'node:path'
import type { FullConfig } from '@playwright/test'

/**
 * THE WEB PACKAGE ROOT, AND WHERE THE RUN'S PROCESS IDS LIVE.
 *
 * NOT `config.rootDir`: Playwright computes that from the test directories, so
 * it is `web/e2e`, not `web`. Measured the hard way -- `next build` ran with
 * that as its working directory and failed with "Couldn't find any `pages` or
 * `app` directory", which is a confusing way to be told the path is wrong.
 *
 * NOT `import.meta.url` either: this package has no `"type": "module"` (a
 * Phase 0 carry-over that Phase 4 did not close), so Playwright transpiles
 * these files to CommonJS and `import.meta` is a syntax error there.
 *
 * The config file's own directory IS the web package root, by construction.
 */
export function webRoot(config: FullConfig): string {
  const configFile = config.configFile
  if (configFile === undefined) {
    throw new Error(
      'Playwright did not report a config file, so the web package root cannot be derived. ' +
        'Run the suite through web/playwright.config.ts.',
    )
  }
  return dirname(configFile)
}

export function statePath(webDir: string): string {
  return join(webDir, 'e2e', '.state.json')
}

export type E2EState = {
  readonly baseURL?: string
  readonly rpcUrl?: string
  readonly chainId?: number
  readonly factory?: string
  readonly escrow?: string
  /**
   * The token `deployArcpad` launches as part of the deployment.
   *
   * The audit project needs A TOKEN PAGE and must not depend on the chain
   * scenario having run first: Playwright projects are independent, and a
   * spec that only works when another project ran before it is a spec that
   * passes for a reason nobody wrote down.
   */
  readonly token?: string
  readonly curve?: string
  readonly serverPid: number | null
  /**
   * The SECOND server, started only when `DATABASE_URL` is present.
   *
   * Recorded separately rather than as a list because the teardown must be
   * able to kill each one independently: a teardown that stops on the first
   * failure leaves the other half of the pair alive, which is exactly how a
   * previous round left processes running for hours.
   */
  readonly dbBaseURL?: string
  readonly dbServerPid?: number | null
  readonly startedAt: string
}
