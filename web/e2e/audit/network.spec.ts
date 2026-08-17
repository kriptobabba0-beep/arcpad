import { expect, type Page, test } from '@playwright/test'
import { auditRoutes, openSearchWithKeyboard } from './routes'

/**
 * THE HOST SET, AND THE CSP THAT IS SUPPOSED TO ENFORCE IT.
 *
 * A launchpad is a page people arrive at holding money. One third-party script
 * on this origin can rewrite a transaction's `to` address between the quote
 * and the wallet prompt, and nothing on screen would look different. So the
 * rule is absolute: this origin loads nothing it does not serve, except the
 * configured RPC. The IPFS gateway used to be a third exception and is not
 * one any more — artwork is proxied through `/api/ipfs/…`, so no visitor's
 * browser talks to a gateway at all.
 *
 * THE CSP IS MEASURED, NOT READ. `next.config.ts` declaring a policy proves
 * nothing -- a policy with a typo in a directive name is silently ignored by
 * every browser. This spec asserts the header ARRIVES, that the browser
 * reported ZERO violations, and that the hosts actually contacted are inside
 * the set.
 */

type Seen = {
  readonly hosts: Set<string>
  readonly requests: string[]
  readonly cspViolations: string[]
}

function collect(page: Page): Seen {
  const hosts = new Set<string>()
  const requests: string[] = []
  const cspViolations: string[] = []

  page.on('request', (request) => {
    const url = request.url()
    requests.push(url)
    // `data:`, `blob:` and `about:` are not network. Treating them as hosts
    // would put "data" in the set and make the equality assertion meaningless.
    if (!/^https?:/i.test(url)) return
    hosts.add(new URL(url).host)
  })

  page.on('console', (message) => {
    const text = message.text()
    if (/Content Security Policy|Refused to (load|connect|execute|apply)/i.test(text)) {
      cspViolations.push(text)
    }
  })

  // The DOM-level report, which fires for violations the console format may
  // change on. Two independent detectors for one claim, because the console
  // string is a browser implementation detail and this one is specified.
  void page.addInitScript(() => {
    const bag: string[] = []
    ;(window as unknown as Record<string, unknown>).__cspViolations = bag
    document.addEventListener('securitypolicyviolation', (event) => {
      bag.push(`${event.violatedDirective} blocked ${event.blockedURI}`)
    })
  })

  return { hosts, requests, cspViolations }
}

/**
 * US AND THE RPC. NO GATEWAY.
 *
 * The gateway used to be in this set, and removing it is the assertion — not
 * a relaxation of one. Artwork is now fetched by `/api/ipfs/…` on the server,
 * so a browser on this site has no reason to contact a public IPFS gateway,
 * and if one ever does, that is a visitor's IP address being handed to a
 * third party on page load. This test is where we would find out.
 */
function allowedHosts(): Set<string> {
  const base = process.env.E2E_BASE_URL ?? ''
  const rpc = process.env.E2E_RPC_URL ?? ''
  expect(base, 'the global setup must publish E2E_BASE_URL').not.toBe('')
  expect(rpc, 'the global setup must publish E2E_RPC_URL').not.toBe('')
  return new Set([new URL(base).host, new URL(rpc).host])
}

test('every request on every route goes to us or the RPC — and nowhere else', async ({ page }) => {
  const seen = collect(page)
  const allowed = allowedHosts()

  for (const route of auditRoutes()) {
    const path = route.path()
    const response = await page.goto(path, { waitUntil: 'networkidle' })
    expect(response, `${path} must answer`).not.toBeNull()

    // THE HEADER MUST ARRIVE ON EVERY ROUTE, not just the first. `headers()`
    // in `next.config.ts` matches by source pattern, and a pattern that missed
    // a segment would leave exactly one route unprotected.
    const csp = response!.headers()['content-security-policy'] ?? ''
    expect(csp, `${path} must carry a CSP`).toContain("default-src 'self'")
    expect(csp, 'a launchpad has no reason to evaluate strings').not.toContain('unsafe-eval')
    expect(response!.headers()['x-content-type-options']).toBe('nosniff')
    expect(response!.headers()['referrer-policy']).toBe('no-referrer')
    expect(csp).toContain("frame-ancestors 'none'")

    if (route.openSearch === true) {
      await openSearchWithKeyboard(page)
      // Type, so the modal's own fetch happens and its host is counted.
      await page.getByRole('combobox').fill('e2e')
      await page.waitForTimeout(600)
    }
  }

  /*
   * ANTI-VACUITY, AND IT IS NOT DECORATION. "No third-party host" is trivially
   * true for a page that loaded nothing at all -- and this suite has already
   * seen a build serve an error page that made every containment assertion
   * pass. The count below is a floor on "a real application loaded".
   */
  expect(seen.requests.length, 'the collector must have seen a real page load').toBeGreaterThan(10)
  expect(seen.hosts.size, 'at least our own origin must appear').toBeGreaterThan(0)

  const strangers = [...seen.hosts].filter((host) => !allowed.has(host))
  expect(strangers, `third-party hosts contacted: ${strangers.join(', ')}`).toEqual([])
  expect(seen.hosts.has(new URL(process.env.E2E_BASE_URL!).host)).toBe(true)

  // NO FONT REQUEST LEAVES THIS ORIGIN. Task 6 self-hosts them; a font on a
  // third party leaks every visitor's IP to it on every page load.
  const fonts = seen.requests.filter((url) => /\.(woff2?|ttf|otf)(\?|$)/i.test(url))
  expect(fonts.length, 'the pages must actually load our fonts').toBeGreaterThan(0)
  for (const font of fonts) {
    expect(new URL(font).host).toBe(new URL(process.env.E2E_BASE_URL!).host)
  }

  const reported = (await page.evaluate(
    () => ((window as unknown as Record<string, unknown>).__cspViolations as string[]) ?? [],
  )) as string[]
  expect(seen.cspViolations, 'the console reported CSP violations').toEqual([])
  expect(reported, 'the document reported CSP violations').toEqual([])
})

/**
 * THE CONTROL. Without it, "zero CSP violations" is satisfied by a CSP that is
 * not being enforced at all -- which is exactly what a misspelled directive
 * produces, and exactly what nobody would notice.
 */
test('the CSP is ENFORCED: a script from another origin is refused', async ({ page }) => {
  const seen = collect(page)
  await page.goto('/')
  await page.evaluate(() => {
    const script = document.createElement('script')
    script.src = 'https://example.invalid/analytics.js'
    document.head.append(script)
  })
  await page.waitForTimeout(500)

  const reported = (await page.evaluate(
    () => ((window as unknown as Record<string, unknown>).__cspViolations as string[]) ?? [],
  )) as string[]
  expect(
    reported.length + seen.cspViolations.length,
    'injecting a third-party script must be blocked BY THE POLICY, not merely fail to resolve',
  ).toBeGreaterThan(0)
  expect(reported.join(' ') + seen.cspViolations.join(' ')).toMatch(/script-src|example\.invalid/)
})
