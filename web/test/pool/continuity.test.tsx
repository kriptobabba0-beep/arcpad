import { priceWeiPerToken } from '@arcpad/shared/browser'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CurveChart, realisedSeries } from '@/components/token/CurveChart'
import {
  PriceHistoryChart,
  priceSeries,
  TokenPriceChart,
} from '@/components/token/PriceHistoryChart'
import { TableTabs } from '@/components/token/TableTabs'
import { TradesTable, feeSentence } from '@/components/token/TradesTable'
import { resolveLifecycle } from '@/components/token/lifecycle'
import {
  CURVE_CLOSE,
  CURVE_EARLY,
  GRADUATED_SEQ,
  MIXED_HISTORY,
  POOL_FIRST,
  POOL_SECOND,
} from './fixtures'
import { ok } from '../fixtures/readModel'

const PROFILE = {
  virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReserves: 4_292n * 10n ** 15n,
  saleSupply: 793_100_000n * 10n ** 18n,
}

/**
 * ============ ONE HISTORY, TWO VENUES -- MEASURED IN THE DOM ============
 *
 * The pure series functions are asserted here rather than in the node project
 * because they live in `.tsx` modules, which the node project cannot even
 * import. That is not an inconvenience: it means the same file that draws the
 * chart is the one under test, so a series that is right and a chart that
 * ignores it cannot both pass.
 */

describe('the realised series and the curve chart', () => {
  it('realisedSeries drops pool rows once graduatedSeq is known', () => {
    expect(realisedSeries(MIXED_HISTORY, GRADUATED_SEQ).map((p) => p.seq)).toEqual([
      CURVE_EARLY.eventSeq,
      CURVE_CLOSE.eventSeq,
    ])
  })

  it('CONTROL: without graduatedSeq every row is drawn -- the old behaviour', () => {
    // Without this the filter could be "drop everything" and the assertion
    // above would still pass.
    expect(realisedSeries(MIXED_HISTORY).map((p) => p.seq)).toEqual([
      CURVE_EARLY.eventSeq,
      CURVE_CLOSE.eventSeq,
      POOL_FIRST.eventSeq,
      POOL_SECOND.eventSeq,
    ])
  })

  it('the drawn curve says "2 recent trades", not 4, once the seam is known', () => {
    // The number in the summary is the number of points DRAWN. A chart that
    // filtered its data but not its caption would claim four.
    const { container } = render(
      <CurveChart
        profile={PROFILE}
        soldTok={PROFILE.saleSupply}
        currentPriceWei={58_783_256_052n}
        trades={MIXED_HISTORY}
        graduatedSeq={GRADUATED_SEQ}
        progressPercent="100.0"
      />,
    )
    const svg = within(container).getByTestId('curve-chart')
    expect(svg.getAttribute('aria-label')).toContain('2 recent trades drawn')
  })
})

describe('the price history is ONE series across both venues', () => {
  it('oldest first, one point per block, venue attached', () => {
    const points = priceSeries(MIXED_HISTORY, GRADUATED_SEQ)
    expect(points.map((p) => p.block)).toEqual([40, 60, 61, 62])
    expect(points.map((p) => p.venue)).toEqual(['curve', 'curve', 'pool', 'pool'])
  })

  /**
   * THE SEAM, MEASURED. The indexer measured 58_783_256_052 from the curve's
   * closing virtual reserves and 58_783_256_039 from the pool's implied ones --
   * 13 wei, 2.2e-10 relative. The fixtures carry exactly those reserves, so
   * this asserts the measurement rather than restating it.
   */
  it('the curve’s last price and the pool’s first differ by 13 wei', () => {
    const points = priceSeries(MIXED_HISTORY, GRADUATED_SEQ)
    const lastCurve = points.filter((p) => p.venue === 'curve').at(-1)
    const firstPool = points.find((p) => p.venue === 'pool')
    expect(lastCurve?.priceWei).toBe(58_783_256_052n)
    expect(firstPool?.priceWei).toBe(58_783_256_039n)
    const gap = (lastCurve?.priceWei as bigint) - (firstPool?.priceWei as bigint)
    expect(gap).toBe(13n)
    // Asserted at full precision. At ppm resolution the gap is INVISIBLE, so a
    // test measuring it in ppm would pass while measuring nothing -- the same
    // trap `token-page.test.tsx` records for the graduation overshoot.
    expect(Number((gap * 10n ** 12n) / 58_783_256_052n) / 1e12).toBeCloseTo(2.2e-10, 11)
  })

  it('two trades in one block collapse to the LAST, never an average', () => {
    const later = { ...POOL_FIRST, eventSeq: POOL_FIRST.eventSeq + 5n, virtualQuoteReservesWei: 1n }
    const points = priceSeries([later, POOL_FIRST], GRADUATED_SEQ)
    expect(points.filter((p) => p.block === 61)).toHaveLength(1)
    expect(points.find((p) => p.block === 61)?.priceWei).toBe(
      priceWeiPerToken(1n, later.virtualTokenReservesTok),
    )
  })

  it('a row whose reserves cannot price is SKIPPED, not drawn at zero', () => {
    // Migration 012 made a zero-AMOUNT pool row representable; a zero RESERVE
    // is what `priceWeiPerToken` refuses, and a chart that drew it at zero
    // would put a spike on the floor of every graduated token.
    const broken = { ...POOL_FIRST, eventSeq: (70n << 20n) | 0n, virtualTokenReservesTok: 0n }
    expect(priceSeries([broken, ...MIXED_HISTORY], GRADUATED_SEQ)).toHaveLength(4)
  })

  it('the chart draws ONE line through the seam, with the seam marked', () => {
    const { container } = render(
      <PriceHistoryChart trades={MIXED_HISTORY} graduatedSeq={GRADUATED_SEQ} symbol="DIFF" />,
    )
    const q = within(container)
    // ONE path, not two: two polylines would leave a visible gap and say the
    // history restarted, which is the thing this component exists to prevent.
    expect(q.getAllByTestId('price-history-line')).toHaveLength(1)
    expect(q.getByTestId('graduation-seam')).toBeInTheDocument()
    expect(q.getAllByTestId('price-point-curve')).toHaveLength(2)
    expect(q.getAllByTestId('price-point-pool')).toHaveLength(2)
    expect(q.getByTestId('price-history-chart').getAttribute('aria-label')).toMatch(
      /2 (is|are) in the pool after graduation/,
    )
  })

  it('with no pool trades yet there is no seam and the caption says so', () => {
    const { container } = render(
      <PriceHistoryChart trades={[CURVE_EARLY, CURVE_CLOSE]} graduatedSeq={GRADUATED_SEQ} />,
    )
    const q = within(container)
    expect(q.queryByTestId('graduation-seam')).toBeNull()
    expect(q.getByTestId('price-history-caption').textContent).toMatch(
      /still on the bonding curve/i,
    )
  })

  it('a graduated token with no indexed trades says so instead of drawing nothing', () => {
    render(<PriceHistoryChart trades={[]} graduatedSeq={GRADUATED_SEQ} />)
    expect(screen.getByTestId('price-history-empty').textContent).toMatch(/no pool trades/i)
  })
})

describe('the chart choice is made in ONE place', () => {
  it('a trading token gets the bonding curve; a graduated one gets the history', () => {
    const trading = render(
      <TokenPriceChart
        lifecycle={resolveLifecycle({ complete: false, graduated: false })}
        profile={PROFILE}
        soldTok={0n}
        currentPriceWei={4_000_000_000n}
        progressPercent="0.0"
        trades={MIXED_HISTORY}
        graduatedSeq={null}
      />,
    )
    expect(within(trading.container).getByTestId('curve-chart')).toBeInTheDocument()
    expect(within(trading.container).queryByTestId('price-history-chart')).toBeNull()
    trading.unmount()

    const graduated = render(
      <TokenPriceChart
        lifecycle={resolveLifecycle({ complete: true, graduated: true })}
        profile={PROFILE}
        soldTok={PROFILE.saleSupply}
        currentPriceWei={58_783_256_052n}
        progressPercent="100.0"
        trades={MIXED_HISTORY}
        graduatedSeq={GRADUATED_SEQ}
      />,
    )
    expect(within(graduated.container).getByTestId('price-history-chart')).toBeInTheDocument()
    expect(within(graduated.container).queryByTestId('curve-chart')).toBeNull()
  })

  it('a COMPLETE but ungraduated token still gets the bonding curve', () => {
    // The curve is closed but the pool is not open: the bonding curve with its
    // marker at 100% is the true picture, and there is no pool history to draw.
    const { container } = render(
      <TokenPriceChart
        lifecycle={resolveLifecycle({ complete: true, graduated: false })}
        profile={PROFILE}
        soldTok={PROFILE.saleSupply}
        currentPriceWei={58_783_256_052n}
        progressPercent="100.0"
        trades={[CURVE_EARLY, CURVE_CLOSE]}
        graduatedSeq={null}
      />,
    )
    expect(within(container).getByTestId('curve-chart')).toBeInTheDocument()
  })
})

describe('the trade list stays continuous and labels the venue', () => {
  it('both venues are in ONE list, newest first, and only pool rows are badged', () => {
    const { container } = render(
      <TradesTable
        rows={MIXED_HISTORY}
        nextCursor={null}
        symbol="DIFF"
        graduatedSeq={GRADUATED_SEQ}
        now={Date.parse('2026-08-09T12:00:10.000Z')}
      />,
    )
    const rows = within(container).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(4)
    // A badge on EVERY row would add a column's width and say nothing: today
    // every token is single-venue.
    expect(within(container).getAllByText('Pool')).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Pool')).toBeInTheDocument()
    expect(within(rows[3] as HTMLElement).queryByText('Pool')).toBeNull()
  })

  it('an ungraduated token shows no venue badge at all', () => {
    const { container } = render(
      <TradesTable
        rows={MIXED_HISTORY}
        nextCursor={null}
        symbol="DIFF"
        now={Date.parse('2026-08-09T12:00:10.000Z')}
      />,
    )
    expect(within(container).queryByText('Pool')).toBeNull()
  })

  /**
   * THE SAME FALSE SENTENCE IN TWO PLACES IS THIS PACKAGE'S RECURRING DEFECT.
   * "to the curve" was written on every row; on a pool row it names a contract
   * the trade never touched, and the fee it describes was taken by the hook.
   */
  it('the fee sentence names the venue the trade actually happened in', () => {
    expect(feeSentence(CURVE_CLOSE, 'curve')).toContain('to the curve')
    expect(feeSentence(POOL_FIRST, 'pool')).toContain('to the pool')
    expect(feeSentence(POOL_FIRST, 'pool')).not.toContain('curve')
    // A sell reads the other way round on both venues.
    expect(feeSentence({ ...POOL_FIRST, isBuy: false }, 'pool')).toContain('from the pool')
  })

  it('the DEFAULT is the curve, so an un-passed venue cannot invent a pool', () => {
    // A default of 'pool' would relabel every curve trade in the product the
    // moment a call site forgot the argument.
    expect(feeSentence(CURVE_CLOSE)).toContain('to the curve')
  })

  /**
   * THE WIRING, NOT THE COMPONENT.
   *
   * `TradesTable` being right and `TableTabs` not forwarding the seam is the
   * shape this package keeps shipping: a mutant that dropped `graduatedSeq`
   * from `TableTabs`'s forwarding SURVIVED the whole pool suite until this
   * test existed, because every other assertion rendered `TradesTable`
   * directly. The page hands `TableTabs` the overview; `TableTabs` hands the
   * table the seam; both hops need an assertion.
   */
  it('TableTabs FORWARDS the seam from the overview to the list', () => {
    const { container } = render(
      <TableTabs
        trades={ok({ rows: MIXED_HISTORY, nextCursor: null })}
        holders={ok({ rows: [], nextCursor: null })}
        overview={{
          curve: '0x00000000000000000000000000000000000000bb',
          launchCreator: '0x00000000000000000000000000000000000000dd',
          symbol: 'DIFF',
          graduatedSeq: GRADUATED_SEQ,
        }}
        now={Date.parse('2026-08-09T12:00:10.000Z')}
      />,
    )
    expect(within(container).getAllByText('Pool')).toHaveLength(2)
    expect(container.textContent).toContain('to the pool')
  })

  it('CONTROL: the same tabs with an UNGRADUATED overview badge nothing', () => {
    // Without this the forwarding could be hardcoded to `GRADUATED_SEQ` and the
    // assertion above would still pass.
    const { container } = render(
      <TableTabs
        trades={ok({ rows: MIXED_HISTORY, nextCursor: null })}
        holders={ok({ rows: [], nextCursor: null })}
        overview={{
          curve: '0x00000000000000000000000000000000000000bb',
          launchCreator: '0x00000000000000000000000000000000000000dd',
          symbol: 'DIFF',
          graduatedSeq: null,
        }}
        now={Date.parse('2026-08-09T12:00:10.000Z')}
      />,
    )
    expect(within(container).queryByText('Pool')).toBeNull()
  })

  it('the rendered row carries the venue sentence, not just the helper', () => {
    // The helper being right and the table calling it with a constant is
    // exactly the shape that keeps passing component tests here.
    const { container } = render(
      <TradesTable
        rows={[POOL_FIRST]}
        nextCursor={null}
        symbol="DIFF"
        graduatedSeq={GRADUATED_SEQ}
        now={Date.parse('2026-08-09T12:00:10.000Z')}
      />,
    )
    expect(container.textContent).toContain('to the pool')
    expect(container.textContent).not.toContain('to the curve')
  })
})
