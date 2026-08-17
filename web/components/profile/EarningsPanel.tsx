import type { CreatorEarnings } from '@arcpad/db'
import Link from 'next/link'
import { Money } from '@/components/ui/Money'
import { cx } from '@/components/ui/cx'

/**
 * ==========================================================================
 *  FEE EARNINGS -- THE TOTAL IS THE LEDGER'S, NEVER THE ROWS'.
 * ==========================================================================
 *
 * `packages/db`'s `listCreatorEarningsByLaunch` carries a warning written for
 * the first caller, and this component is downstream of it. Both of that
 * query's JOINs are INNER: a `fee_events` row counts only if its `from_addr`
 * has a `curve_state` row whose token has a `launches` row. Two real classes
 * of deposit fail that test:
 *
 *   1. THE SHARED ESCROW'S PREFIX. `FeeEscrow` is keyed by RECIPIENT, and
 *      Phase 2 REUSED Phase 1's escrow -- so the ledger holds deposits from
 *      the superseded factory's curves, which the indexer never watched.
 *      Measured on chain 2026-08-09: 36 496 595 214 216 153 wei.
 *   2. EVERY POOL FEE. `ArcpadHook` deposits the swap fee, so `Deposited.from`
 *      is the HOOK, not a curve. Zero today (nothing has graduated) and the
 *      dominant term once anything does.
 *
 * A PANEL THAT SUMMED THE ROWS AND CALLED IT "YOUR EARNINGS" WOULD SHOW A
 * NUMBER SMALLER THAN `FeeEscrow.owed()`. So it does not, and it CANNOT: the
 * props are one `CreatorEarnings` object, whose shape has no field equal to
 * the sum of `byLaunch`. `depositedTotalWei` / `claimableWei` come from
 * `fee_balances`, which is the escrow's own ledger; the difference arrives
 * already named as `unattributedWei` and is DRAWN, as its own row, rather than
 * swallowed.
 *
 * THE PROP IS THE WHOLE OBJECT FOR THAT REASON. Taking `rows` and `total` as
 * separate props would put the pairing back in the caller's hands, and this
 * repository has shipped the same property "covered on one entrypoint,
 * forgotten on another" enough times to stop offering the opportunity.
 */

export type EarningsPanelProps = {
  readonly earnings: CreatorEarnings
  /** Rendered under the totals; the claim action lives outside this component. */
  readonly children?: React.ReactNode
}

function Row({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: React.ReactNode
  value: React.ReactNode
  hint?: string
  emphasis?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border py-2.5 last:border-0">
      <div className="flex items-baseline justify-between gap-4">
        <span className={cx('text-[13px]', emphasis ? 'text-text' : 'text-muted')}>{label}</span>
        <span className={cx('tabular-nums', emphasis ? 'text-sm' : 'text-[13px] text-muted')}>
          {value}
        </span>
      </div>
      {hint === undefined ? null : <p className="text-[11px] text-muted">{hint}</p>}
    </div>
  )
}

export function EarningsPanel({ earnings, children }: EarningsPanelProps) {
  const {
    byLaunch,
    byLaunchTruncated,
    attributedWei,
    unattributedWei,
    depositedTotalWei,
    claimedTotalWei,
    claimableWei,
    ledgerMissing,
  } = earnings

  /*
   * A LEDGER THAT DISAGREES WITH ITS OWN EVENTS IS NOT ROUNDED AWAY.
   *
   * `unattributedWei` is `deposited - attributed` with the SIGN KEPT. A
   * negative value means `fee_events` attributed more than `fee_balances`
   * recorded -- impossible if both were written in one transaction, which they
   * are, so it can only mean the two have drifted. Clamping it to zero would
   * make a broken ledger look tidy.
   */
  const negativeResidual = unattributedWei < 0n

  return (
    <section
      aria-labelledby="earnings-heading"
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-5"
      data-testid="earnings-panel"
    >
      <h2 id="earnings-heading" className="font-serif text-xl leading-none">
        Creator fees
      </h2>

      {ledgerMissing ? (
        <p className="text-[13px] text-muted" data-testid="earnings-none">
          This address has never received a fee. Creator fees are 30 bps of the curve amount on
          every trade of a launch it created, and they are deposited into the fee escrow as the
          trade happens.
        </p>
      ) : (
        <>
          <dl className="flex flex-col">
            {/*
              CLAIMABLE FIRST, AND IT IS THE ESCROW'S NUMBER.
              `fee_balances.claimable_wei` is maintained from `Deposited` and
              `Claimed` and equals `FeeEscrow.owed(recipient)`. Rounded DOWN:
              this is a balance, and showing a creator one unit more than the
              escrow will pay is showing money that does not exist.
            */}
            <Row
              label="Claimable now"
              value={<Money native={claimableWei} rounding="down" unit />}
              emphasis
              hint="From the fee escrow's own ledger — the amount claim() would pay."
            />
            <Row
              label="Earned, all time"
              value={<Money native={depositedTotalWei} rounding="down" unit />}
              hint="Every deposit the escrow recorded for this address."
            />
            <Row
              label="Already claimed"
              value={<Money native={claimedTotalWei} rounding="down" unit />}
            />
          </dl>

          {children}

          <div className="flex flex-col gap-2">
            <h3 className="text-[11px] uppercase tracking-[0.08em] text-muted">
              Where it came from
            </h3>

            {byLaunch.length === 0 ? (
              <p className="text-[13px] text-muted" data-testid="earnings-no-breakdown">
                None of it can be attributed to a launch this indexer watches.
              </p>
            ) : (
              <dl className="flex flex-col">
                {byLaunch.map((row) => (
                  <Row
                    key={row.token}
                    label={
                      <Link
                        href={`/token/${row.token}`}
                        className="rounded-sm underline decoration-border underline-offset-2 hover:decoration-text"
                      >
                        {row.symbol}
                      </Link>
                    }
                    value={<Money native={row.earnedWei} rounding="down" />}
                  />
                ))}
              </dl>
            )}

            {byLaunchTruncated ? (
              <p className="text-[11px] text-muted" data-testid="earnings-truncated">
                Only the largest {byLaunch.length} launches are listed; the totals above cover all
                of them.
              </p>
            ) : null}

            {/*
              ============ THE UNATTRIBUTED ROW ============

              Drawn whenever it is non-zero, and it carries WHY rather than a
              bare number. A reader who sees "Earned 1.2" over a breakdown that
              adds to 0.9 will assume one of the two is a bug; this row is the
              answer, and it is the reason the breakdown and the total are
              allowed to disagree at all.
            */}
            {unattributedWei === 0n ? null : (
              <div
                className={cx(
                  'rounded-input border px-3 py-2.5 text-[12px]',
                  negativeResidual
                    ? 'border-negative/40 bg-negative/8'
                    : 'border-border bg-surface-2 text-muted',
                )}
                data-testid="earnings-unattributed"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span>{negativeResidual ? 'Ledger disagrees' : 'Not attributed'}</span>
                  <span className="tabular-nums">
                    <Money
                      native={negativeResidual ? -unattributedWei : unattributedWei}
                      rounding="down"
                    />
                  </span>
                </div>
                <p className="mt-1">
                  {negativeResidual
                    ? 'The per-launch rows add up to more than the escrow ledger recorded. ' +
                      'One of the two is behind; treat the escrow figure above as authoritative.'
                    : 'Fees the escrow holds for this address that no watched launch can account ' +
                      'for — deposits from a superseded factory, or pool fees, which arrive from ' +
                      'the hook rather than from a curve. They are yours and they are claimable; ' +
                      'they just have no launch to sit under.'}
                </p>
              </div>
            )}

            {/*
              THE IDENTITY, ON SCREEN. Not decoration: it is the one line that
              lets a reader check the panel against itself, and it is the
              relation `packages/db` asserts against a real Postgres.
            */}
            <p className="text-[11px] text-muted" data-testid="earnings-identity">
              <Money native={attributedWei} rounding="down" /> attributed
              {unattributedWei >= 0n ? ' + ' : ' − '}
              <Money
                native={unattributedWei >= 0n ? unattributedWei : -unattributedWei}
                rounding="down"
              />{' '}
              unattributed = <Money native={depositedTotalWei} rounding="down" /> earned
            </p>
          </div>
        </>
      )}
    </section>
  )
}
