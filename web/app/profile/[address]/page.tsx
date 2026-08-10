import { isAddress } from 'viem'
import { notFound } from 'next/navigation'
import { ReadUnavailable } from '@/components/explore/EmptyState'
import { TokenGrid } from '@/components/explore/TokenGrid'
import { StaleNotice } from '@/components/read/StaleNotice'
import { stalenessOf, valueOf } from '@/components/read/result'
import type { HexAddress } from '@/components/read/types'
import { ClaimPanel } from '@/components/profile/ClaimPanel'
import { EarningsPanel } from '@/components/profile/EarningsPanel'
import { PositionsTable } from '@/components/profile/PositionsTable'
import { TraderTradesTable } from '@/components/profile/TraderTradesTable'
import { Address } from '@/components/ui/Address'
import {
  readCreatorEarnings,
  readLaunchesByCreator,
  readPositions,
  readTraderTrades,
  TABLE_PAGE_SIZE,
} from '@/lib/read'
import { loadMorePositions, loadMoreTraderTrades } from './actions'

/**
 * ==========================================================================
 *  /profile/[address] -- WHAT AN ADDRESS ACTUALLY IS ON THIS CHAIN.
 * ==========================================================================
 *
 * FOUR SECTIONS, AND EVERY ONE OF THEM IS A FACT THE CHAIN OR THE INDEXER CAN
 * ANSWER FOR ANY ADDRESS: launches it created, tokens it holds, trades it
 * made, fees the escrow owes it. There is no "your profile" and no ownership
 * check, because none of these are private and none of them belong to a
 * session -- a profile page here is a VIEW OF AN ADDRESS, the same for its
 * owner and for a stranger.
 *
 * ============ AND THERE IS EXACTLY ONE ACTION, BECAUSE THERE IS ONE ============
 *
 * `BondingCurve.creator` is IMMUTABLE and no contract implements a
 * reassignment; `creator_history` sits in the schema for a transfer that does
 * not exist yet. `LaunchToken` is a plain OZ ERC-20 with no admin. The whole
 * post-launch surface a creator has is `FeeEscrow.claim(creator)`, which is
 * PERMISSIONLESS. So this page offers that and nothing else. Inventing a
 * "transfer creator" or "edit metadata" control would be the same defect this
 * repository already shipped once -- a screen describing a capability that
 * was not there.
 *
 * ============ THE EARNINGS TOTAL IS NOT THE SUM OF THE ROWS ============
 *
 * The single most important line on this page is a number that is easy to get
 * wrong in a way nothing would catch. `listCreatorEarningsByLaunch` joins
 * `fee_events -> curve_state -> launches` with two INNER joins, so it drops
 * (a) the shared escrow's pre-factory deposits -- 36 496 595 214 216 153 wei,
 * measured on chain -- and (b) every pool fee, whose `Deposited.from` is the
 * hook rather than a curve. A page that summed those rows and printed "your
 * earnings" would show LESS than `FeeEscrow.owed()`.
 *
 * It cannot happen here, and not because of care: `readCreatorEarnings`
 * returns ONE object with no field equal to the sum of the breakdown, and this
 * page forwards that object WHOLE to `<EarningsPanel>`. Nothing is recomputed
 * between the query and the pixels. `web/test/profile/profile-page.test.tsx`
 * asserts it at THIS level rather than on the panel alone -- because a
 * property covered on a component is not covered on the page that renders it,
 * which is this repository's most frequent defect.
 */
export default async function ProfilePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params

  // Non-strict: an address pasted from Postgres is lower-case, i.e. NOT EIP-55,
  // and a strict check would reject every link this site generates.
  if (!isAddress(address, { strict: false })) notFound()
  const account = address.toLowerCase() as HexAddress

  /*
   * FOUR INDEPENDENT READS, FOUR INDEPENDENT FAILURES.
   *
   * `Promise.all` on the RESULTS, not on the throws: every one of these is
   * wrapped by `guard`, so a rejected query becomes `{ ok: false }` for its own
   * section and the other three still render. The alternative -- one rejection
   * blanking the page -- would mean a slow holders query costing a creator
   * sight of a claimable balance.
   */
  const [earningsResult, launchesResult, positionsResult, tradesResult] = await Promise.all([
    readCreatorEarnings(account),
    readLaunchesByCreator(account, 24),
    readPositions(account, { cursor: null, limit: TABLE_PAGE_SIZE }),
    readTraderTrades(account, { cursor: null, limit: TABLE_PAGE_SIZE }),
  ])

  const earnings = valueOf(earningsResult)
  const launches = valueOf(launchesResult)
  const positions = valueOf(positionsResult)
  const trades = valueOf(tradesResult)

  // ONE NOTICE FOR THE PAGE. Four per-panel notices would let a reader take in
  // the fresh half and miss the warning attached to the other.
  const lagging =
    stalenessOf(earningsResult) ??
    stalenessOf(launchesResult) ??
    stalenessOf(positionsResult) ??
    stalenessOf(tradesResult)

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl leading-none">
          <Address value={account} shorten={false} copy explorer label="Account" />
        </h1>
        <p className="text-[13px] text-muted">
          {/*
            NO "YOUR". This page renders identically for a visitor and for the
            owner of the address, because every fact on it is public and the
            only action on it is permissionless.
          */}
          Launches, positions, trades and fees for this address.
        </p>
      </header>

      {lagging === null ? null : <StaleNotice indexer={lagging} what="This page" />}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-8">
          <section aria-labelledby="launches-heading" className="flex flex-col gap-3">
            <h2 id="launches-heading" className="font-serif text-2xl leading-none">
              Launches
            </h2>
            {launches === undefined ? (
              <ReadUnavailable what="This address's launches" />
            ) : launches.length === 0 ? (
              <p className="rounded-card border border-border bg-surface px-5 py-8 text-center text-[13px] text-muted">
                This address has not created a launch.
              </p>
            ) : (
              <TokenGrid tokens={launches} label="Launches by this address" />
            )}
          </section>

          <section aria-labelledby="positions-heading" className="flex flex-col gap-3">
            <h2 id="positions-heading" className="font-serif text-2xl leading-none">
              Positions
            </h2>
            {positions === undefined ? (
              <ReadUnavailable what="This address's positions" />
            ) : (
              <PositionsTable
                rows={positions.rows}
                nextCursor={positions.nextCursor}
                /*
                  `.bind` PINS THE ADDRESS SERVER-SIDE so the client sends only a
                  cursor -- and the action re-validates the address anyway,
                  because a server action is a public endpoint. Passing this
                  prop is not optional decoration: without it `useKeysetRows`
                  reports `canLoadMore: false` and the page silently caps at 25
                  rows with nothing on screen saying so.
                */
                loadMore={loadMorePositions.bind(null, account)}
              />
            )}
          </section>

          <section aria-labelledby="trades-heading" className="flex flex-col gap-3">
            <h2 id="trades-heading" className="font-serif text-2xl leading-none">
              Trades
            </h2>
            {trades === undefined ? (
              <ReadUnavailable what="This address's trade history" />
            ) : (
              <>
                <TraderTradesTable
                  rows={trades.rows}
                  nextCursor={trades.nextCursor}
                  loadMore={loadMoreTraderTrades.bind(null, account)}
                />
                {/*
                  A LIMIT OF THE DATA, STATED WHERE IT MATTERS.

                  `trades.trader` is the curve's `msg.sender` on the curve path
                  and `Swap.sender` on the pool path -- and `Swap.sender` is the
                  ROUTER, not the wallet behind it. So once tokens graduate, a
                  wallet's pool trades will be filed under `ArcpadRouter` and
                  will not appear here. Nothing today is affected (no token has
                  graduated), and saying so is cheaper than letting someone
                  conclude their history is being dropped.
                */}
                <p className="text-[11px] text-muted" data-testid="trader-scope">
                  Pool trades are recorded against the swap's sender, which is the router rather
                  than the wallet behind it — so post-graduation trades will not be listed here.
                </p>
              </>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-6">
          {earnings === undefined ? (
            <ReadUnavailable what="Fee earnings" />
          ) : (
            /*
              THE OBJECT IS FORWARDED WHOLE. Not spread, not re-derived, not
              split into `rows` + `total`. Every place a total could be
              recomputed is a place it could be recomputed wrongly, and the
              number that would be wrong is the one a creator reads as
              "what I earned".
            */
            <EarningsPanel earnings={earnings}>
              {/*
                THE CLAIM ACTION READS `owed()` LIVE. The panel above shows the
                INDEXED figure, which can be minutes old; sending a claim
                against a stale non-zero balance costs gas to be told
                `NothingToClaim()`. Two different jobs, two different sources,
                and the panel says which is which.
              */}
              <ClaimPanel recipient={account} />
            </EarningsPanel>
          )}
        </div>
      </div>
    </div>
  )
}
