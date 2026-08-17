import type { ProtocolDay, ProtocolStats } from '@arcpad/db'
import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadResult } from '@/lib/read'
import { renderWithProviders } from '../ui/harness'

/**
 * ==========================================================================
 *  /analytics, RENDERED AS THE PAGE -- AND `protocol_stats_daily` STILL DOES
 *  NOT EXIST.
 * ==========================================================================
 *
 * Phase 4 excluded this route because Phase 3 left the daily rollup out of
 * scope. It is still out of scope: every figure here is aggregated from
 * `trades` and `launches` at read time. The arithmetic and the day bucketing
 * are proved against a REAL Postgres in `packages/db/test/analytics.test.ts` --
 * including that the buckets are identical under `TimeZone` UTC+14 and UTC-12,
 * with a negative control showing the naive expression is NOT.
 *
 * What is proved HERE is the other half, and it is the half this repository
 * keeps losing: that the PAGE feeds the components. A `<StatGrid>` test with a
 * hand-made object says nothing about whether `app/analytics/page.tsx` passes
 * the right range, the right series, or anything at all -- the token page's
 * `graduated` branch was green in exactly that shape while the page never
 * passed the field.
 */

vi.mock('@/lib/read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/read')>()
  return { ...actual, readProtocolStats: vi.fn(), readProtocolDaily: vi.fn() }
})

const read = await import('@/lib/read')
const { default: AnalyticsPage } = await import('@/app/analytics/page')

const FRESH = {
  stale: false as const,
  lastBlock: 55_900_000n,
  updatedAt: new Date(),
  blocksBehind: 0n,
}

function fresh<T>(data: T): ReadResult<T> {
  return { ok: true, stale: false, data, indexer: FRESH as never }
}

/** Hand-derived, not computed: 939.000000 USDC across three curve trades. */
const STATS: ProtocolStats = {
  windowHours: null,
  volumeWei: 939_000_000_000_000_000n,
  tradeCount: 3,
  protocolFeeWei: 8_920_500_000_000_000n,
  creatorFeeWei: 2_817_000_000_000_000n,
  launchCount: 2,
  creatorCount: 1,
  poolVolumeWei: 0n,
  poolTradeCount: 0,
}

function day(d: string, volumeWei: bigint, launchCount = 0): ProtocolDay {
  return {
    day: d,
    volumeWei,
    tradeCount: volumeWei === 0n ? 0 : 1,
    protocolFeeWei: 0n,
    creatorFeeWei: 0n,
    launchCount,
  }
}

/** FIVE days, THREE of them empty. The gaps are the point. */
const DAYS: readonly ProtocolDay[] = [
  day('2026-08-06', 0n),
  day('2026-08-07', 100_000_000_000_000_000n, 1),
  day('2026-08-08', 0n),
  day('2026-08-09', 0n),
  day('2026-08-10', 839_000_000_000_000_000n, 1),
]

function mocks() {
  return {
    stats: vi.mocked(read.readProtocolStats),
    daily: vi.mocked(read.readProtocolDaily),
  }
}

async function renderAnalytics(range?: string) {
  const element = await AnalyticsPage({
    searchParams: Promise.resolve(range === undefined ? {} : { range }),
  })
  return renderWithProviders(element)
}

beforeEach(() => {
  const m = mocks()
  m.stats.mockResolvedValue(fresh(STATS))
  m.daily.mockResolvedValue(fresh(DAYS))
})

describe('the range toggle drives the query', () => {
  it('defaults to all time and asks for the null window', async () => {
    await renderAnalytics()
    expect(mocks().stats).toHaveBeenCalledWith('all')
    const nav = screen.getByRole('navigation', { name: 'Time range' })
    expect(within(nav).getByRole('link', { name: 'All time' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('?range=24h asks for the 24-hour window and marks the link', async () => {
    await renderAnalytics('24h')
    expect(mocks().stats).toHaveBeenCalledWith('24h')
    const nav = screen.getByRole('navigation', { name: 'Time range' })
    expect(within(nav).getByRole('link', { name: '24h' })).toHaveAttribute('aria-current', 'page')
  })

  /**
   * AN UNKNOWN RANGE IS "ALL TIME", NOT A 500 AND NOT A RAW NUMBER.
   *
   * The value arrives from a URL. Passing it through as an hour count would
   * let a link decide the window, and would make the page's own "24h" label
   * unverifiable -- two links could both say 24h and mean different things.
   */
  it('a hostile range falls back to all time', async () => {
    await renderAnalytics('999999')
    expect(mocks().stats).toHaveBeenCalledWith('all')
  })

  /**
   * THE CHARTS DO NOT FOLLOW THE TOGGLE, AND THAT IS ASSERTED.
   *
   * A "24h" daily bar chart is one bar. §7.1 asks for a toggle over the STAT
   * GRID and daily charts as their own thing; if that ever changes, this test
   * is where the change is noticed.
   */
  it('the daily series is always the 30-day one, whatever the toggle says', async () => {
    await renderAnalytics('24h')
    expect(mocks().daily).toHaveBeenCalledWith(read.ANALYTICS_DAYS)
  })
})

describe('the stat grid is fed by the page', () => {
  /**
   * EACH FIGURE IS READ THROUGH ITS OWN LABEL.
   *
   * `getByText('3')` would pass on ANY tile carrying a 3 -- so a page that fed
   * `tradeCount` into the Launches tile and `launchCount` into Trades would
   * still be green, which is precisely the swap this assertion has to catch.
   * The value is taken from the `<dd>` that belongs to the `<dt>`.
   */
  it('draws all six figures, each under its OWN label', async () => {
    await renderAnalytics()
    const grid = screen.getByTestId('analytics-stat-grid')
    const value = (label: string): string => {
      const dt = within(grid).getByText(label)
      const dd = dt.parentElement?.querySelector('dd')
      expect(dd, `no <dd> for ${label}`).not.toBeNull()
      return dd?.textContent ?? ''
    }

    // 939 000 000 000 000 000 wei = 0.939 USDC, compacted.
    expect(value('Volume')).toBe('$0.93')
    expect(value('Trades')).toBe('3')
    expect(value('Launches')).toBe('2')
    expect(value('Creators')).toBe('1')
    // Fees round DOWN and are shown at full six-decimal precision: they are
    // two independent ceilings on chain, never one 1.25% figure.
    expect(value('Protocol fees')).toBe('0.008920')
    expect(value('Creator fees')).toBe('0.002817')
  })

  /**
   * A PERMANENTLY-ZERO VENUE ROW IS NOT DRAWN.
   *
   * `graduationTarget` is `0x0` on the production factory, so no token has
   * graduated and the pool figure is STRUCTURALLY zero -- not "unused", but
   * "not yet reachable". A row reading "Pool volume 0.000000" says the
   * opposite. When the first swap lands the row appears, and its appearance is
   * itself the signal.
   */
  it('hides the venue split until the pool has actually traded', async () => {
    await renderAnalytics()
    expect(screen.queryByText('Pool volume')).toBeNull()

    mocks().stats.mockResolvedValue(
      fresh({ ...STATS, poolTradeCount: 1, poolVolumeWei: 2_000_000_000_000_000_000n }),
    )
    await renderAnalytics()
    expect(screen.getByText('Pool volume')).toBeInTheDocument()
  })

  /**
   * THE SCOPE SENTENCE IS ON THE PAGE.
   *
   * `trades` carries only the INDEXED factory's launches, while `FeeEscrow` is
   * keyed by recipient and is SHARED with the superseded factory. Anyone
   * comparing this page to the escrow will find they disagree; they should find
   * out here why, rather than conclude one of them is broken.
   */
  it('says these fees are not the escrow balance', async () => {
    await renderAnalytics()
    const scope = screen.getByTestId('analytics-scope')
    expect(scope).toHaveTextContent(/indexed launches/i)
    expect(scope).toHaveTextContent(/superseded factory/i)
  })
})

describe('the daily bars', () => {
  it('draw one slot per day INCLUDING the empty ones', async () => {
    await renderAnalytics()
    const chart = screen.getByTestId('daily-volume-svg')
    const bars = chart.querySelectorAll('rect')
    // FIVE slots for five days. A chart that skipped the three idle days would
    // draw two adjacent bars and silently compress the time axis.
    expect(bars).toHaveLength(DAYS.length)
    expect(chart.querySelectorAll('[data-testid="daily-bar-empty"]')).toHaveLength(3)
    expect(chart.querySelectorAll('[data-testid="daily-bar"]')).toHaveLength(2)
  })

  it('the accessible table carries every day, gaps included', async () => {
    await renderAnalytics()
    const table = screen.getByRole('table', { name: /Daily volume by day/i })
    for (const d of DAYS) {
      expect(within(table).getByText(d.day)).toBeInTheDocument()
    }
  })

  /**
   * AN ALL-ZERO WINDOW IS A SENTENCE, NOT A ROW OF ZERO-HEIGHT BARS.
   *
   * Scaling by `max` when `max === 0` divides by zero; the obvious guard
   * (`max || 1`) draws a chart that looks exactly like a working one with no
   * traffic. "Nothing happened" and "the chart is broken" have to look
   * different, and only one of them is ever true.
   */
  it('says nothing happened rather than drawing a flat chart', async () => {
    mocks().daily.mockResolvedValue(fresh(DAYS.map((d) => day(d.day, 0n))))
    await renderAnalytics()
    const chart = screen.getByTestId('daily-volume')
    expect(chart).toHaveTextContent(/Nothing recorded/i)
    expect(chart.querySelector('svg')).toBeNull()
  })

  it('bar heights use bigint arithmetic, so a whale day does not flatten the rest', async () => {
    await renderAnalytics()
    const bars = [...screen.getByTestId('daily-volume-svg').querySelectorAll('rect')]
    const heights = bars.map((b) => Number(b.getAttribute('height')))
    // 100e15 against 839e15: the small day must be visible and NOT equal to
    // the big one. `Number(volumeWei)` would lose precision above 2^53.
    const nonZero = heights.filter((h) => h > 0)
    expect(nonZero).toHaveLength(2)
    expect(nonZero[0]).toBeGreaterThan(0)
    expect(nonZero[0]).not.toBe(nonZero[1])
  })

  it('both charts are drawn -- volume AND launches', async () => {
    await renderAnalytics()
    expect(screen.getByTestId('daily-volume')).toBeInTheDocument()
    expect(screen.getByTestId('daily-launches')).toBeInTheDocument()
  })
})
