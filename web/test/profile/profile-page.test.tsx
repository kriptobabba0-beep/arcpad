import { formatUsdcAmount } from '@arcpad/shared/browser'
import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadResult } from '@/lib/read'
import { renderWithProviders } from '../ui/harness'
import { CLIMBING } from '../fixtures/readModel'
import {
  ATTRIBUTED_WEI,
  CLAIMED_WEI,
  CREATOR,
  DEPOSITED_WEI,
  EARNINGS,
  NO_EARNINGS,
  POSITIONS,
  PREFIX_DEPOSIT_WEI,
  TRADES,
} from './fixtures'

/**
 * ==========================================================================
 *  THE PAGE, NOT THE PANEL.
 * ==========================================================================
 *
 * This repository's number-one defect is "a property covered on one entrypoint
 * reads as covered on all of them" -- eleven instances, three of them in
 * `web/` in four days, including the same false sentence living in two
 * components. `<EarningsPanel>` is easy to test in isolation with a hand-made
 * object, and such a test proves NOTHING about whether the page hands it the
 * right one: the token page's `graduated` branch was green in exactly that way
 * while `app/token/[address]/page.tsx` never passed the field.
 *
 * So these tests render `app/profile/[address]/page.tsx` ITSELF -- the real
 * default export, awaited, with the real components underneath -- and mock only
 * the boundary the page cannot cross in a test process: `@/lib/read`, which
 * reaches Postgres. Everything between that boundary and the DOM is the
 * production path.
 *
 * The SQL on the other side of that boundary is proved separately and against a
 * REAL Postgres in `packages/db/test/analytics.test.ts`, including the exact
 * arithmetic these fixtures encode.
 */

vi.mock('@/lib/read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/read')>()
  return {
    ...actual,
    readCreatorEarnings: vi.fn(),
    readLaunchesByCreator: vi.fn(),
    readPositions: vi.fn(),
    readTraderTrades: vi.fn(),
  }
})

const read = await import('@/lib/read')
const { default: ProfilePage } = await import('@/app/profile/[address]/page')

/** A fresh indexer, so no staleness notice interferes with the assertions. */
const FRESH = {
  stale: false as const,
  lastBlock: 55_900_000n,
  updatedAt: new Date(),
  blocksBehind: 0n,
}

function fresh<T>(data: T): ReadResult<T> {
  return { ok: true, stale: false, data, indexer: FRESH as never }
}

function unavailable<T>(): ReadResult<T> {
  return { ok: false, reason: 'unavailable', indexer: null }
}

function mocks() {
  return {
    earnings: vi.mocked(read.readCreatorEarnings),
    launches: vi.mocked(read.readLaunchesByCreator),
    positions: vi.mocked(read.readPositions),
    trades: vi.mocked(read.readTraderTrades),
  }
}

async function renderProfile(address = CREATOR) {
  const element = await ProfilePage({ params: Promise.resolve({ address }) })
  return renderWithProviders(element)
}

beforeEach(() => {
  const m = mocks()
  m.earnings.mockResolvedValue(fresh(EARNINGS))
  m.launches.mockResolvedValue(fresh([CLIMBING]))
  m.positions.mockResolvedValue(fresh({ rows: POSITIONS, nextCursor: null }))
  m.trades.mockResolvedValue(fresh({ rows: TRADES, nextCursor: null }))
})

describe('the earnings total on the composed page', () => {
  /**
   * =====================================================================
   *  THE ONE ASSERTION THIS WHOLE TRACK EXISTS FOR.
   * =====================================================================
   *
   * "Earned, all time" must be the ESCROW LEDGER's number
   * (`depositedTotalWei`), never the sum of the per-launch breakdown. The
   * fixture makes those two DIFFERENT on purpose -- they differ by
   * 36 496 595 214 216 153 wei, the shared escrow's pre-factory prefix as
   * measured on chain -- so a panel that summed the rows would render a
   * DIFFERENT string here and this test would fail. With an
   * `attributed === deposited` fixture it could not.
   */
  it('shows the LEDGER total, not the sum of the launch rows', async () => {
    await renderProfile()

    const earned = screen.getByText('Earned, all time').closest('div')?.parentElement
    expect(earned).not.toBeNull()
    expect(within(earned as HTMLElement).getByText(fmt(DEPOSITED_WEI))).toBeInTheDocument()

    // AND NOT the attributable sum. The two strings differ; asserting the
    // absence of the wrong one is what makes the presence of the right one
    // meaningful.
    expect(fmt(DEPOSITED_WEI)).not.toBe(fmt(ATTRIBUTED_WEI))
    expect(within(earned as HTMLElement).queryByText(fmt(ATTRIBUTED_WEI))).toBeNull()
  })

  it('the claimable figure is deposited minus claimed, from the same ledger', async () => {
    await renderProfile()
    const claimable = screen.getByText('Claimable now').closest('div')?.parentElement
    expect(
      within(claimable as HTMLElement).getByText(fmt(DEPOSITED_WEI - CLAIMED_WEI)),
    ).toBeInTheDocument()
  })

  /**
   * THE RESIDUAL IS DRAWN, NOT SWALLOWED -- ON THE PAGE.
   *
   * `listCreatorEarningsByLaunch`'s docstring names the rule for its first
   * caller: show the rows as a breakdown, take the total from the ledger, and
   * NAME the difference. This is the third clause, asserted where a user would
   * read it.
   */
  it('names the unattributed remainder and explains where it comes from', async () => {
    await renderProfile()
    const box = screen.getByTestId('earnings-unattributed')
    expect(within(box).getByText('Not attributed')).toBeInTheDocument()
    expect(within(box).getByText(fmt(PREFIX_DEPOSIT_WEI))).toBeInTheDocument()
    expect(box).toHaveTextContent(/superseded factory/i)
    expect(box).toHaveTextContent(/pool fees/i)
    // AND it says the money is still theirs. A residual presented as a loss
    // would be a different, and wrong, sentence.
    expect(box).toHaveTextContent(/claimable/i)
  })

  it('the identity attributed + unattributed = earned is on screen', async () => {
    await renderProfile()
    const identity = screen.getByTestId('earnings-identity')
    expect(identity).toHaveTextContent(fmt(ATTRIBUTED_WEI))
    expect(identity).toHaveTextContent(fmt(PREFIX_DEPOSIT_WEI))
    expect(identity).toHaveTextContent(fmt(DEPOSITED_WEI))
  })

  it('every breakdown row is drawn and links to its token', async () => {
    await renderProfile()
    const panel = screen.getByTestId('earnings-panel')
    for (const row of EARNINGS.byLaunch) {
      const link = within(panel).getByRole('link', { name: row.symbol })
      expect(link).toHaveAttribute('href', `/token/${row.token}`)
    }
  })

  it('an address the escrow never paid gets a sentence, not zeros', async () => {
    mocks().earnings.mockResolvedValue(fresh(NO_EARNINGS))
    await renderProfile()
    expect(screen.getByTestId('earnings-none')).toBeInTheDocument()
    expect(screen.queryByTestId('earnings-unattributed')).toBeNull()
    // No "Claimable now: 0.000000" row: a wallet that has never earned is not
    // a wallet with a zero balance, and the two sentences are different.
    expect(screen.queryByText('Claimable now')).toBeNull()
  })

  /**
   * A NEGATIVE RESIDUAL IS A BROKEN LEDGER AND IS SAID SO.
   *
   * `unattributedWei` keeps its SIGN. Clamping it to zero would make a
   * divergence between `fee_events` and `fee_balances` look tidy -- and the
   * tidy version is indistinguishable from a healthy one.
   */
  it('a ledger smaller than the breakdown is reported, not clamped', async () => {
    mocks().earnings.mockResolvedValue(fresh({ ...EARNINGS, unattributedWei: -1_000_000_000_000n }))
    await renderProfile()
    const box = screen.getByTestId('earnings-unattributed')
    expect(within(box).getByText('Ledger disagrees')).toBeInTheDocument()
    expect(box).toHaveTextContent(/authoritative/i)
  })
})

describe('the page composes the four sections', () => {
  it('renders launches, positions, trades and fees together', async () => {
    await renderProfile()
    expect(screen.getByRole('heading', { name: 'Launches' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Positions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Trades' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Creator fees' })).toBeInTheDocument()
  })

  /**
   * THE CLAIM PANEL IS MOUNTED BY THE PAGE.
   *
   * `claim` has been an `ArcpadAction` in `web/lib/failureTable.ts` since Task
   * 14 -- with `claim:NothingToClaim`, `claim:TransferFailed` and
   * `claim:ZeroRecipient` all mapped -- and had ZERO callers. The error surface
   * existed; the button did not. This asserts the mount; `claim.test.tsx`
   * asserts the states.
   *
   * The `owed()` read points at a dead RPC in this harness, so the panel is in
   * `loading` or `unavailable`. Both are proof of mounting, and demanding one
   * of them would be asserting a race.
   */
  it('mounts the claim panel for the profile address', async () => {
    await renderProfile()
    const loading = screen.queryByTestId('claim-loading')
    const unavailableBox = screen.queryByTestId('claim-unavailable')
    expect(loading ?? unavailableBox).not.toBeNull()
  })

  it('positions carry balance, marginal value and the curve state', async () => {
    await renderProfile()
    const table = screen.getByRole('table', { name: 'Token positions' })
    // The column header states what the value IS. "Value" alone would read as
    // sale proceeds, which it is not: selling walks the curve down.
    expect(within(table).getAllByText('Value at last price').length).toBeGreaterThan(0)
    for (const position of POSITIONS) {
      const link = within(table).getByRole('link', { name: position.symbol })
      expect(link).toHaveAttribute('href', `/token/${position.token}`)
      expect(within(table).getByText(fmt(position.valueWei))).toBeInTheDocument()
    }
    // The lifecycle is per row, and the two states are DIFFERENT words.
    expect(within(table).getByText('Complete')).toBeInTheDocument()
    expect(within(table).getByText('Trading')).toBeInTheDocument()
  })

  it('trades show the venue from the row and both fee parts summed for display', async () => {
    await renderProfile()
    const table = screen.getByRole('table', { name: 'Trade history' })
    // The venue comes from `row.source`; both fixtures are curve rows.
    expect(within(table).getAllByText('Curve')).toHaveLength(TRADES.length)
    // "Curve amount", not "spent": fees are EXCLUDED from `quote_amount_wei`,
    // so a wallet-facing label would be wrong by exactly the fee.
    expect(within(table).getAllByText('Curve amount').length).toBeGreaterThan(0)
    for (const trade of TRADES) {
      // Fees are summed FOR DISPLAY only; the parts stay separate in the row.
      expect(
        within(table).getByText(fmtUp(trade.protocolFeeWei + trade.creatorFeeWei)),
      ).toBeInTheDocument()
    }
  })

  it('states the router limitation on pool trades rather than dropping them silently', async () => {
    await renderProfile()
    expect(screen.getByTestId('trader-scope')).toHaveTextContent(/router/i)
  })

  /**
   * ONE SECTION FALLING OVER DOES NOT TAKE THE OTHERS.
   *
   * Four independent `guard`ed reads; `Promise.all` is on the RESULTS. A page
   * that blanked because one query timed out would have thrown away the half
   * that still worked -- and on this page the half that still worked can be a
   * claimable balance.
   */
  it('degrades per section', async () => {
    mocks().positions.mockResolvedValue(unavailable())
    await renderProfile()
    expect(screen.getByText(/This address's positions/)).toBeInTheDocument()
    // The fee panel is untouched.
    expect(screen.getByTestId('earnings-panel')).toBeInTheDocument()
  })

  it('lower-cases the address before querying, and asks for the SAME one everywhere', async () => {
    const m = mocks()
    await renderProfile('0xE92C64C4F36216EA773F2622F6D5F8530AE92FD2')
    for (const fn of [m.earnings, m.launches, m.positions, m.trades]) {
      expect(fn.mock.calls[0]?.[0]).toBe(CREATOR)
    }
  })
})

/** Same formatter the components use; a hand-rolled copy could drift from it. */
function fmt(wei: bigint): string {
  return formatUsdcAmount(wei, { rounding: 'down' })
}

/** Costs round UP. A cell that rounds the other way is a different string. */
function fmtUp(wei: bigint): string {
  return formatUsdcAmount(wei, { rounding: 'up' })
}
