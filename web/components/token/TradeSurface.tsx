import type { HexAddress } from '@/components/read/types'
import type { IdentifiedProfile } from '@/lib/profile'
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
 *
 * ==========================================================================
 *  THERE IS NO TAB STRIP HERE, AND THAT IS THE DECISION -- NOT AN OMISSION
 * ==========================================================================
 *
 * A `Market | Limit | Orders` strip was built on top of this component and has
 * been REMOVED along with limit orders themselves. The requirement for it never
 * came from the protocol: it traced to a reference SCREENSHOT
 * (`docs/plans/2026-07-30-arcpad-phase4-frontend.md:20` records the strip as
 * something the screenshots had), and the venue it was a strip OVER does not
 * exist -- arcpad has exactly one place to trade a given token at a given
 * moment, which is precisely what this component computes below.
 *
 * SO THERE IS NO "Market" LABEL EITHER. Phase 4 wrote the rule this obeys --
 * *"a tab that does nothing when clicked is worse than a tab that isn't
 * there"* -- and `Tabs.tsx` turned it into a component contract. A strip of ONE
 * is the same defect wearing a different shape: it promises a choice, and then
 * there is nothing to choose. The only control a trader needs on this screen is
 * `Buy | Sell`, and that control lives INSIDE the panel that owns the trade
 * (`TradePanel` on the curve, `PoolTradePanel` on the pool) because that is
 * where the direction actually changes the calldata.
 *
 * A CONSEQUENCE WORTH NAMING: this file is a SERVER component again. The strip
 * was the only reason it was ever `'use client'` -- a selected tab is browser
 * state -- and with the strip gone the wrapper does no client work at all.
 * Both panels below carry their own `'use client'`.
 */
export type TradeSurfaceProps = {
  readonly token: HexAddress
  readonly curve: HexAddress
  readonly lifecycle: Lifecycle
  /**
   * `null` -> `getCurveProfile()` failed. Only the curve panel needs it.
   *
   * THE TRIPLE AND ITS NAME TRAVEL TOGETHER, as one object, because they are
   * one reading: `getCurveProfile()` reads `T`/`V`/`S` off the factory AND
   * hashes them against `PROFILE_DIGESTS` to name the profile. Two separate
   * props would admit a pair that disagrees -- production numbers under a
   * testnet name -- and the money-chip ladder is chosen by the name while every
   * quote is computed from the triple, so a mismatch would be spendable.
   *
   * `import type` on purpose: `@/lib/profile` is server-only (it pulls the
   * address book, which opens `node:fs`), and a type-only import is erased
   * before anything is emitted.
   */
  readonly profile: IdentifiedProfile | null
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
      profile={profile.profile}
      profileName={profile.name}
      symbol={symbol}
    />
  )
}
