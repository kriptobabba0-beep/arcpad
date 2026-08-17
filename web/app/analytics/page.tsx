import { DailyBarChart } from '@/components/analytics/DailyBarChart'
import { RANGE_LABEL, RangeToggle } from '@/components/analytics/RangeToggle'
import { StatGrid } from '@/components/analytics/StatGrid'
import { ReadUnavailable } from '@/components/explore/EmptyState'
import { StaleNotice } from '@/components/read/StaleNotice'
import { stalenessOf, valueOf } from '@/components/read/result'
import {
  ANALYTICS_DAYS,
  parseAnalyticsRange,
  readProtocolDaily,
  readProtocolStats,
} from '@/lib/read'

/**
 * ==========================================================================
 *  /analytics -- PHASE 5, AND `protocol_stats_daily` STILL DOES NOT EXIST.
 * ==========================================================================
 *
 * Phase 4 excluded this route by name and gave the reason: the daily rollup
 * table was left out of Phase 3. It is STILL left out, and this page does not
 * ship a stub of it. The decision, in full, is in `packages/db/src/queries.ts`
 * above `getProtocolStats`; the short form is that a rollup table's only
 * writer is `indexer/`, and a table with no writer renders a chart that is
 * empty forever -- which is exactly the failure this repository has already
 * shipped once, on a screen that told users to wait for a release that had
 * already happened.
 *
 * SO EVERY FIGURE HERE IS AGGREGATED FROM `trades` AND `launches` ON EACH
 * REQUEST, and the cost is named rather than hidden: the "All time" tiles are
 * a full aggregate, which no window index can help. That is the price of not
 * having the rollup, it is free at today's six trades, and the fix when
 * `trades` is large is the rollup itself -- not an index.
 *
 * THE PAGE IS A SERVER COMPONENT AND QUERIES POSTGRES DIRECTLY (spec §6.3).
 * No API layer sits in between.
 *
 * TWO INDEPENDENT READS, TWO INDEPENDENT FAILURES. The tiles and the charts
 * degrade separately: one `Promise.all` rejection would blank both, and a
 * page that loses its charts because a stat query timed out has thrown away
 * the half that still worked.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[] }>
}) {
  const raw = await searchParams
  const range = parseAnalyticsRange(raw.range)

  const [statsResult, dailyResult] = await Promise.all([
    readProtocolStats(range),
    // THE CHARTS DO NOT FOLLOW THE RANGE TOGGLE, AND THAT IS DELIBERATE. A
    // "24h" daily bar chart is one bar; the toggle governs the TILES, which is
    // what §7.1 asks for ("24h / All time geçişi, istatistik ızgarası, günlük
    // hacim ve launch bar grafikleri" -- one toggle, one grid, and the daily
    // charts as their own thing).
    readProtocolDaily(ANALYTICS_DAYS),
  ])

  const stats = valueOf(statsResult)
  const daily = valueOf(dailyResult)
  // THE STALENESS OF EITHER READ IS THE STALENESS OF THE PAGE. Drawing one
  // notice per panel would let a user read the fresh half and miss the warning
  // attached to the other.
  const lagging = stalenessOf(statsResult) ?? stalenessOf(dailyResult)

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-3xl leading-none">Analytics</h1>
          <p className="text-[13px] text-muted">
            {range === 'all'
              ? 'Everything the indexer has seen.'
              : 'The last 24 hours, measured against the database clock.'}
          </p>
        </div>
        <RangeToggle active={range} />
      </div>

      {lagging === null ? null : <StaleNotice indexer={lagging} what="These figures" />}

      <section aria-labelledby="totals-heading" className="flex flex-col gap-4">
        <h2 id="totals-heading" className="sr-only">
          {RANGE_LABEL[range]} totals
        </h2>
        {stats === undefined ? (
          <ReadUnavailable what="Protocol totals" />
        ) : (
          <>
            <StatGrid stats={stats} showVenueSplit={stats.poolTradeCount > 0} />
            {/*
              THE SCOPE SENTENCE IS ON THE PAGE, NOT IN A COMMENT.

              `trades` only carries the INDEXED factory's launches. The fee
              escrow is keyed by RECIPIENT and Phase 2 reused Phase 1's escrow,
              so the escrow ledger also holds deposits from the superseded
              factory's curves -- 36 496 595 214 216 153 wei, measured on chain
              2026-08-09 -- which have no `launches` row and therefore no place
              in these totals. Someone comparing this page to `FeeEscrow` will
              find the two disagree; they should find out here why, and not
              conclude that one of them is broken.
            */}
            <p className="max-w-[70ch] text-[12px] text-muted" data-testid="analytics-scope">
              Fees here are what was charged on trades of indexed launches. The fee escrow is shared
              with a superseded factory and is keyed by recipient, so its balance is larger than
              these totals and the two are not the same quantity.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="daily-heading" className="flex flex-col gap-6">
        <h2 id="daily-heading" className="font-serif text-2xl leading-none">
          Last {ANALYTICS_DAYS} days
        </h2>
        {daily === undefined ? (
          <ReadUnavailable what="Daily activity" />
        ) : (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            <DailyBarChart days={daily} metric="volume" title="Daily volume" />
            <DailyBarChart days={daily} metric="launches" title="Daily launches" />
          </div>
        )}
      </section>
    </div>
  )
}
