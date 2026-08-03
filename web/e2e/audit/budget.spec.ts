import { gzipSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'
import { auditToken } from './routes'

/**
 * THE TWO BYTE BUDGETS -- MEASURED FROM WHAT THE BROWSER ACTUALLY DOWNLOADS.
 *
 * THE PLAN SAID `.next/app-build-manifest.json` AND THAT FILE DOES NOT EXIST.
 * Next 16.2 builds with Turbopack and emits no per-route client manifest:
 * `.next/` carries `build-manifest.json` (pages router only, one `/_app`
 * entry) and `app-path-routes-manifest.json` (route ids, no chunk lists).
 * Summing `.next/static/chunks` instead would produce ONE number for the whole
 * application and would satisfy a per-route budget without ever measuring a
 * route -- the vacuous shape this project has already shipped once.
 *
 * So the measurement moved to where the truth is: every script the browser
 * fetches while rendering the route, gzipped here with `zlib` rather than
 * trusted from a `content-length` (the dev server's compression settings are
 * not the budget, the bytes are).
 *
 * EVERY BUDGET PRINTS ITS CURRENT VALUE, PASS OR FAIL. A threshold that is
 * only visible when it breaks is a threshold that gets raised the first time
 * it breaks.
 */

const KB = 1024
const BUDGETS = {
  explore: 250 * KB,
  token: 300 * KB,
} as const

type Measured = { readonly gzipBytes: number; readonly files: number }

async function measureRouteJs(page: Page, path: string): Promise<Measured> {
  const bodies = new Map<string, Buffer>()

  const onResponse = async (response: import('@playwright/test').Response) => {
    const url = response.url()
    if (!/\.js(\?|$)/i.test(url)) return
    if (response.status() >= 400) return
    try {
      // `body()` is the DECODED payload, so gzipping it here is a stable
      // measurement rather than a reading of the server's compression config.
      bodies.set(url, await response.body())
    } catch {
      /* a redirect or a body already consumed; not a script we can weigh */
    }
  }

  page.on('response', (response) => void onResponse(response))
  await page.goto(path, { waitUntil: 'networkidle' })
  // Route-level lazy chunks arrive after `networkidle` fires on some runs.
  await page.waitForTimeout(1_000)
  page.removeAllListeners('response')

  let gzipBytes = 0
  for (const body of bodies.values()) gzipBytes += gzipSync(body).byteLength
  return { gzipBytes, files: bodies.size }
}

test('the Explore route ships under its JavaScript budget', async ({ page }) => {
  const measured = await measureRouteJs(page, '/')
  console.warn(
    `[budget] explore JS: ${(measured.gzipBytes / KB).toFixed(1)} kB gz across ` +
      `${measured.files} files (budget ${BUDGETS.explore / KB} kB)`,
  )
  // ANTI-VACUITY. Zero files means the collector missed everything, and
  // `0 <= 250kB` would pass for a page that shipped no application at all.
  expect(measured.files, 'no scripts were weighed — the measurement is empty').toBeGreaterThan(2)
  expect(
    measured.gzipBytes,
    `Explore ships ${(measured.gzipBytes / KB).toFixed(1)} kB gz, over the ${BUDGETS.explore / KB} kB budget`,
  ).toBeLessThanOrEqual(BUDGETS.explore)
})

test('the token route ships under its JavaScript budget', async ({ page }) => {
  const measured = await measureRouteJs(page, `/token/${auditToken()}`)
  console.warn(
    `[budget] token JS: ${(measured.gzipBytes / KB).toFixed(1)} kB gz across ` +
      `${measured.files} files (budget ${BUDGETS.token / KB} kB)`,
  )
  expect(measured.files, 'no scripts were weighed — the measurement is empty').toBeGreaterThan(2)
  expect(
    measured.gzipBytes,
    `the token page ships ${(measured.gzipBytes / KB).toFixed(1)} kB gz, over the ${BUDGETS.token / KB} kB budget`,
  ).toBeLessThanOrEqual(BUDGETS.token)
})

test('the token route is the heavier of the two — the control on the measurement itself', async ({
  page,
}) => {
  /*
   * WITHOUT THIS, both budgets are satisfied by a measurement that returns the
   * same number for every route -- which is exactly what a manifest-summing
   * implementation would have done. The token page carries the chart, the
   * trade panel, wagmi's connectors and the approval flow; Explore does not.
   * If the two ever measure equal, the measurement stopped being per-route.
   */
  const explore = await measureRouteJs(page, '/')
  const token = await measureRouteJs(page, `/token/${auditToken()}`)
  expect(
    token.gzipBytes,
    'the two routes measured the same bytes — the measurement is not per-route',
  ).not.toBe(explore.gzipBytes)
})
