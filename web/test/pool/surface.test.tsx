import { render, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { resolveLifecycle } from '@/components/token/lifecycle'
import { TradeSurface } from '@/components/token/TradeSurface'
import { CURVE, TESTNET_PROFILE, TOKEN } from '../trade/fixtures'

/**
 * ============ WHICH VENUE A TOKEN TRADES ON, RENDERED ============
 *
 * The two panels are replaced by markers so this measures the DECISION rather
 * than the panels -- both of them reach wagmi, and a test that mounted them
 * would be measuring a mock provider instead of a branch.
 *
 * This is the half a source scan cannot give. `test/pool/page.test.ts` counts
 * the call sites; this runs the component they call.
 */
vi.mock('@/components/token/TradePanel', () => ({
  TradePanel: (props: { symbol: string }) => (
    <div data-testid="curve-panel" data-symbol={props.symbol} />
  ),
}))
vi.mock('@/components/token/PoolTradePanel', () => ({
  PoolTradePanel: (props: { token: string; symbol: string }) => (
    <div data-testid="pool-panel" data-token={props.token} data-symbol={props.symbol} />
  ),
}))

function surface(
  lifecycleInput: { complete: boolean; graduated: boolean },
  profile = TESTNET_PROFILE,
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
