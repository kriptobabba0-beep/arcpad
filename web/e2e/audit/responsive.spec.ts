import { expect, type Page, test } from '@playwright/test'
import { ARC_TESTNET_CHAIN_ID, getArcChain } from '@arcpad/shared/browser'
import { auditRoutes, auditToken, VIEWPORTS } from './routes'

/**
 * THE RESPONSIVE MATRIX -- BEHAVIOUR, NOT SCREENSHOTS.
 *
 * A screenshot comparison tells you a page changed; it does not tell you the
 * page is wrong, and it goes red for a font hinting difference. These are
 * claims about what the layout MEANS: on a phone the intent is to trade, so
 * the panel comes first; a table that keeps its columns at 375px is a table
 * nobody can read.
 *
 * NO HORIZONTAL SCROLL, ON EVERY ROUTE AT EVERY WIDTH. One overflowing element
 * makes an entire page unusable on a phone and is invisible on a desktop --
 * which is precisely why it survives review.
 */

async function scrollWidths(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
  })
}

for (const viewport of VIEWPORTS) {
  for (const route of auditRoutes()) {
    test(`${route.name} does not scroll sideways at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(route.path(), { waitUntil: 'networkidle' })
      if (route.openSearch === true) {
        await page.keyboard.press('ControlOrMeta+k')
        await expect(page.getByRole('dialog')).toBeVisible()
      }

      const { scrollWidth, clientWidth } = await scrollWidths(page)
      // ANTI-VACUITY: a page that never laid out reports 0 for both and would
      // satisfy the equality.
      expect(clientWidth, 'the page must have laid out').toBeGreaterThan(0)

      /*
       * THE FAILURE NAMES THE CULPRIT.
       *
       * "The page is 7px too wide" is a true statement nobody can act on; on a
       * page with two hundred elements it costs an hour of bisecting. The
       * offenders are collected here so the message points at the element, and
       * the collection only runs when the assertion is about to fail.
       */
      let culprits = ''
      if (scrollWidth > clientWidth) {
        culprits = await page.evaluate((width) => {
          const out: string[] = []
          for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
            const box = element.getBoundingClientRect()
            if (box.right <= width + 0.5 || box.width === 0) continue
            const id = element.getAttribute('data-testid') ?? element.getAttribute('aria-label')
            out.push(
              `${element.tagName.toLowerCase()}${id === null ? '' : `[${id}]`}` +
                `.${(element.className || '').toString().split(' ').slice(0, 4).join('.')} ` +
                `right=${Math.round(box.right)}`,
            )
          }
          // Deepest first: the innermost overflowing node is the cause, its
          // ancestors are only carrying it.
          return out.slice(-12).join('\n')
        }, clientWidth)
      }

      expect(
        scrollWidth,
        `${route.name} overflows by ${scrollWidth - clientWidth}px at ${viewport.width}px.\n` +
          `elements past the right edge:\n${culprits}`,
      ).toBe(clientWidth)
    })
  }
}

test('at 375px the token page is one column and the TRADE PANEL COMES FIRST', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await page.goto(`/token/${auditToken()}`)

  const panel = page.getByTestId('trade-panel')
  const chart = page.getByTestId('curve-chart')
  await expect(panel).toBeVisible()
  await expect(chart).toBeVisible()

  const panelBox = await panel.boundingBox()
  const chartBox = await chart.boundingBox()
  expect(panelBox, 'the panel must have a box').not.toBeNull()
  expect(chartBox, 'the chart must have a box').not.toBeNull()

  /*
   * ONE COLUMN, EXPRESSED AS "THE BOXES DO NOT SHARE A ROW".
   *
   * Comparing `x` was the first version and it was WRONG: the chart sits
   * inside a `Card` with 16px of padding, so a perfectly stacked layout
   * reported a 17px difference and the assertion failed on a correct page.
   * Vertical disjointness is the property that actually means "one column",
   * and it says the ordering claim at the same time.
   */
  expect(
    panelBox!.y + panelBox!.height,
    'on a phone the panel must sit ENTIRELY above the chart: one column, panel first',
  ).toBeLessThanOrEqual(chartBox!.y + 1)
})

test('at 1440px the token page puts the panel BESIDE the chart -- the control for the phone case', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/token/${auditToken()}`)

  const panelBox = await page.getByTestId('trade-panel').boundingBox()
  const chartBox = await page.getByTestId('curve-chart').boundingBox()
  expect(panelBox).not.toBeNull()
  expect(chartBox).not.toBeNull()
  /*
   * WITHOUT THIS CONTROL the phone assertion is satisfied by a layout that is
   * single-column at EVERY width -- i.e. by a page with no responsive
   * behaviour at all. Two assertions, one on each side of the breakpoint, are
   * what make either of them mean something.
   */
  expect(panelBox!.x, 'on a desktop the panel sits in the right column').toBeGreaterThan(
    chartBox!.x + chartBox!.width - 1,
  )
  // And they SHARE A ROW, which is the exact negation of the phone claim.
  const sharesRow =
    panelBox!.y < chartBox!.y + chartBox!.height && chartBox!.y < panelBox!.y + panelBox!.height
  expect(sharesRow, 'a desktop layout puts them side by side, not stacked').toBe(true)
})

/**
 * =========================================================================
 *  THE ONE ACCESSIBILITY FIX A BROWSER FOUND AND NOTHING GUARDS.
 * =========================================================================
 *
 * `track-6-review.md` backlog 1, and `MAINNET-READINESS.md` §2.13: reverting
 * `Header.tsx` to a `<Pill className="hidden sm:inline-flex">` -- the version
 * that DID NOT HIDE at 390px -- leaves the entire component project green.
 * The current code hides the pill on a WRAPPER instead, with a comment saying
 * why, and a comment is not a gate.
 *
 * THE ROOT CAUSE IS GENERAL AND WILL RECUR. `cx` concatenates; it does not
 * merge Tailwind conflicts. `hidden` and `Pill`'s base `inline-flex` set the
 * SAME property, so which one wins is decided by Tailwind's EMISSION ORDER,
 * not by the order they were written in. A caller's class therefore does not
 * reliably beat a component's -- and jsdom cannot see it, because jsdom does
 * not resolve a stylesheet's cascade.
 *
 * BOTH HALVES ARE REQUIRED AND THE DESKTOP ONE IS NOT DECORATION. An element
 * that does not exist is `toBeHidden()`, so the phone assertion alone is
 * satisfied by DELETING the pill -- and by the mutant that removes the
 * wrapper, whose locator would then find nothing. The desktop assertion is
 * what makes the phone assertion mean something.
 */
test('the network pill is hidden at 375px and PRESENT at 1440px -- the mutant that survived', async ({
  page,
}) => {
  // The name comes from the registry the app itself reads, so a renamed chain
  // cannot leave this test asserting against a string nothing renders.
  const chainName = getArcChain(ARC_TESTNET_CHAIN_ID).name
  const pill = page.getByRole('banner').getByText(chainName, { exact: true })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(pill, 'the desktop header must show which network this is').toBeVisible()

  await page.setViewportSize({ width: 375, height: 667 })
  await expect(
    pill,
    'at 375px the pill must be hidden -- `hidden` on the Pill itself did not hide it, ' +
      'because `cx` concatenates and Tailwind decides by emission order',
  ).toBeHidden()
})
