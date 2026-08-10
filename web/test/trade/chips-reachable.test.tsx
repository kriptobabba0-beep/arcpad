import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CurveProfile, CurveState, FeeBps, ProfileName } from '@arcpad/shared/browser'
import { TradePanel } from '@/components/token/TradePanel'
import type { HexAddress } from '@/components/read/types'
import { renderWithProviders } from '../ui/harness'
import {
  CURVE,
  PRODUCTION_FRESH,
  PRODUCTION_PROFILE,
  FEES,
  FRESH,
  TESTNET_PROFILE,
  TOKEN,
} from './fixtures'

/**
 * ==========================================================================
 *  ARE THE MONEY CHIPS REACHABLE FROM THE REAL PANEL?
 * ==========================================================================
 *
 * `test/trade/panel.test.tsx` presses the chips on `TradeForm` -- the PURE half
 * -- with `spendable` handed in as a prop. That measures the behaviour and says
 * NOTHING about whether the connected `TradePanel` ever draws the row, or draws
 * it with the gas reserve actually threaded through.
 *
 * That gap is this repository's most-shipped defect and the list is long
 * enough to be a rule: `TradePanel` itself carried 645 green tests while no
 * page rendered it; `CurveChart`'s realised layer never entered a DOM; two
 * switch controls sat on one composed screen with both component tests
 * passing. Every one of them was a correct component nobody had wired.
 *
 * So this file renders `TradePanel` -- the component with the hooks in it --
 * and measures the WIRING: the chips exist, the gas reserve reaches them
 * through `useGasReserve` -> `spendableFrom`, and pressing one puts text in the
 * real field.
 *
 * `useCurveState` and `useGasReserve` are mocked because jsdom has no chain.
 * What is NOT mocked is the thing under test: `TradePanel` computes
 * `spendableFrom(balance, gas.reserve)` and passes it on, and a panel that
 * forgot to pass it would render no chips and fail here.
 */

const chain = vi.hoisted(() => ({
  state: undefined as CurveState | undefined,
  fees: undefined as FeeBps | undefined,
  reserve: null as bigint | null,
  balanceWei: 0n,
}))

vi.mock('@/components/token/useCurveState', () => ({
  CURVE_STATE_POLL_MS: 2000,
  useCurveState: () => ({
    state: chain.state,
    fees: chain.fees,
    isPending: chain.state === undefined,
    refetch: () => {},
  }),
}))

vi.mock('@/components/token/useGasReserve', () => ({
  useGasReserve: () => ({
    reserve: chain.reserve,
    reason: chain.reserve === null ? 'no estimate in a test environment' : null,
  }),
}))

vi.mock('@/hooks/useUsdcBalance', () => ({
  useUsdcBalance: () => ({
    native: { wei: chain.balanceWei },
    erc20: { units: chain.balanceWei / 1_000_000_000_000n },
    isPending: false,
    refetch: () => {},
  }),
}))

function renderPanel(profile: CurveProfile, profileName: ProfileName) {
  return renderWithProviders(
    <TradePanel
      token={TOKEN as HexAddress}
      curve={CURVE as HexAddress}
      lifecycle={{ kind: 'trading' }}
      profile={profile}
      profileName={profileName}
      symbol="DIFF"
    />,
    { connected: true },
  )
}

beforeEach(() => {
  chain.state = PRODUCTION_FRESH
  chain.fees = FEES
  chain.reserve = 300_000_000_000_000n
  chain.balanceWei = 10_000n * 10n ** 18n
})

describe('the money chips are reachable from the connected panel', () => {
  it('draws the row, and pressing a chip fills the real amount field', async () => {
    const user = userEvent.setup()
    renderPanel(PRODUCTION_PROFILE, 'production')

    await waitFor(() => expect(screen.getByTestId('trade-panel')).toBeInTheDocument())
    const row = await screen.findByTestId('amount-chips')
    expect(row).toBeInTheDocument()

    await user.click(screen.getByTestId('chip-25'))
    expect(screen.getByRole('textbox', { name: /amount to spend/i })).toHaveValue('25.000000')
  })

  it('threads the GAS RESERVE through: a failed estimate removes the row', async () => {
    // The mutant this catches is `TradePanel` passing `balance.native.wei`
    // instead of `spendableFrom(...)`. With the reserve unmeasurable the chips
    // must vanish; a panel wired to the raw balance would keep drawing them and
    // would offer an amount that cannot pay for its own gas.
    chain.reserve = null
    const user = userEvent.setup()
    renderPanel(PRODUCTION_PROFILE, 'production')

    await waitFor(() => expect(screen.getByTestId('trade-panel')).toBeInTheDocument())
    expect(screen.queryByTestId('amount-chips')).toBeNull()
    // MAX is disabled for the same reason and SAYS so -- the two controls agree.
    expect(screen.getByTestId('max-button')).toBeDisabled()
    await user.click(screen.getByRole('tab', { name: /Receive tokens/ }))
    expect(screen.queryByTestId('amount-chips')).toBeNull()
  })

  it('drops the chips the reserve cannot cover, and keeps the ones it can', async () => {
    // Balance exactly $100. The reserve lives inside it, so $100 and $500 go
    // and $25 stays. Same rule, same place as MAX.
    chain.balanceWei = 100n * 10n ** 18n
    renderPanel(PRODUCTION_PROFILE, 'production')

    await waitFor(() => expect(screen.getByTestId('trade-panel')).toBeInTheDocument())
    await screen.findByTestId('chip-25')
    expect(screen.queryByTestId('chip-100')).toBeNull()
    expect(screen.queryByTestId('chip-500')).toBeNull()
  })

  it('draws the TESTNET ladder on the deployed profile, through the real panel', async () => {
    // The profile the site actually runs against, with the ladder that fits it.
    chain.state = FRESH
    renderPanel(TESTNET_PROFILE, 'testnet')

    await waitFor(() => expect(screen.getByTestId('trade-panel')).toBeInTheDocument())
    await screen.findByTestId('chip-1')
    expect(screen.getByTestId('chip-5')).toBeInTheDocument()
    expect(screen.getByTestId('chip-10')).toBeInTheDocument()
    // The production ladder's smallest chip is not here, and could not be.
    expect(screen.queryByTestId('chip-25')).toBeNull()
    expect(screen.getByTestId('max-button')).not.toBeDisabled()
  })

  it('SUPPRESSES the row when the ladder does not fit the curve it is given', async () => {
    // THE INVARIANT, at the composed level. Same testnet curve, production
    // ladder: nothing resolves, so nothing renders -- no dead buttons. This is
    // the assertion that must keep holding when a production curve is early and
    // shallow, which is the case no fixture can reach today.
    chain.state = FRESH
    renderPanel(TESTNET_PROFILE, 'production')

    await waitFor(() => expect(screen.getByTestId('trade-panel')).toBeInTheDocument())
    expect(screen.queryByTestId('amount-chips')).toBeNull()
    expect(screen.getByTestId('max-button')).not.toBeDisabled()
  })

  it('the percentage shortcuts are gone from the connected panel too', () => {
    // Removed, not merely unrendered by these props: the row they lived in no
    // longer exists.
    renderPanel(TESTNET_PROFILE, 'testnet')
    expect(screen.queryByTestId('amount-shortcuts')).toBeNull()
    for (const percent of [25, 50, 75]) {
      expect(screen.queryByTestId(`shortcut-${percent}`)).toBeNull()
    }
  })
})
