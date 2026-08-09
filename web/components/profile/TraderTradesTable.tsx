'use client'

import type { TraderTradeRow } from '@arcpad/db'
import { formatTokenAmount } from '@arcpad/shared/browser'
import Link from 'next/link'
import { Money } from '@/components/ui/Money'
import { Pill } from '@/components/ui/Pill'
import { VisuallyHidden } from '@/components/ui/VisuallyHidden'
import {
  BODY_ROW_CLASS,
  Cell,
  HEAD_ROW_CLASS,
  HeadCell,
  LoadMoreFooter,
  TABLE_CLASS,
  TableNotice,
  TBODY_CLASS,
  THEAD_CLASS,
  useKeysetRows,
  type LoadMore,
} from '@/components/token/tableShell'
import { VENUE_LABEL, venueOf } from '@/components/token/venue'

/**
 * ============ ONE WALLET'S HISTORY, ACROSS TOKENS AND ACROSS VENUES ============
 *
 * THE VENUE COMES FROM THE ROW (`source`), never from a page-level prop. The
 * token page paid for that lesson: while the venue travelled as a prop, four
 * call sites had to remember to pass it and a mutant that dropped it at ONE of
 * them survived the whole suite.
 *
 * ============ THE FEE PARTS ARE TWO NUMBERS AND STAY TWO NUMBERS ============
 *
 * The curve charges `feeOn(x, 95) + feeOn(x, 30)`, two independent ceilings,
 * and the sum is NOT `feeOn(x, 125)` -- measured on live trade #1 of 4: summed
 * `…635`, divided `…634`. A single "fee" column derived from a combined rate
 * would print a number the chain never charged.
 *
 * ============ AND THE COLUMN IS "CURVE AMOUNT", NOT "SPENT" ============
 *
 * `quote_amount_wei` is the venue's side of the trade, fees EXCLUDED. On a buy
 * the wallet parted with `amount + fees`; on a sell it received `amount −
 * fees`. Labelling this column "spent" or "received" would be wrong in one
 * direction by exactly the fee, so it is labelled what it is and the fee sits
 * beside it.
 */

export type TraderTradesTableProps = {
  readonly rows: readonly TraderTradeRow[]
  readonly nextCursor: string | null
  readonly loadMore?: LoadMore<TraderTradeRow>
}

export function TraderTradesTable({ rows, nextCursor, loadMore }: TraderTradesTableProps) {
  const keyset = useKeysetRows(rows, nextCursor, loadMore)

  if (keyset.rows.length === 0) {
    return (
      <TableNotice
        title="No trades yet."
        body="This address has not bought or sold on any indexed curve. Trades appear here as soon as the indexer sees them."
      />
    )
  }

  return (
    <div className="rounded-card border border-border bg-surface">
      {/* Named for the same reason as `PositionsTable`'s: two tables, one page. */}
      <table role="table" aria-label="Trade history" className={TABLE_CLASS}>
        <thead role="rowgroup" className={THEAD_CLASS}>
          <tr role="row" className={HEAD_ROW_CLASS}>
            <HeadCell>Side</HeadCell>
            <HeadCell>Token</HeadCell>
            <HeadCell numeric>Tokens</HeadCell>
            <HeadCell numeric title="The venue's side of the trade, fees excluded.">
              Curve amount
            </HeadCell>
            <HeadCell numeric title="Protocol and creator parts, summed for display only — the chain charges them as two independent ceilings.">
              Fees
            </HeadCell>
            <HeadCell>Venue</HeadCell>
          </tr>
        </thead>
        <tbody role="rowgroup" className={TBODY_CLASS}>
          {keyset.rows.map((row) => {
            const venue = venueOf(row)
            return (
              <tr role="row" key={String(row.eventSeq)} className={BODY_ROW_CLASS}>
                <Cell label="Side">
                  <span className={row.isBuy ? 'text-positive' : 'text-negative'}>
                    {row.isBuy ? 'Buy' : 'Sell'}
                  </span>
                </Cell>
                <Cell label="Token">
                  <Link
                    href={`/token/${row.token}`}
                    className="rounded-sm underline decoration-border underline-offset-2 hover:decoration-text"
                  >
                    {row.symbol}
                  </Link>
                </Cell>
                <Cell label="Tokens" numeric>
                  {formatTokenAmount(row.tokenAmountTok)}
                </Cell>
                {/*
                  ROUNDS UP. This is the amount that changed hands at the
                  venue; a buyer reading it should never see less than what the
                  curve took.
                */}
                <Cell label="Curve amount" numeric>
                  <Money native={row.quoteAmountWei} rounding="up" />
                </Cell>
                <Cell label="Fees" numeric>
                  <Money native={row.protocolFeeWei + row.creatorFeeWei} rounding="up" />
                  {/*
                    THE SPLIT IS ALWAYS AVAILABLE, NOT ONLY IN A TOOLTIP: a
                    `title` is invisible to a keyboard and to a screen reader on
                    a `<td>`. The two parts are read out; the column stays one
                    figure wide.
                  */}
                  <VisuallyHidden>
                    {` — protocol part ${row.protocolFeeWei.toString()} wei, creator part ${row.creatorFeeWei.toString()} wei`}
                  </VisuallyHidden>
                </Cell>
                <Cell label="Venue">
                  {venue === 'pool' ? (
                    <Pill tone="accent">{VENUE_LABEL[venue]}</Pill>
                  ) : (
                    <span className="text-muted">{VENUE_LABEL[venue]}</span>
                  )}
                </Cell>
              </tr>
            )
          })}
        </tbody>
      </table>
      <LoadMoreFooter state={keyset} label="Load more trades" />
    </div>
  )
}
