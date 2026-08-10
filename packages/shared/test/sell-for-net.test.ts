import { describe, expect, it } from 'vitest'
import { quoteBuyTokensOut, quoteSellProceeds } from '../src/curve'
import {
  asTok,
  asWei,
  type CurveProfile,
  type CurveState,
  type FeeBps,
  netProceedsOf,
  planSellExactTokensIn,
  resolveSellForNet,
} from '../src/trade'

/**
 * ==========================================================================
 *  "SELL $50 WORTH" -- AND THE DIRECTION IS THE WHOLE TEST
 * ==========================================================================
 *
 * A money chip on the sell side names USDC; the field takes TOKENS. The
 * conversion is a curve inversion, and the mutant this file exists for is the
 * one that inverts the WRONG DIRECTION: `quoteBuyTokensOut` divides by
 * `vQ + net` and `quoteSellProceeds` by `vT + tokensIn`. Both return a token
 * quantity of the right order of magnitude for the right money, so a screenshot
 * review passes and the user sells the wrong amount.
 *
 * `sells the amount a BUY of that money would have produced` below is that
 * mutant, written out and asserted against.
 */

const V = 4_292_000_000_000_000_000n
const T = 1_073_000_000n * 10n ** 18n
const S = 793_100_000n * 10n ** 18n
const ONE_USDC = 1_000_000_000_000_000_000n

const PROFILE: CurveProfile = {
  virtualTokenReserves: T,
  virtualQuoteReserves: V,
  saleSupply: S,
}
const FEES: FeeBps = { protocolFeeBps: 95n, creatorFeeBps: 30n }
const CREATOR = '0x00000000000000000000000000000000000000c0'
const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * A curve carrying real quote. The virtual reserves have CLIMBED, which matters
 * here: the sell ceiling is `virtualQuoteReserves` and a fresh curve's is only
 * 4.292 USDC.
 */
function loadedCurve(vQ: bigint, creator = CREATOR): CurveState {
  // Reserves consistent with `vQ - rQ == V` and the curve identity.
  const rQ = vQ - V
  const tokensSold = quoteBuyTokensOut(rQ, V, T)
  return {
    virtualTokenReserves: T - tokensSold,
    virtualQuoteReserves: vQ,
    realTokenReserves: asTok(S - tokensSold),
    realQuoteReserves: asWei(rQ),
    complete: false,
    creator,
  }
}

const HELD = S / 2n

describe('resolveSellForNet reaches the target', () => {
  it('returns a tokensIn whose sell plan actually realises the target', () => {
    const state = loadedCurve(V + 3n * ONE_USDC)
    const target = ONE_USDC / 2n

    const found = resolveSellForNet(state, PROFILE, FEES, target, HELD)
    expect(found.ok).toBe(true)
    if (!found.ok) return

    // THE VERIFY-FORWARD GUARANTEE, re-measured through the planner that will
    // quote the trade. `resolveSellForNet` promises `netOut >= target`, and a
    // promise about money is worth measuring rather than reading.
    const plan = planSellExactTokensIn(state, PROFILE, FEES, found.tokensIn, 0)
    expect(netProceedsOf(plan)).toBe(found.netOut)
    expect(netProceedsOf(plan)).toBeGreaterThanOrEqual(target)
  })

  it('is MINIMAL: one base unit less falls short', () => {
    const state = loadedCurve(V + 3n * ONE_USDC)
    const target = ONE_USDC / 2n
    const found = resolveSellForNet(state, PROFILE, FEES, target, HELD)
    expect(found.ok).toBe(true)
    if (!found.ok) return

    // A resolver that simply returned the whole holding would satisfy every
    // other assertion in this file. This is the one it cannot pass.
    const oneLess = planSellExactTokensIn(state, PROFILE, FEES, found.tokensIn - 1n, 0)
    expect(netProceedsOf(oneLess)).toBeLessThan(target)
  })

  it('does NOT sell the amount a BUY of that money would have produced', () => {
    // THE DIRECTION MUTANT. `quoteBuyTokensOut(net, vQ, vT)` is what "$X of
    // this token" means on the BUY side. On the sell side it is simply a
    // different number, and it is SMALLER -- the curve pays less for tokens
    // than it charges for them, which is the spread the fees sit on top of.
    const state = loadedCurve(V + 3n * ONE_USDC)
    const target = ONE_USDC / 2n
    const found = resolveSellForNet(state, PROFILE, FEES, target, HELD)
    expect(found.ok).toBe(true)
    if (!found.ok) return

    const buySideAnswer = quoteBuyTokensOut(
      target,
      state.virtualQuoteReserves,
      state.virtualTokenReserves,
    )
    expect(found.tokensIn).not.toBe(buySideAnswer)
    expect(found.tokensIn).toBeGreaterThan(buySideAnswer)

    // And the buy-side answer would UNDERDELIVER: the user asked for half a
    // dollar and would have been handed less.
    const wrong = planSellExactTokensIn(state, PROFILE, FEES, buySideAnswer, 0)
    expect(netProceedsOf(wrong)).toBeLessThan(target)
  })

  it('targets the NET, not the pre-fee proceeds', () => {
    // Targeting `quoteSellProceeds` instead would hand the user ~1.25% less
    // than the chip promised on every single press.
    const state = loadedCurve(V + 3n * ONE_USDC)
    const target = ONE_USDC
    const found = resolveSellForNet(state, PROFILE, FEES, target, HELD)
    expect(found.ok).toBe(true)
    if (!found.ok) return

    const preFee = quoteSellProceeds(
      found.tokensIn,
      state.virtualQuoteReserves,
      state.virtualTokenReserves,
    )
    expect(preFee).toBeGreaterThan(target)
    expect(found.netOut).toBeGreaterThanOrEqual(target)
  })

  it('honours a zero creator: the same target needs FEWER tokens', () => {
    // The creator share is 30 bps of the proceeds and it does NOT fold into the
    // protocol share. With no creator the seller keeps it, so less token buys
    // the same dollar.
    const vQ = V + 3n * ONE_USDC
    const withCreator = resolveSellForNet(loadedCurve(vQ), PROFILE, FEES, ONE_USDC, HELD)
    const without = resolveSellForNet(loadedCurve(vQ, ZERO), PROFILE, FEES, ONE_USDC, HELD)
    expect(withCreator.ok && without.ok).toBe(true)
    if (!withCreator.ok || !without.ok) return
    expect(without.tokensIn).toBeLessThan(withCreator.tokensIn)
  })
})

describe('resolveSellForNet refuses, and says WHICH refusal', () => {
  it('reason "holding" when the user is short but the curve could pay', () => {
    const state = loadedCurve(V + 3n * ONE_USDC)
    // Holding a thousandth of the supply against a one-dollar target.
    const found = resolveSellForNet(state, PROFILE, FEES, ONE_USDC, S / 100_000n)
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.reason).toBe('holding')
    // The best it COULD realise is reported, because "you are short" is only
    // actionable next to how short.
    expect(found.bestNetOut).toBeGreaterThan(0n)
    expect(found.bestNetOut).toBeLessThan(ONE_USDC)
  })

  it('reason "curve" when NOBODY could get that much out, even holding everything', () => {
    // THE CEILING, and it is the finding that decided the ladder. Sell proceeds
    // are `x*vQ/(vT+x)`, which approaches `virtualQuoteReserves` and never
    // reaches it. On a fresh testnet curve that asymptote is 4.292 USDC, so a
    // $25 target is unreachable for EVERY holder at EVERY holding.
    const state = loadedCurve(V + 1n * ONE_USDC)
    const found = resolveSellForNet(state, PROFILE, FEES, 25n * ONE_USDC, S)
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.reason).toBe('curve')
  })

  it('the ceiling is virtualQuoteReserves, and selling the ENTIRE supply stays under it', () => {
    const state = loadedCurve(V + 1n * ONE_USDC)
    const everything = quoteSellProceeds(S, state.virtualQuoteReserves, state.virtualTokenReserves)
    expect(everything).toBeLessThan(state.virtualQuoteReserves)
    // And the two refusals are NOT interchangeable: this one is about the
    // curve, so reporting `holding` here would tell the user to go buy more
    // token -- advice that cannot work.
    const found = resolveSellForNet(state, PROFILE, FEES, 25n * ONE_USDC, S)
    expect(found.ok ? null : found.reason).toBe('curve')
  })

  it('a zero holding is "holding", not a crash', () => {
    const state = loadedCurve(V + 3n * ONE_USDC)
    const found = resolveSellForNet(state, PROFILE, FEES, ONE_USDC, 0n)
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.reason).toBe('holding')
    expect(found.bestNetOut).toBe(0n)
  })

  it('refuses a non-positive target rather than searching for one', () => {
    const state = loadedCurve(V + 3n * ONE_USDC)
    expect(() => resolveSellForNet(state, PROFILE, FEES, 0n, HELD)).toThrow(RangeError)
    expect(() => resolveSellForNet(state, PROFILE, FEES, -1n, HELD)).toThrow(RangeError)
  })
})

describe('resolveSellForNet over a range of targets', () => {
  it('never returns a tokensIn above the holding, and never one that underdelivers', () => {
    const state = loadedCurve(V + 3n * ONE_USDC)
    // A sweep rather than one point: the verify-forward step exists because the
    // predicate dips by one unit at isolated points, and a single sample would
    // not meet one.
    for (let i = 1n; i <= 40n; i++) {
      const target = (ONE_USDC * i) / 20n
      const found = resolveSellForNet(state, PROFILE, FEES, target, HELD)
      if (!found.ok) continue
      expect(found.tokensIn).toBeLessThanOrEqual(HELD)
      expect(found.tokensIn).toBeGreaterThan(0n)
      const net = netProceedsOf(planSellExactTokensIn(state, PROFILE, FEES, found.tokensIn, 0))
      expect(net).toBeGreaterThanOrEqual(target)
    }
  })

  it('is monotone in the target: more money never needs fewer tokens', () => {
    const state = loadedCurve(V + 3n * ONE_USDC)
    let previous = 0n
    for (let i = 1n; i <= 20n; i++) {
      const found = resolveSellForNet(state, PROFILE, FEES, (ONE_USDC * i) / 20n, HELD)
      if (!found.ok) continue
      expect(found.tokensIn).toBeGreaterThanOrEqual(previous)
      previous = found.tokensIn
    }
  })
})
