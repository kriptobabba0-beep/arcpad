import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ==========================================================================
 *  THE COMPOSED PAGE, NOT THE COMPONENTS. THIS IS THE GATE THAT KEEPS FAILING.
 * ==========================================================================
 *
 * A COMPONENT THAT NOTHING RENDERS IS NOT A FEATURE, and this package has
 * shipped that exact shape six times with every component test green:
 * `TradePanel` written and drawn by no page, `CurveChart`'s realised layer, the
 * two missing `loadMore*` props, the `graduated` field the page did not pass,
 * two switch controls on one composed screen, and the same false sentence
 * living in two components -- the last two inside two days.
 *
 * So the assertions here are about the PAGE: how many call sites there are,
 * what each one passes, and -- the half that keeps being missed -- that the two
 * branches agree. The token page has TWO branches (the indexer row and the
 * chain-drawn fallback), and the chain-drawn one is what a user sees when the
 * indexer is DOWN, which is exactly when they most need trading to work.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..')
const RAW = readFileSync(join(WEB, 'app', 'token', '[address]', 'page.tsx'), 'utf8')

/**
 * COMMENTS ARE STRIPPED, AND THAT IS NOT TIDINESS.
 *
 * MEASURED while writing this file: the page's own comment explains that
 * `TradeSurface` replaced a direct `<TradePanel>`, and the naive matcher counted
 * that sentence as a call site -- so "the page renders TradePanel never" failed
 * against a page that renders it never. A gate that reads prose as code reports
 * the opposite of the truth in whichever direction the prose happens to point.
 */
const PAGE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function uses(tag: string): string[] {
  return [...PAGE.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?/>`, 'g'))].map((m) => m[0])
}

describe('the venue choice is made in ONE component, rendered by BOTH branches', () => {
  it('the page renders TradeSurface twice and TradePanel never', () => {
    /*
     * BEFORE THIS, a graduated token had NO trading surface at all: the curve
     * panel correctly renders nothing once the curve is complete, and no page
     * drew a pool panel. The first token to graduate would have had a live
     * Uniswap v4 pool that no wallet on earth could reach -- v4 gives an EOA no
     * swap entrypoint and Arc has no Universal Router.
     */
    expect(uses('TradeSurface')).toHaveLength(2)
    expect(uses('TradePanel')).toHaveLength(0)
    expect(uses('PoolTradePanel')).toHaveLength(0)
  })

  it('both call sites pass the lifecycle and the token', () => {
    for (const use of uses('TradeSurface')) {
      expect(use, `a TradeSurface without a lifecycle: ${use}`).toMatch(/lifecycle=\{/)
      expect(use, `a TradeSurface without a token: ${use}`).toMatch(/token=\{/)
      expect(use, `a TradeSurface without a symbol: ${use}`).toMatch(/symbol=\{/)
    }
  })

  it('the panel is no longer hidden when the CURVE profile read fails', () => {
    // `profile === null ? null : <TradePanel/>` cost a graduated token its only
    // trading surface for a read it does not use.
    expect(PAGE).not.toMatch(/profile === null \? null : \(?\s*<Trade/)
  })
})

describe('the chart choice is made in ONE component, rendered by BOTH branches', () => {
  it('the page renders TokenPriceChart twice and CurveChart never', () => {
    expect(uses('TokenPriceChart')).toHaveLength(2)
    expect(uses('CurveChart')).toHaveLength(0)
    expect(uses('PriceHistoryChart')).toHaveLength(0)
  })

  it('both call sites pass the lifecycle -- without it the chart cannot switch', () => {
    for (const use of uses('TokenPriceChart')) {
      expect(use, `a TokenPriceChart without a lifecycle: ${use}`).toMatch(/lifecycle=\{/)
    }
  })

  it('the indexed branch passes the trades, and the venue is NOT a prop', () => {
    /*
     * THIS ASSERTION USED TO DEMAND A SECOND PROP, and the change is the point.
     *
     * It read: "`trades` without `graduatedSeq` draws pool rows on the bonding
     * curve's own axis, which is a visual lie". True at the time -- the venue
     * was a prop, and a prop is a thing a call site can forget. `listTrades`
     * now selects `source`, so the venue travels ON the row and the only thing
     * this branch still has to pass is the rows themselves. The two call sites
     * still differ: the chain-drawn branch has no trade history at all.
     */
    const indexed = uses('TokenPriceChart').filter((use) => /trades=\{/.test(use))
    expect(indexed).toHaveLength(1)
    expect(
      PAGE,
      'the venue is back to being a prop -- see components/token/venue.ts for why it is not',
    ).not.toMatch(/graduatedSeq=\{/)
  })
})

describe('the trade list can tell the two venues apart', () => {
  it('TableTabs is handed the TRADES -- the venue rides on the rows', () => {
    /*
     * The old shape of this test demanded `graduatedSeq: overview.graduatedSeq`
     * in the overview literal, because the seam was a value the page had to
     * remember to pass down two hops. It is not passed any more and must not
     * be: `trades.source` is on every row. What remains load-bearing is that
     * the page hands over the trade page at all.
     */
    const use = PAGE.slice(
      PAGE.indexOf('<TableTabs'),
      PAGE.indexOf('</div>', PAGE.indexOf('<TableTabs')),
    )
    expect(use).toMatch(/trades=\{trades\}/)
    expect(use).not.toMatch(/graduatedSeq/)
  })

  it('and it still gets the three fields it already had', () => {
    const use = PAGE.slice(
      PAGE.indexOf('<TableTabs'),
      PAGE.indexOf('</div>', PAGE.indexOf('<TableTabs')),
    )
    for (const field of ['curve:', 'launchCreator:', 'symbol:']) {
      expect(use, `TableTabs lost ${field}`).toContain(field)
    }
    expect(use).toMatch(/loadMoreTrades=\{/)
    expect(use).toMatch(/loadMoreHolders=\{/)
  })
})

describe('ANTI-VACUITY: the scan really reads this page', () => {
  it('the matcher finds components that are certainly there', () => {
    // If `uses()` were broken every assertion above would pass by finding
    // nothing, which is the shape of a gate that measures itself.
    expect(uses('StatRow').length).toBeGreaterThanOrEqual(2)
    expect(uses('LifecycleNotice').length).toBe(2)
    expect(PAGE).toContain('resolveLifecycle')
  })

  it('the page still resolves a lifecycle on BOTH branches', () => {
    expect([...PAGE.matchAll(/resolveLifecycle\(/g)]).toHaveLength(2)
    // And `graduated` is passed at both -- the field whose absence made the
    // whole graduated branch unreachable once already.
    expect([...PAGE.matchAll(/graduated:/g)].length).toBeGreaterThanOrEqual(2)
  })
})
