'use client'

import type { PositionRow } from '@arcpad/db'
import { formatTokenAmount } from '@arcpad/shared/browser'
import Link from 'next/link'
import { Money } from '@/components/ui/Money'
import { Pill } from '@/components/ui/Pill'
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

/**
 * ============ POSITIONS: A BALANCE AND WHAT IT IS WORTH RIGHT NOW ============
 *
 * "VALUE" IS `balance × last price`, AND THE HEADER SAYS SO IN AS MANY WORDS.
 *
 * That number is the MARGINAL value: it prices every token in the position at
 * the price of the next one. Selling the whole position walks the curve DOWN --
 * `quoteSellProceeds(t, Q, T) = t·Q/(T+t)`, which is strictly less than
 * `t × price` for any `t > 0` -- and then two fee parts come off the top. So
 * "value" is an UPPER BOUND on the exit, not the exit, and a column labelled
 * only "Value" would read as the latter.
 *
 * It is not silently replaced with a computed exit quote either, and the reason
 * is that the exit quote does not exist for every row: all three curve
 * entrypoints revert `CurveComplete()` once the curve is done, so a completed
 * or graduated position has no curve-side proceeds at all. One column that
 * means "sale proceeds" for some rows and "notional" for others would be worse
 * than one honest bound with its name on it.
 *
 * THE ROW STATES ITS LIFECYCLE. `complete` and `graduated` are separate facts
 * (a complete curve with `graduationTarget == 0x0` is the live state of every
 * token on this chain today), and a holder needs to know which of their
 * positions can still be sold on a curve.
 */

export type PositionsTableProps = {
  readonly rows: readonly PositionRow[]
  readonly nextCursor: string | null
  readonly loadMore?: LoadMore<PositionRow>
}

export function PositionsTable({ rows, nextCursor, loadMore }: PositionsTableProps) {
  const keyset = useKeysetRows(rows, nextCursor, loadMore)

  if (keyset.rows.length === 0) {
    return (
      <TableNotice
        title="No token positions."
        body="This address does not hold a balance in any indexed launch. Tokens bought on a curve show up here as soon as the indexer sees the transfer."
      />
    )
  }

  return (
    <div className="rounded-card border border-border bg-surface">
      {/*
        THE TABLE IS NAMED. Two tables sit on this page and a screen-reader
        user moving between them by role gets "table" and "table" without one.
        The name is also what a test can reach them by, which is not a
        coincidence: a locator that works is evidence the name exists.
      */}
      <table role="table" aria-label="Token positions" className={TABLE_CLASS}>
        <thead role="rowgroup" className={THEAD_CLASS}>
          <tr role="row" className={HEAD_ROW_CLASS}>
            <HeadCell>Token</HeadCell>
            <HeadCell numeric>Balance</HeadCell>
            <HeadCell numeric title="Balance times the current curve price. Selling the position moves the price down, so the realised amount is lower.">
              Value at last price
            </HeadCell>
            <HeadCell>Curve</HeadCell>
          </tr>
        </thead>
        <tbody role="rowgroup" className={TBODY_CLASS}>
          {keyset.rows.map((row) => (
            <tr role="row" key={row.token} className={BODY_ROW_CLASS}>
              <Cell label="Token">
                <Link
                  href={`/token/${row.token}`}
                  className="rounded-sm underline decoration-border underline-offset-2 hover:decoration-text"
                >
                  {row.symbol}
                </Link>
              </Cell>
              <Cell label="Balance" numeric>
                {formatTokenAmount(row.balanceTok)}
              </Cell>
              {/*
                ROUNDS DOWN. This is a holding, not a bill: showing a holder a
                figure larger than the position is worth is showing money that
                is not there.
              */}
              <Cell label="Value at last price" numeric>
                <Money native={row.valueWei} rounding="down" />
              </Cell>
              <Cell label="Curve">
                {row.graduated ? (
                  <Pill tone="accent">Graduated</Pill>
                ) : row.complete ? (
                  <Pill>Complete</Pill>
                ) : (
                  <span className="text-muted">Trading</span>
                )}
              </Cell>
            </tr>
          ))}
        </tbody>
      </table>
      <LoadMoreFooter state={keyset} label="Load more positions" />
    </div>
  )
}
