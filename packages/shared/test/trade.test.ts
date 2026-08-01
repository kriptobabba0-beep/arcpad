import { describe, expect, it } from 'vitest'
import { graduationRaise, poolSeedSupply, progressPpm } from '../src/curve'
import {
  asTok,
  asWei,
  type CurveProfile,
  type CurveState,
  type FeeBps,
  netProceedsOf,
  planBuyExactQuoteIn,
  planBuyExactTokensOut,
  planSellExactTokensIn,
  totalSpentOf,
  TRADE_ACTIONS,
  TradePlanError,
} from '../src/trade'

/**
 * THREE ENTRYPOINTS, THREE SETS OF TESTS.
 *
 * This file is organised by entrypoint and not by property ON PURPOSE. The
 * failure mode it is written against has hit this project eleven times: a
 * property proved on one entrypoint reads as proved on all of them. The three
 * planners take different arguments, guard different quantities, and only one
 * of them clamps -- there is no property here that transfers for free.
 */

const V = 4_292_000_000_000_000_000n
const T = 1_073_000_000n * 10n ** 18n
const S = 793_100_000n * 10n ** 18n

const PROFILE: CurveProfile = {
  virtualTokenReserves: T,
  virtualQuoteReserves: V,
  saleSupply: S,
}

const FEES: FeeBps = { protocolFeeBps: 95n, creatorFeeBps: 30n }

const CREATOR = '0x00000000000000000000000000000000000000c0'
const ZERO = '0x0000000000000000000000000000000000000000'

/** A FRESH curve: `vT - rT == T - S`, `vQ - rQ == V`, so `rT == S` and `rQ == 0`. */
function freshCurve(creator = CREATOR): CurveState {
  return {
    virtualTokenReserves: T,
    virtualQuoteReserves: V,
    realTokenReserves: asTok(S),
    realQuoteReserves: asWei(0n),
    complete: false,
    creator,
  }
}

/** The curve after the pinned 1 USDC `buyExactQuoteIn`. */
const TOKENS_FROM_ONE_USDC = 200_723_953_120_761_740_526_324_105n
const NET_FROM_ONE_USDC = 987_654_320_987_654_320n

function afterOneUsdcBuy(creator = CREATOR): CurveState {
  return {
    virtualTokenReserves: T - TOKENS_FROM_ONE_USDC,
    virtualQuoteReserves: V + NET_FROM_ONE_USDC,
    realTokenReserves: asTok(S - TOKENS_FROM_ONE_USDC),
    realQuoteReserves: asWei(NET_FROM_ONE_USDC),
    complete: false,
    creator,
  }
}

describe('the three actions are enumerated, and there are three', () => {
  it('TRADE_ACTIONS is the whole surface', () => {
    // Anti-vacuity for every `it.each` below that iterates the list.
    expect(TRADE_ACTIONS).toEqual(['buyExactQuoteIn', 'buyExactTokensOut', 'sellExactTokensIn'])
  })
})

// ==========================================================================
// buyExactQuoteIn
// ==========================================================================

describe('planBuyExactQuoteIn', () => {
  /**
   * THE PINNED VECTOR. 1.000000 USDC on a fresh testnet curve, zero slippage.
   * Every figure was derived from the chain algorithm by hand; see
   * `curve.test.ts` for the derivation.
   */
  it('spends exactly the budget on a 1 USDC buy and refunds nothing', () => {
    const plan = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 10n ** 18n, 0)
    expect(plan.action).toBe('buyExactQuoteIn')
    expect(plan.curveAmount).toBe(987_654_320_987_654_320n)
    expect(plan.protocolFee).toBe(9_382_716_049_382_717n)
    expect(plan.creatorFee).toBe(2_962_962_962_962_963n)
    expect(plan.tokens).toBe(TOKENS_FROM_ONE_USDC)
    expect(plan.refund).toBe(0n)
    expect(plan.clamped).toBe(false)
    expect(plan.value).toBe(10n ** 18n)
    expect(plan.boundKind).toBe('maxSpendIncludingFees')
    expect(plan.completesCurve).toBe(false)
    expect(totalSpentOf(plan)).toBe(10n ** 18n)
  })

  it('the calldata argument is minTokensOut, floored by the tolerance', () => {
    const zero = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 10n ** 18n, 0)
    expect(zero.args).toEqual([TOKENS_FROM_ONE_USDC])

    const onePercent = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 10n ** 18n, 100)
    // floor(tokens * 9900 / 10000), computed independently of the planner.
    expect(onePercent.args).toEqual([(TOKENS_FROM_ONE_USDC * 9_900n) / 10_000n])
    expect(onePercent.args[0]).toBeLessThan(TOKENS_FROM_ONE_USDC)
    // Slippage moves ONLY the guard. The quote itself does not move.
    expect(onePercent.tokens).toBe(zero.tokens)
    expect(onePercent.curveAmount).toBe(zero.curveAmount)
    expect(onePercent.value).toBe(zero.value)
  })

  it('the display figures come from the post-trade state', () => {
    const plan = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 10n ** 18n, 0)
    // Independently: progress of the reserve this trade leaves behind.
    expect(plan.progressPpmAfter).toBe(progressPpm(S - TOKENS_FROM_ONE_USDC, S))
    expect(plan.progressPpmAfter).toBe(253_087)
    // Price rises after a buy.
    expect(plan.priceAfterWeiPerToken).toBeGreaterThan(4_000_000_000n)
  })

  /**
   * THE CLAMP -- the property that exists ONLY on this entrypoint.
   *
   * A 20 USDC budget buys more than the curve holds. The reserve is sold whole
   * and the remainder refunded; the trade lands exactly where
   * `buyExactTokensOut(realTokenReserves)` would.
   */
  it('clamps a budget larger than the reserve and refunds the rest', () => {
    const plan = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 20n * 10n ** 18n, 0)
    expect(plan.clamped).toBe(true)
    expect(plan.tokens).toBe(S)
    expect(plan.curveAmount).toBe(12_161_433_369_060_378_707n)
    expect(plan.protocolFee).toBe(115_533_617_006_073_598n)
    expect(plan.creatorFee).toBe(36_484_300_107_181_137n)
    expect(plan.refund).toBe(7_686_548_713_826_366_558n)
    expect(totalSpentOf(plan)).toBe(12_313_451_286_173_633_442n)
    expect(plan.value).toBe(20n * 10n ** 18n)
  })

  it('THE CLAMPED curve amount is R + 1, which is where quoteBuyCost`s +1 shows', () => {
    const plan = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 20n * 10n ** 18n, 0)
    expect(plan.curveAmount).toBe(graduationRaise(S, V, T) + 1n)
  })

  it('the clamped trade COMPLETES the curve, and says so', () => {
    const plan = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 20n * 10n ** 18n, 0)
    expect(plan.completesCurve).toBe(true)
    expect(plan.progressPpmAfter).toBe(1_000_000)
    // And the pool seed that graduation will pay out is a pure function of the
    // profile, unchanged by how the curve was filled.
    expect(poolSeedSupply(S, T)).toBe(206_886_011_183_597_390_493_942_218n)
  })

  it('the budget guard is `<=`, never `==`', () => {
    // Equality holds on 99.95% of inputs at (95, 30) bps and only 75% at
    // (5000, 5000). A planner built on `== gross` would refuse a quarter of
    // trades at the high rate. Here: a gross where the correction does NOT fire
    // leaves one wei unspent, and the plan reports it as refund rather than
    // rejecting the trade.
    const plan = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 1_000_000_000_000n, 0)
    expect(totalSpentOf(plan)).toBeLessThanOrEqual(plan.value)
    expect(plan.value - totalSpentOf(plan)).toBeLessThanOrEqual(1n)
  })

  it('refuses a completed curve by the contract`s own name', () => {
    const done = { ...freshCurve(), complete: true }
    expect(() => planBuyExactQuoteIn(done, PROFILE, FEES, 10n ** 18n, 0)).toThrow(TradePlanError)
    expect(() => planBuyExactQuoteIn(done, PROFILE, FEES, 10n ** 18n, 0)).toThrow('CurveComplete')
  })

  it('refuses a budget too small to buy anything', () => {
    expect(() => planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 2n, 0)).toThrow('NetTooSmall')
    expect(() => planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 1n, 0)).toThrow('NetTooSmall')
    // ...and ZERO is a DIFFERENT refusal, with the contract's own name for it.
    expect(() => planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 0n, 0)).toThrow('ZeroQuoteIn')
  })
})

// ==========================================================================
// buyExactTokensOut
// ==========================================================================

describe('planBuyExactTokensOut', () => {
  /** THE PINNED VECTOR: 1,000,000 tokens on a fresh curve, zero slippage. */
  it('quotes one million tokens', () => {
    const plan = planBuyExactTokensOut(freshCurve(), PROFILE, FEES, 10n ** 24n, 0)
    expect(plan.action).toBe('buyExactTokensOut')
    expect(plan.curveAmount).toBe(4_003_731_343_283_583n)
    expect(plan.protocolFee).toBe(38_035_447_761_195n)
    expect(plan.creatorFee).toBe(12_011_194_029_851n)
    expect(plan.tokens).toBe(10n ** 24n)
    expect(totalSpentOf(plan)).toBe(4_053_777_985_074_629n)
  })

  /**
   * `value == maxQuoteIn`, AND THE CAP IS FEE-INCLUSIVE.
   *
   * The contract refuses on `total > maxQuoteIn` OR `total > msg.value`. A cap
   * computed on the curve amount alone would sit 1.25% BELOW the total and
   * revert every trade at zero slippage -- the mutation is silent in any test
   * that only checks the curve figure.
   */
  it('sends msg.value equal to the fee-INCLUSIVE cap', () => {
    const plan = planBuyExactTokensOut(freshCurve(), PROFILE, FEES, 10n ** 24n, 0)
    expect(plan.value).toBe(4_053_777_985_074_629n)
    expect(plan.value).toBe(totalSpentOf(plan))
    expect(plan.args).toEqual([10n ** 24n, 4_053_777_985_074_629n])
    expect(plan.boundKind).toBe('maxSpendIncludingFees')
    expect(plan.refund).toBe(0n)
    // A cap on the curve amount alone would be BELOW the total. Spelled out so
    // the difference is a number, not a claim.
    expect(plan.curveAmount).toBeLessThan(plan.value)
  })

  it('the cap CEILS, so a tolerance never caps below the quote', () => {
    const plan = planBuyExactTokensOut(freshCurve(), PROFILE, FEES, 10n ** 24n, 100)
    const total = 4_053_777_985_074_629n
    const expected = (total * 10_100n + 9_999n) / 10_000n
    expect(plan.value).toBe(expected)
    expect(plan.value).toBeGreaterThan(total)
    expect(plan.refund).toBe(expected - total)
    // The quote does not move with the tolerance; only the cap does.
    expect(plan.curveAmount).toBe(4_003_731_343_283_583n)
  })

  it('REVERTS at the boundary rather than clamping -- this is not buyExactQuoteIn', () => {
    const fresh = freshCurve()
    // The whole reserve is fine...
    expect(() => planBuyExactTokensOut(fresh, PROFILE, FEES, S, 0)).not.toThrow()
    // ...one more is not, and it is NOT clamped.
    expect(() => planBuyExactTokensOut(fresh, PROFILE, FEES, S + 1n, 0)).toThrow(
      'NotEnoughTokensToBuy',
    )
    expect(planBuyExactTokensOut(fresh, PROFILE, FEES, S, 0).clamped).toBe(false)
  })

  it('buying the whole reserve completes the curve and costs R + 1', () => {
    const plan = planBuyExactTokensOut(freshCurve(), PROFILE, FEES, S, 0)
    expect(plan.curveAmount).toBe(12_161_433_369_060_378_707n)
    expect(plan.completesCurve).toBe(true)
    expect(plan.progressPpmAfter).toBe(1_000_000)
  })

  it('refuses a completed curve and a zero amount', () => {
    const done = { ...freshCurve(), complete: true }
    expect(() => planBuyExactTokensOut(done, PROFILE, FEES, 10n ** 24n, 0)).toThrow('CurveComplete')
    expect(() => planBuyExactTokensOut(freshCurve(), PROFILE, FEES, 0n, 0)).toThrow('ZeroTokensOut')
  })
})

// ==========================================================================
// sellExactTokensIn
// ==========================================================================

describe('planSellExactTokensIn', () => {
  /**
   * THE HONESTY VECTOR. A user who buys with 1.000000 USDC and sells straight
   * back receives 0.975308 USDC -- a round-trip loss of 24_691_358_024_691_361
   * wei, 2.4691%. Two fee legs, and the screen has to say so.
   */
  it('a full round trip returns 0.975308 USDC on 1.000000 in', () => {
    const plan = planSellExactTokensIn(afterOneUsdcBuy(), PROFILE, FEES, TOKENS_FROM_ONE_USDC, 0)
    expect(plan.action).toBe('sellExactTokensIn')
    expect(plan.curveAmount).toBe(987_654_320_987_654_319n)
    expect(plan.protocolFee).toBe(9_382_716_049_382_717n)
    expect(plan.creatorFee).toBe(2_962_962_962_962_963n)
    expect(netProceedsOf(plan)).toBe(975_308_641_975_308_639n)
    expect(10n ** 18n - netProceedsOf(plan)).toBe(24_691_358_024_691_361n)
  })

  /**
   * `minQuoteOut` GUARDS THE NET, FEES ALREADY DEDUCTED.
   *
   * The contract compares it against `netOut`, not against the pre-fee
   * proceeds. Guarding the proceeds would set the floor ~1.25% above anything
   * that can ever arrive, and every sell at zero slippage would revert.
   */
  it('the guard is the NET received, not the pre-fee proceeds', () => {
    const plan = planSellExactTokensIn(afterOneUsdcBuy(), PROFILE, FEES, TOKENS_FROM_ONE_USDC, 0)
    expect(plan.value).toBe(0n) // a sell sends no value
    expect(plan.boundKind).toBe('minReceiveAfterFees')
    expect(plan.args).toEqual([TOKENS_FROM_ONE_USDC, 975_308_641_975_308_639n])
    // The number the guard is NOT: the pre-fee proceeds.
    expect(plan.args[1]).not.toBe(plan.curveAmount)
    expect(plan.args[1]).toBeLessThan(plan.curveAmount)
    expect(plan.refund).toBe(0n)
  })

  it('the tolerance FLOORS the minimum received', () => {
    const plan = planSellExactTokensIn(afterOneUsdcBuy(), PROFILE, FEES, TOKENS_FROM_ONE_USDC, 100)
    const net = 975_308_641_975_308_639n
    expect(plan.args).toEqual([TOKENS_FROM_ONE_USDC, (net * 9_900n) / 10_000n])
    expect(plan.args[1]).toBeLessThan(net)
    // The quote does not move with the tolerance.
    expect(netProceedsOf(plan)).toBe(net)
  })

  it('a sell moves the price DOWN and progress BACKWARD', () => {
    const state = afterOneUsdcBuy()
    const plan = planSellExactTokensIn(state, PROFILE, FEES, TOKENS_FROM_ONE_USDC, 0)
    expect(plan.priceAfterWeiPerToken).toBe(4_000_000_000n) // back to the opening price
    expect(plan.progressPpmAfter).toBe(0)
    expect(plan.completesCurve).toBe(false) // a sell can never complete a curve
  })

  it('refuses a sale too small to cover its own fees', () => {
    // Both fee parts round UP, so for proceeds of 1 or 2 they swallow the whole
    // amount. The contract calls this ProceedsTooSmall and so does the planner.
    expect(() => planSellExactTokensIn(afterOneUsdcBuy(), PROFILE, FEES, 1n, 0)).toThrow(
      'ProceedsTooSmall',
    )
  })

  it('refuses zero and a completed curve', () => {
    expect(() => planSellExactTokensIn(afterOneUsdcBuy(), PROFILE, FEES, 0n, 0)).toThrow(
      'ZeroTokensIn',
    )
    const done = { ...afterOneUsdcBuy(), complete: true }
    expect(() => planSellExactTokensIn(done, PROFILE, FEES, 1n, 0)).toThrow('CurveComplete')
  })

  it('netProceedsOf and totalSpentOf refuse the wrong side', () => {
    const sell = planSellExactTokensIn(afterOneUsdcBuy(), PROFILE, FEES, TOKENS_FROM_ONE_USDC, 0)
    const buy = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 10n ** 18n, 0)
    expect(() => totalSpentOf(sell)).toThrow(RangeError)
    expect(() => netProceedsOf(buy)).toThrow(RangeError)
  })
})

// ==========================================================================
// The zero-creator branch, on ALL THREE. One does not cover another.
// ==========================================================================

describe('a curve with no creator charges NO creator fee, on every entrypoint', () => {
  /**
   * Faz 1c measured this on the contract: the `buyExactQuoteIn` x `creator == 0`
   * cell had never been walked, and dropping the ternary broke that entrypoint
   * PERMANENTLY. In the port the same omission does worse than mis-label a fee
   * line: `correctedNetQuoteIn` returns a different net, so the TOKEN COUNT is
   * wrong too. Three separate tests, three entrypoints -- deliberately not one
   * loop, because the assertions differ.
   */
  it('buyExactQuoteIn: creator fee zero, protocol share UNCHANGED in rate', () => {
    const withCreator = planBuyExactQuoteIn(freshCurve(CREATOR), PROFILE, FEES, 10n ** 18n, 0)
    const without = planBuyExactQuoteIn(freshCurve(ZERO), PROFILE, FEES, 10n ** 18n, 0)

    expect(without.creatorFee).toBe(0n)
    expect(withCreator.creatorFee).toBe(2_962_962_962_962_963n)

    // The net is computed at 95 bps rather than 125, so it is LARGER and the
    // buyer gets MORE tokens. Derived by hand:
    //   net = floor(1e18 * 10_000 / 10_095) = 990_589_400_693_412_580
    //   protocolFee = ceil(net * 95 / 1e4)  =   9_410_599_306_587_420
    //   990_589_400_693_412_580 + 9_410_599_306_587_420 = 1_000_000_000_000_000_000
    expect(without.curveAmount).toBe(990_589_400_693_412_580n)
    expect(without.protocolFee).toBe(9_410_599_306_587_420n)
    expect(without.curveAmount + without.protocolFee).toBe(10n ** 18n)
    expect(without.tokens).toBeGreaterThan(withCreator.tokens)
    // The creator share is NOT folded into the protocol share.
    expect(without.protocolFee).toBeLessThan(withCreator.protocolFee + withCreator.creatorFee)
  })

  it('buyExactTokensOut: creator fee zero, curve amount and protocol fee IDENTICAL', () => {
    const withCreator = planBuyExactTokensOut(freshCurve(CREATOR), PROFILE, FEES, 10n ** 24n, 0)
    const without = planBuyExactTokensOut(freshCurve(ZERO), PROFILE, FEES, 10n ** 24n, 0)

    expect(without.creatorFee).toBe(0n)
    // On THIS entrypoint the principal is the curve cost, which does not depend
    // on the fee rate -- so unlike buyExactQuoteIn, both other figures match.
    expect(without.curveAmount).toBe(withCreator.curveAmount)
    expect(without.protocolFee).toBe(withCreator.protocolFee)
    expect(without.tokens).toBe(withCreator.tokens)
    // And the cap drops by exactly the creator fee that is no longer charged.
    expect(withCreator.value - without.value).toBe(12_011_194_029_851n)
  })

  it('sellExactTokensIn: creator fee zero, and the seller receives MORE', () => {
    const withCreator = planSellExactTokensIn(
      afterOneUsdcBuy(CREATOR),
      PROFILE,
      FEES,
      TOKENS_FROM_ONE_USDC,
      0,
    )
    const without = planSellExactTokensIn(
      afterOneUsdcBuy(ZERO),
      PROFILE,
      FEES,
      TOKENS_FROM_ONE_USDC,
      0,
    )

    expect(without.creatorFee).toBe(0n)
    expect(without.curveAmount).toBe(withCreator.curveAmount)
    expect(without.protocolFee).toBe(withCreator.protocolFee)
    expect(netProceedsOf(without) - netProceedsOf(withCreator)).toBe(2_962_962_962_962_963n)
  })

  it('the zero address is matched case-insensitively', () => {
    const upper = freshCurve('0x0000000000000000000000000000000000000000'.toUpperCase())
    expect(planBuyExactQuoteIn(upper, PROFILE, FEES, 10n ** 18n, 0).creatorFee).toBe(0n)
  })
})

// ==========================================================================
// Properties that must hold on ALL THREE, asserted on all three.
// ==========================================================================

describe('invariants across all three entrypoints', () => {
  const plans = () => ({
    buyExactQuoteIn: planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 10n ** 18n, 0),
    buyExactTokensOut: planBuyExactTokensOut(freshCurve(), PROFILE, FEES, 10n ** 24n, 0),
    sellExactTokensIn: planSellExactTokensIn(
      afterOneUsdcBuy(),
      PROFILE,
      FEES,
      TOKENS_FROM_ONE_USDC,
      0,
    ),
  })

  it('every action in TRADE_ACTIONS has a planner and it reports its own name', () => {
    const built = plans()
    // Anti-vacuity for the loops below: the map covers the enumerated surface.
    expect(Object.keys(built).sort()).toEqual([...TRADE_ACTIONS].sort())
    for (const action of TRADE_ACTIONS) {
      expect(built[action].action).toBe(action)
    }
  })

  it('the fee is SUMMED FROM PARTS on all three, never one combined ceil', () => {
    for (const [action, plan] of Object.entries(plans())) {
      const combined = (plan.curveAmount * 125n + 9_999n) / 10_000n
      const summed = plan.protocolFee + plan.creatorFee
      expect(summed, `${action} must sum the two parts`).toBe(
        (plan.curveAmount * 95n + 9_999n) / 10_000n + (plan.curveAmount * 30n + 9_999n) / 10_000n,
      )
      // ...and on these principals the two methods actually differ, so the
      // assertion above is not satisfied by both.
      expect(summed, `${action}: the combined rate would be a different number`).not.toBe(combined)
    }
  })

  it('slippage never moves the quote, only the guard', () => {
    const zero = plans()
    const loose = {
      buyExactQuoteIn: planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 10n ** 18n, 500),
      buyExactTokensOut: planBuyExactTokensOut(freshCurve(), PROFILE, FEES, 10n ** 24n, 500),
      sellExactTokensIn: planSellExactTokensIn(
        afterOneUsdcBuy(),
        PROFILE,
        FEES,
        TOKENS_FROM_ONE_USDC,
        500,
      ),
    }
    for (const action of TRADE_ACTIONS) {
      expect(loose[action].curveAmount, action).toBe(zero[action].curveAmount)
      expect(loose[action].protocolFee, action).toBe(zero[action].protocolFee)
      expect(loose[action].creatorFee, action).toBe(zero[action].creatorFee)
      expect(loose[action].tokens, action).toBe(zero[action].tokens)
    }
  })

  it('an out-of-range tolerance is refused on all three', () => {
    for (const slip of [-1, 10_001, 1.5]) {
      expect(() => planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, 10n ** 18n, slip)).toThrow(
        RangeError,
      )
      expect(() => planBuyExactTokensOut(freshCurve(), PROFILE, FEES, 10n ** 24n, slip)).toThrow(
        RangeError,
      )
      expect(() =>
        planSellExactTokensIn(afterOneUsdcBuy(), PROFILE, FEES, TOKENS_FROM_ONE_USDC, slip),
      ).toThrow(RangeError)
    }
  })

  it('a completed curve is refused on all three, by name', () => {
    for (const state of [{ ...freshCurve(), complete: true }]) {
      expect(() => planBuyExactQuoteIn(state, PROFILE, FEES, 10n ** 18n, 0)).toThrow(
        'CurveComplete',
      )
      expect(() => planBuyExactTokensOut(state, PROFILE, FEES, 10n ** 24n, 0)).toThrow(
        'CurveComplete',
      )
      expect(() => planSellExactTokensIn(state, PROFILE, FEES, 1n, 0)).toThrow('CurveComplete')
    }
  })

  it('a buy never spends more than its value; a sell spends nothing', () => {
    const built = plans()
    expect(totalSpentOf(built.buyExactQuoteIn)).toBeLessThanOrEqual(built.buyExactQuoteIn.value)
    expect(totalSpentOf(built.buyExactTokensOut)).toBeLessThanOrEqual(built.buyExactTokensOut.value)
    expect(built.sellExactTokensIn.value).toBe(0n)
  })

  /**
   * A DETERMINISTIC SWEEP over the budget family, not a sampler whose reach was
   * assumed. Every 0.000001-USDC step from 0.000001 to 0.001 USDC -- the whole
   * quantised bottom of the input range -- must satisfy the budget invariant
   * and produce a positive token count.
   */
  it('SWEEP: the budget invariant holds across the quantised bottom of the range', () => {
    const quantum = 10n ** 12n
    let planned = 0
    for (let i = 1n; i <= 1_000n; i += 1n) {
      const plan = planBuyExactQuoteIn(freshCurve(), PROFILE, FEES, i * quantum, 0)
      expect(totalSpentOf(plan)).toBeLessThanOrEqual(plan.value)
      expect(plan.value - totalSpentOf(plan)).toBeLessThanOrEqual(1n)
      expect(plan.tokens).toBeGreaterThan(0n)
      expect(plan.clamped).toBe(false)
      planned += 1
    }
    // Anti-vacuity, and the point of quantisation: NOT ONE of the thousand
    // smallest accepted inputs reverts. The quantum (1e12 wei) sits far above
    // NetTooSmall's 3-wei ceiling.
    expect(planned).toBe(1_000)
  })
})
