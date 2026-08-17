import { formatUsdcAmount, formatUsdcCompact } from '@arcpad/shared/browser'
import type { ProtocolStats } from '@arcpad/db'
import { cx } from '@/components/ui/cx'

/**
 * =================== THE STAT GRID, AND WHAT IT DOES NOT SAY ================
 *
 * SIX FIGURES, AND EVERY ONE OF THEM IS DERIVED FROM `trades` / `launches` AT
 * READ TIME. `protocol_stats_daily` does not exist (Phase 3 left it out on
 * purpose) and this page does not pretend otherwise; the reasoning lives in
 * `packages/db/src/queries.ts` above `getProtocolStats`.
 *
 * "PROTOCOL REVENUE" IS NOT THE ESCROW BALANCE, AND THE LABEL SAYS SO.
 * `trades.protocol_fee_wei` is the fee CHARGED on indexed launches. The escrow
 * ledger (`fee_balances`) also holds deposits from the SUPERSEDED factory's
 * curves -- measured 2026-08-09: 36 496 595 214 216 153 wei sits there with no
 * `launches` row to attribute it to -- so the two numbers are different
 * quantities over different sets and must never be added or equated. The
 * caption carries that sentence rather than a footnote nobody reads.
 *
 * THE TWO FEE PARTS ARE SHOWN SEPARATELY AND NEVER COMBINED. The curve takes
 * `feeOn(x, 95) + feeOn(x, 30)`, two independent ceilings; a single "1.25%"
 * figure derived from the sum is a different number from the one the chain
 * charged (measured on live trade #1 of 4: summed `…635`, divided `…634`).
 */

export type StatGridProps = {
  readonly stats: ProtocolStats
  /** Drawn only when the pool venue has actually produced a trade. */
  readonly showVenueSplit?: boolean
}

function Stat({
  label,
  value,
  hint,
  large = false,
}: {
  label: string
  value: string
  hint?: string
  large?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">{label}</dt>
      <dd
        className={cx(
          'tabular-nums leading-none',
          large ? 'font-serif text-3xl' : 'font-serif text-2xl',
        )}
      >
        {value}
      </dd>
      {hint === undefined ? null : <p className="text-[11px] text-muted">{hint}</p>}
    </div>
  )
}

export function StatGrid({ stats, showVenueSplit = false }: StatGridProps) {
  const count = (n: number) => n.toLocaleString('en-US')

  return (
    <dl
      className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3"
      data-testid="analytics-stat-grid"
    >
      {/*
        VOLUME ROUNDS DOWN. It is a measurement of money that moved, not a bill
        to be paid: rounding it up would print a figure larger than the sum of
        the trades behind it.
      */}
      <Stat label="Volume" value={formatUsdcCompact(stats.volumeWei)} large />
      <Stat label="Trades" value={count(stats.tradeCount)} large />
      <Stat label="Launches" value={count(stats.launchCount)} large />

      <Stat
        label="Protocol fees"
        value={formatUsdcAmount(stats.protocolFeeWei, { rounding: 'down' })}
        hint="charged on indexed launches"
      />
      <Stat
        label="Creator fees"
        value={formatUsdcAmount(stats.creatorFeeWei, { rounding: 'down' })}
        hint="paid to launch creators"
      />
      <Stat label="Creators" value={count(stats.creatorCount)} hint="distinct launch addresses" />

      {/*
        THE VENUE SPLIT IS DRAWN ONLY WHEN THE POOL HAS TRADED, AND THAT IS NOT
        A COSMETIC CHOICE. `graduationTarget` is `0x0` on the production
        factory, so no token has graduated and the pool figure is structurally
        zero. A permanent "Pool volume 0.000000" reads as a venue that exists
        and is unused, which is the opposite of true -- it exists and cannot yet
        be reached. When the first swap lands the row appears with a real
        number, and its appearance is itself the signal.
      */}
      {showVenueSplit ? (
        <>
          <Stat
            label="Pool volume"
            value={formatUsdcCompact(stats.poolVolumeWei)}
            hint="post-graduation, included above"
          />
          <Stat label="Pool trades" value={count(stats.poolTradeCount)} hint="included in Trades" />
        </>
      ) : null}
    </dl>
  )
}
