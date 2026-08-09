import type { CurveProfile } from '@arcpad/shared/browser'
import type { HexAddress } from '@/components/read/types'
import type { Lifecycle } from './lifecycle'
import { PoolTradePanel } from './PoolTradePanel'
import { TradePanel } from './TradePanel'

/**
 * ==========================================================================
 *  ONE COMPONENT DECIDES WHICH VENUE A TOKEN TRADES ON. ONE, NOT TWO.
 * ==========================================================================
 *
 * `app/token/[address]/page.tsx` has TWO branches -- the indexer row and the
 * chain-drawn fallback -- and both of them must offer trading, because the
 * chain-drawn branch is what a user sees when the indexer is DOWN, which is
 * exactly when they most need the panel to keep working.
 *
 * This repository has shipped "fixed on one branch, forgotten on the other"
 * enough times to name it: `TradePanel` written and rendered by no page,
 * `CurveChart`'s realised layer, the two missing `loadMore*` props, the
 * `graduated` field the page did not pass, two switch controls on one composed
 * screen, and the same false sentence living in two components. Every one of
 * those had a green component test.
 *
 * So the venue choice is made HERE, once, and the page renders this component
 * on both branches. Forgetting the pool on one branch is no longer a thing that
 * can be done by omission -- it would take deleting a call site, which
 * `test/pool/page.test.ts` counts.
 *
 * ============ THE PROFILE IS OPTIONAL, AND THAT IS A REAL FIX ============
 *
 * The page used to write `profile === null ? null : <TradePanel …/>`. The pool
 * panel does not need a curve profile at all -- the curve is closed and the
 * pool's price comes from the router. Keeping that guard around both venues
 * would mean a graduated token loses its ONLY trading surface because a read it
 * does not use failed.
 */
export type TradeSurfaceProps = {
  readonly token: HexAddress
  readonly curve: HexAddress
  readonly lifecycle: Lifecycle
  /** `null` -> `getCurveProfile()` failed. Only the curve panel needs it. */
  readonly profile: CurveProfile | null
  readonly symbol: string
}

export function TradeSurface({ token, curve, lifecycle, profile, symbol }: TradeSurfaceProps) {
  /*
   * GRADUATED FIRST. `resolveLifecycle` already orders `graduated` above
   * `complete` because on chain `graduated => complete` always holds and a
   * stale indexer row can show them apart for a moment -- when it does, the
   * FURTHER state is the true one. Repeating that order here rather than
   * checking `complete` keeps one rule in one place.
   */
  if (lifecycle.kind === 'graduated') {
    return <PoolTradePanel token={token} symbol={symbol} />
  }
  if (profile === null) return null
  return (
    <TradePanel
      token={token}
      curve={curve}
      lifecycle={lifecycle}
      profile={profile}
      symbol={symbol}
    />
  )
}
