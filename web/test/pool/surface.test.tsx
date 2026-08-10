import { render, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { resolveLifecycle } from '@/components/token/lifecycle'
import { TradeSurface } from '@/components/token/TradeSurface'
import { CURVE, PRODUCTION_PROFILE, TESTNET_PROFILE, TOKEN } from '../trade/fixtures'

/**
 * ============ WHICH VENUE A TOKEN TRADES ON, RENDERED ============
 *
 * The two panels are replaced by markers so this measures the DECISION rather
 * than the panels -- both of them reach wagmi, and a test that mounted them
 * would be measuring a mock provider instead of a branch.
 *
 * This is the half a source scan cannot give. `test/pool/page.test.ts` counts
 * the call sites; this runs the component they call.
 *
 * ============ A BARE `render`, AND WHY IT IS BACK ============
 *
 * This file briefly used `renderWithProviders` because `TradeSurface` had been
 * made a client component to own a `Market | Limit | Orders` strip -- a tab
 * selection is browser state, so the component reached `useArcNetwork` and a
 * bare `render` died with `WagmiProviderNotFoundError`.
 *
 * The strip is gone with limit orders, and with it the only reason this
 * component was ever a client component. A bare `render` is the stronger test:
 * it would FAIL if somebody reintroduced a wagmi hook here, which is exactly
 * the change that should have to be argued for. What this file asserts has not
 * moved in either direction -- it is the VENUE DECISION, and the panels stay
 * faked so the decision is measured apart from them.
 */
vi.mock('@/components/token/TradePanel', () => ({
  TradePanel: (props: {
    symbol: string
    profileName: string
    profile: { virtualQuoteReserves: bigint }
  }) => (
    <div
      data-testid="curve-panel"
      data-symbol={props.symbol}
      data-profile-name={props.profileName}
      data-v={String(props.profile.virtualQuoteReserves)}
    />
  ),
}))
vi.mock('@/components/token/PoolTradePanel', () => ({
  PoolTradePanel: (props: { token: string; symbol: string }) => (
    <div data-testid="pool-panel" data-token={props.token} data-symbol={props.symbol} />
  ),
}))

function surface(
  lifecycleInput: { complete: boolean; graduated: boolean },
  // TRIPLE AND NAME TRAVEL AS ONE READING -- see `TradeSurface`'s prop. The
  // ladder for the money chips is chosen by the name, every quote by the
  // triple, so the two may never be passed separately.
  profile: {
    name: 'testnet' | 'production'
    profile: typeof TESTNET_PROFILE
    graduationTarget: `0x${string}`
  } | null = {
    name: 'testnet',
    profile: TESTNET_PROFILE,
    // Unset, matching the live testnet factory. This surface does not read it
    // -- it travels because it arrives in the same factory read as the pair
    // above, and splitting the reading is what the comment above forbids.
    graduationTarget: '0x0000000000000000000000000000000000000000',
  },
) {
  return render(
    <TradeSurface
      token={TOKEN}
      curve={CURVE}
      lifecycle={resolveLifecycle(lifecycleInput)}
      profile={profile}
      symbol="DIFF"
    />,
  )
}

describe('the venue choice', () => {
  it('a trading curve gets the CURVE panel', () => {
    const q = within(surface({ complete: false, graduated: false }).container)
    expect(q.getByTestId('curve-panel')).toBeInTheDocument()
    expect(q.queryByTestId('pool-panel')).toBeNull()
  })

  it('a COMPLETE but ungraduated curve still gets the curve panel', () => {
    // The curve panel is what draws the receipt for the trade that closed it,
    // and there is no pool to trade in yet.
    const q = within(surface({ complete: true, graduated: false }).container)
    expect(q.getByTestId('curve-panel')).toBeInTheDocument()
    expect(q.queryByTestId('pool-panel')).toBeNull()
  })

  /**
   * THE GAP THIS WHOLE TRACK EXISTS TO CLOSE. Before `TradeSurface`, a
   * graduated token had NO trading surface: the curve panel correctly renders
   * nothing once the curve is complete, and no page drew a pool panel. The
   * first token to graduate would have had a live v4 pool that no wallet could
   * reach.
   */
  it('a GRADUATED token gets the POOL panel, with its token address', () => {
    const q = within(surface({ complete: true, graduated: true }).container)
    expect(q.getByTestId('pool-panel')).toBeInTheDocument()
    expect(q.getByTestId('pool-panel').getAttribute('data-token')).toBe(TOKEN)
    expect(q.getByTestId('pool-panel').getAttribute('data-symbol')).toBe('DIFF')
    expect(q.queryByTestId('curve-panel')).toBeNull()
  })

  it('a stale row showing graduated-but-not-complete still gets the POOL panel', () => {
    // `resolveLifecycle` puts `graduated` first because on chain
    // `graduated => complete` always holds; when a stale row shows them apart,
    // the FURTHER state is the true one.
    const q = within(surface({ complete: false, graduated: true }).container)
    expect(q.getByTestId('pool-panel')).toBeInTheDocument()
  })
})

describe('the curve profile is only the curve’s business', () => {
  it('a graduated token keeps its pool panel when the profile read FAILED', () => {
    // The page used to write `profile === null ? null : <TradePanel/>`. Applied
    // to both venues, a failed read of a value the pool does not use would cost
    // a graduated token its only trading surface.
    const q = within(surface({ complete: true, graduated: true }, null as never).container)
    expect(q.getByTestId('pool-panel')).toBeInTheDocument()
  })

  it('CONTROL: a trading curve WITHOUT a profile still renders nothing', () => {
    // Without this the guard could have been deleted outright, which would
    // hand `TradePanel` a null profile and crash the page.
    const q = within(surface({ complete: false, graduated: false }, null as never).container)
    expect(q.queryByTestId('curve-panel')).toBeNull()
    expect(q.queryByTestId('pool-panel')).toBeNull()
  })
})

/**
 * ==========================================================================
 *  THE PROFILE NAME IS FORWARDED, NOT INVENTED
 * ==========================================================================
 *
 * ADDED AFTER A SURVIVING MUTANT. Replacing `profileName={profile.name}` in
 * `TradeSurface` with the literal `"production"` passed all 356 tests: the
 * money-chip ladder is chosen by that name, every test that exercised the
 * ladder built `TradePanel` directly, and NOTHING measured the one hop between
 * them. That is this repository's most-repeated defect -- a property covered on
 * one entrypoint reading as covered on all -- and it appeared inside the fix
 * that was keying the ladder off the profile in the first place.
 *
 * Both profiles are asserted. One would not do it: a hardcoded `"production"`
 * passes a production-only test, and a hardcoded `"testnet"` passes a
 * testnet-only one.
 */
describe('the profile name reaches the curve panel', () => {
  const nameOn = (identified: {
    name: 'testnet' | 'production'
    profile: typeof TESTNET_PROFILE
  }) =>
    within(
      surface(
        { complete: false, graduated: false },
        // The target is irrelevant to what this block asserts, so it is
        // supplied here rather than threaded through every case.
        { ...identified, graduationTarget: '0x0000000000000000000000000000000000000000' },
      ).container,
    ).getByTestId('curve-panel')

  it('forwards testnet as testnet', () => {
    const panel = nameOn({ name: 'testnet', profile: TESTNET_PROFILE })
    expect(panel).toHaveAttribute('data-profile-name', 'testnet')
    expect(panel).toHaveAttribute('data-v', String(TESTNET_PROFILE.virtualQuoteReserves))
  })

  it('forwards production as production', () => {
    const panel = nameOn({ name: 'production', profile: PRODUCTION_PROFILE })
    expect(panel).toHaveAttribute('data-profile-name', 'production')
    expect(panel).toHaveAttribute('data-v', String(PRODUCTION_PROFILE.virtualQuoteReserves))
  })

  it('keeps the name and the triple together', () => {
    // The pairing is the invariant: the ladder is chosen by the name and every
    // quote computed from the triple, so a panel handed one profile's name with
    // the other's numbers would offer chips it cannot fill.
    const panel = nameOn({ name: 'production', profile: PRODUCTION_PROFILE })
    expect(panel.getAttribute('data-v')).not.toBe(String(TESTNET_PROFILE.virtualQuoteReserves))
  })
})
