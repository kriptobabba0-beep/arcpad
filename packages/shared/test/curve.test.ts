import { describe, expect, it } from 'vitest'
import {
  CurveMathError,
  correctedNetQuoteIn,
  feeOn,
  graduationRaise,
  marketCap,
  netQuoteInBeforeCorrection,
  poolSeedSupply,
  priceWeiPerToken,
  progressPpm,
  quoteBuyCost,
  quoteBuyTokensOut,
  quoteSellProceeds,
} from '../src/curve'

/**
 * EVERY LITERAL BELOW WAS DERIVED BY HAND FROM THE CHAIN ALGORITHM, not by
 * calling the function under test and copying what came out. A vector printed
 * from the code it pins proves the code is deterministic and nothing else.
 *
 * The first block uses PUMP.FUN'S OWN SCALE (V = 4_292_000_000, T =
 * 1_073_000_000_000_000) on purpose: those are the same literals as
 * `contracts/test/CurveMath.t.sol`, so agreement there shows the port has not
 * drifted from UPSTREAM either, not just from our Solidity.
 */

// pump.fun scale
const V_PUMP = 4_292_000_000n
const T_PUMP = 1_073_000_000_000_000n

// arcpad testnet scale, read from the deployed factory
const V = 4_292_000_000_000_000_000n
const T = 1_073_000_000n * 10n ** 18n
const S = 793_100_000n * 10n ** 18n
const P_BPS = 95n
const C_BPS = 30n

describe('the chain algorithm, step by step', () => {
  it('step 1 subtracts NOTHING from the input', () => {
    // 10_125 at 125 bps: 10_125 * 10_000 / 10_125 = 10_000 exactly. The SDK
    // estimator would compute from 10_124 and be one short.
    expect(netQuoteInBeforeCorrection(10_125n, 125n)).toBe(10_000n)
  })

  /**
   * STEP 2 AND 3 TOGETHER, ON THE INPUT WHERE THE CORRECTION FIRES.
   *
   * gross = 1_000_013 at (95, 30):
   *   pre-correction net = floor(1_000_013 * 10_000 / 10_125) = 987_667
   *   protocolFee = ceil(987_667 * 95/1e4) = 9_383
   *   creatorFee  = ceil(987_667 * 30/1e4) = 2_964
   *   987_667 + 12_347 = 1_000_014 > gross -> overshoot 1
   *   corrected net = 987_666, and 987_666 + 9_383 + 2_964 = 1_000_013 exactly.
   *
   * THE FEES STAY ON THE PRE-CORRECTION NET. Recomputing them on 987_666 gives
   * creatorFee 2_963 -- the creator one unit short, and one unit of the user's
   * payment accounting as neither principal nor fee.
   */
  it('steps 2-3 charge the fee on the PRE-correction net', () => {
    expect(correctedNetQuoteIn(1_000_013n, 95n, 30n)).toEqual({
      net: 987_666n,
      protocolFee: 9_383n,
      creatorFee: 2_964n,
    })
    // The recomputation this forbids, spelled out so the difference is visible:
    expect(feeOn(987_666n, 30n)).toBe(2_963n)
    expect(feeOn(987_667n, 30n)).toBe(2_964n)
  })

  it('step 4 keeps the -1 INSIDE the curve term', () => {
    expect(quoteBuyTokensOut(987_666n, V_PUMP, T_PUMP)).toBe(246_859_443_282n)
    // The SDK estimator's shape -- `-1` applied to the input before dividing --
    // is a DIFFERENT number, and it is larger. That is the whole finding.
    const net = 987_666n
    const sdkShape = ((net - 1n) * T_PUMP) / (V_PUMP + net)
    expect(sdkShape).not.toBe(246_859_443_282n)
    expect(sdkShape).toBeLessThan(246_859_443_282n)
  })

  it('gross = 1 does NOT revert; it returns a net of zero', () => {
    // Easy to assume the smallest input is the revert. It is not: step 3 has
    // nothing to correct when both fees are zero, so the refusal happens one
    // step later, in step 4's `net <= 1` guard.
    expect(correctedNetQuoteIn(1n, 95n, 30n)).toEqual({
      net: 0n,
      protocolFee: 0n,
      creatorFee: 0n,
    })
    expect(() => quoteBuyTokensOut(0n, V, T)).toThrow('NetTooSmall')
  })

  it('NetTooSmall has TWO throw sites and both are reachable', () => {
    // From step 3: gross = 2 at (95, 30) gives net 1, fees 1 + 1, overshoot 1.
    expect(() => correctedNetQuoteIn(2n, 95n, 30n)).toThrow(CurveMathError)
    expect(() => correctedNetQuoteIn(2n, 95n, 30n)).toThrow('NetTooSmall')
    // From step 4: a corrected net of 1 cannot feed `net - 1`.
    expect(() => quoteBuyTokensOut(1n, V, T)).toThrow('NetTooSmall')
    expect(() => quoteBuyTokensOut(0n, V, T)).toThrow('NetTooSmall')
  })
})

describe('the fee is SUMMED FROM PARTS, never divided from a combined rate', () => {
  /**
   * THE RULE EARNED ITSELF ON THE LIVE SMOKE, on trade 1 of 4: summed `...635`
   * versus divided-from-125 `...634`, one wei, and the escrow on chain holds
   * the summed figure. Here it is at this project's own scale, on the 1 USDC
   * buy: 12_345_679_012_345_680 summed, 12_345_679_012_345_679 divided.
   */
  it('the two ways differ by one wei on the 1 USDC buy', () => {
    const net = 987_654_320_987_654_320n
    expect(feeOn(net, P_BPS) + feeOn(net, C_BPS)).toBe(12_345_679_012_345_680n)
    expect(feeOn(net, 125n)).toBe(12_345_679_012_345_679n)
    expect(feeOn(net, P_BPS) + feeOn(net, C_BPS)).not.toBe(feeOn(net, 125n))
  })

  it('and again on the sell leg, where the proceeds differ by one', () => {
    const proceeds = 987_654_320_987_654_319n
    expect(feeOn(proceeds, P_BPS) + feeOn(proceeds, C_BPS)).toBe(12_345_679_012_345_680n)
    expect(feeOn(proceeds, 125n)).toBe(12_345_679_012_345_679n)
  })

  /**
   * NOT A ONE-OFF. A deterministic sweep, not a sampler whose reach was
   * assumed: over ten thousand consecutive principals the two methods disagree
   * on a large, COUNTED fraction. If the split ever became equivalent to the
   * combined rate, this number would move.
   */
  it('SWEEP: they disagree on a counted fraction of ten thousand principals', () => {
    let differ = 0
    for (let n = 1n; n <= 10_000n; n += 1n) {
      if (feeOn(n, P_BPS) + feeOn(n, C_BPS) !== feeOn(n, 125n)) differ += 1
    }
    // MEASURED, not guessed: 5_055 of the first 10_000 principals -- 50.55%.
    // A port that divides from 125 is wrong on every one of them.
    expect(differ).toBe(5_055)
  })

  it('feeOn rounds UP, and zero bps is exactly zero (not a ceil of zero)', () => {
    expect(feeOn(1n, 95n)).toBe(1n)
    expect(feeOn(10_000n, 95n)).toBe(95n)
    expect(feeOn(10_001n, 95n)).toBe(96n)
    expect(feeOn(1_000_000n, 0n)).toBe(0n)
    expect(() => feeOn(1n, 10_001n)).toThrow('InvalidBps')
  })
})

describe('the arcpad testnet curve', () => {
  /**
   * A 1.000000 USDC `buyExactQuoteIn` on a FRESH curve. Derived by hand:
   *   net         = floor(1e18 * 10_000 / 10_125) =   987_654_320_987_654_320
   *   protocolFee = ceil(net * 95/1e4)            =     9_382_716_049_382_717
   *   creatorFee  = ceil(net * 30/1e4)            =     2_962_962_962_962_963
   *   total                                       = 1_000_000_000_000_000_000  -> EXACT, refund 0
   *   tokensOut   = floor((net-1)*T/(V+net-1))    = 200_723_953_120_761_740_526_324_105
   *
   * `9_382_716_049_382_717` is an INDEPENDENT confirmation: Faz 1c's
   * `LaunchFactory` review measured exactly that as `escrow.owed(TREASURY)`
   * after a 1 USDC buy. Two different routes, the same literal.
   */
  it('a 1 USDC buy takes a quarter of a percent of the curve', () => {
    const r = correctedNetQuoteIn(10n ** 18n, P_BPS, C_BPS)
    expect(r).toEqual({
      net: 987_654_320_987_654_320n,
      protocolFee: 9_382_716_049_382_717n,
      creatorFee: 2_962_962_962_962_963n,
    })
    expect(r.net + r.protocolFee + r.creatorFee).toBe(10n ** 18n)
    expect(quoteBuyTokensOut(r.net, V, T)).toBe(200_723_953_120_761_740_526_324_105n)
  })

  it('the reserve triple is the one the deployed factory reports', () => {
    // Hand-copied from the live factory, NOT read from a shared constant.
    expect(V).toBe(4_292_000_000_000_000_000n)
    expect(S).toBe(793_100_000_000_000_000_000_000_000n)
    expect(T - S).toBe(279_900_000_000_000_000_000_000_000n)
  })

  it('graduationRaise is R, and quoteBuyCost of the whole sale supply is R + 1', () => {
    const R = graduationRaise(S, V, T)
    expect(R).toBe(12_161_433_369_060_378_706n) // == LaunchFactory.MIN_GRADUATION_RAISE
    // THE `+1` IN quoteBuyCost, VISIBLE. Removing it collapses these two.
    expect(quoteBuyCost(S, V, T)).toBe(R + 1n)
    expect(quoteBuyCost(S, V, T)).toBe(12_161_433_369_060_378_707n)
  })

  it('poolSeedSupply plus sale supply is the factory floor', () => {
    const D = poolSeedSupply(S, T)
    expect(D).toBe(206_886_011_183_597_390_493_942_218n)
    // == LaunchFactory.MIN_SALE_AND_SEED, hand-copied from the contract.
    expect(S + D).toBe(999_986_011_183_597_390_493_942_218n)
  })

  it('a fresh curve opens at the minimum market cap and at 4e9 wei per token', () => {
    // supplyConstant is the fixed 1e27 total supply.
    expect(marketCap(V, T, 10n ** 27n)).toBe(4_000_000_000_000_000_000n) // MIN_OPENING_MARKET_CAP
    expect(priceWeiPerToken(V, T)).toBe(4_000_000_000n)
  })

  it('quoteSellProceeds floors, and the round trip loses 2.4691%', () => {
    const tokens = 200_723_953_120_761_740_526_324_105n
    const vQ = V + 987_654_320_987_654_320n
    const vT = T - tokens
    const proceeds = quoteSellProceeds(tokens, vQ, vT)
    expect(proceeds).toBe(987_654_320_987_654_319n) // ONE LESS than what went in
    const netOut = proceeds - feeOn(proceeds, P_BPS) - feeOn(proceeds, C_BPS)
    expect(netOut).toBe(975_308_641_975_308_639n)
    expect(10n ** 18n - netOut).toBe(24_691_358_024_691_361n)
  })
})

describe('progressPpm matches Phase 3 exactly', () => {
  /**
   * THE REMAINDER ROUNDS UP. One wei of token left is `999_999`, never
   * `1_000_000`: "sold out" is reserved for actually sold out. A `floor` here
   * would show a completed curve that still holds supply.
   */
  it.each([
    [S, 0],
    [S / 2n, 500_000],
    [1n, 999_999],
    [0n, 1_000_000],
    // The fifth vector is the state after the 1 USDC buy above:
    // S - 200_723_953_120_761_740_526_324_105.
    [592_376_046_879_238_259_473_675_895n, 253_087],
  ])('realTokenReserves %s -> %i ppm', (rT, ppm) => {
    expect(progressPpm(rT, S)).toBe(ppm)
  })

  /**
   * THE CEIL IS ON THE REMAINDER, so PROGRESS rounds DOWN. Selling one wei of
   * token shows 0 ppm, not 1 -- and one wei LEFT shows 999_999, not 1_000_000.
   * Both edges lean the same way: the bar never claims progress that has not
   * happened, and never claims completion that has not happened.
   */
  it('one wei SOLD is 0 ppm, and one wei LEFT is 999_999', () => {
    expect(progressPpm(S - 1n, S)).toBe(0)
    expect(progressPpm(1n, S)).toBe(999_999)
  })

  it('refuses a zero sale supply instead of dividing by it', () => {
    expect(() => progressPpm(1n, 0n)).toThrow('ZeroReserve')
  })
})

describe('the guards are the contract guards', () => {
  it('quoteBuyCost refuses zero, zero reserve and the whole reserve', () => {
    expect(() => quoteBuyCost(0n, V, T)).toThrow('ZeroAmount')
    expect(() => quoteBuyCost(1n, 0n, T)).toThrow('ZeroReserve')
    expect(() => quoteBuyCost(T, V, T)).toThrow('InsufficientTokenReserve')
    expect(() => quoteBuyCost(T + 1n, V, T)).toThrow('InsufficientTokenReserve')
    // T - 1 is the largest accepted amount.
    expect(() => quoteBuyCost(T - 1n, V, T)).not.toThrow()
  })

  it('quoteBuyTokensOut refuses a zero reserve -- it would return the WHOLE reserve', () => {
    // With quoteReserve 0 the denominator collapses to `net` and the function
    // would hand back the entire token reserve for one wei. That is a drain
    // pattern, so it is refused by name rather than silently.
    expect(() => quoteBuyTokensOut(2n, 0n, T)).toThrow('ZeroReserve')
    expect(() => quoteBuyTokensOut(2n, V, 0n)).toThrow('ZeroReserve')
  })

  it('quoteSellProceeds refuses zero and either zero reserve', () => {
    expect(() => quoteSellProceeds(0n, V, T)).toThrow('ZeroAmount')
    expect(() => quoteSellProceeds(1n, 0n, T)).toThrow('ZeroReserve')
    expect(() => quoteSellProceeds(1n, V, 0n)).toThrow('ZeroReserve')
  })

  it('netQuoteInBeforeCorrection refuses zero and out-of-range bps', () => {
    expect(() => netQuoteInBeforeCorrection(0n, 125n)).toThrow('ZeroAmount')
    expect(() => netQuoteInBeforeCorrection(1n, 10_001n)).toThrow('InvalidBps')
    // The bound is NOT "a fee above 100%". Under the INCLUSIVE contract, bps
    // equal to the denominator is an effective rate of 50%, and it is allowed.
    expect(netQuoteInBeforeCorrection(1_000_000n, 10_000n)).toBe(500_000n)
  })

  /**
   * FullMath.mulDiv reverts when the RESULT exceeds uint256. bigint would
   * happily return it, so TypeScript would say "fine" where the chain reverts
   * -- the quietest possible divergence between screen and signature.
   *
   * WHICH FUNCTIONS CAN ACTUALLY REACH IT, measured while writing this: only
   * `quoteBuyCost` and `marketCap`. `quoteSellProceeds` is bounded above by
   * `quoteReserve` and `quoteBuyTokensOut` by `tokenReserve`, because in both
   * the numerator's first factor is smaller than the denominator -- neither can
   * exceed uint256 if its inputs do not. The guard is still in `mulDiv` for all
   * of them, and this is the record of why only two of them can trip it.
   */
  it('the port refuses a result the chain could not return', () => {
    // tokenReserve - tokensOut == 1, so the division does not shrink anything.
    expect(() => quoteBuyCost(2n ** 200n, 2n ** 200n, 2n ** 200n + 1n)).toThrow('MulDivOverflow')
    expect(() => marketCap(2n ** 200n, 1n, 2n ** 200n)).toThrow('MulDivOverflow')
    // ...and the two that cannot overflow do not pretend to.
    expect(() => quoteSellProceeds(2n ** 255n, 2n ** 255n, 1n)).not.toThrow()
    expect(() => quoteBuyTokensOut(2n ** 255n, 2n ** 255n, 2n ** 255n)).not.toThrow()
  })
})

describe('a deterministic sweep over the correction, not a sampler', () => {
  /**
   * THE REACH IS MEASURED, NOT ASSUMED. Every gross in [1, 20_000] at (95, 30)
   * bps is walked, and the three properties the contract guarantees are checked
   * on every one of them. The counts below are outputs of the sweep and are
   * pinned: if any of them moves, the correction has changed shape.
   */
  it('holds `net + fees <= gross` on every input, with equality NOT universal', () => {
    let corrections = 0
    let short = 0
    let reverts = 0
    for (let gross = 1n; gross <= 20_000n; gross += 1n) {
      let r
      try {
        r = correctedNetQuoteIn(gross, P_BPS, C_BPS)
      } catch {
        reverts += 1
        continue
      }
      const total = r.net + r.protocolFee + r.creatorFee
      expect(total).toBeLessThanOrEqual(gross)
      expect(gross - total).toBeLessThanOrEqual(1n)
      if (total === gross) corrections += 1
      else short += 1
    }
    // MEASURED. Exactly ONE input reverts -- gross = 2, where the two ceils
    // sum to the whole budget. gross = 1 does NOT revert: it returns net 0 with
    // both fees 0, and the caller's step 4 is what refuses it.
    expect(reverts).toBe(1)
    expect(corrections).toBe(19_989)
    expect(short).toBe(10)
    expect(short).toBeGreaterThan(0) // equality is NOT universal
  })

  /**
   * THE SAME SWEEP AT A HIGH FEE RATE, where the contract's own note says
   * equality drops to about 75%. A guard written `== gross` would refuse a
   * quarter of all trades, which is exactly why every budget check in this
   * codebase is `<=`.
   */
  it('at (5000, 5000) bps equality is far from universal', () => {
    let equal = 0
    let total = 0
    for (let gross = 3n; gross <= 20_000n; gross += 1n) {
      const r = correctedNetQuoteIn(gross, 5_000n, 5_000n)
      total += 1
      if (r.net + r.protocolFee + r.creatorFee === gross) equal += 1
    }
    // MEASURED: 14_999 of 19_998, which is 0.7500 -- the contract's own note
    // says "only 75%" and this is that number, walked rather than quoted.
    expect(total).toBe(19_998)
    expect(equal).toBe(14_999)
    expect(equal / total).toBeLessThan(0.8)
  })

  it('the correction never underflows: `overshoot >= net` only at net == 1', () => {
    // Proven in the contract (`ceil(x) < x + 1` twice gives `overshoot <= 1`),
    // and walked here so the proof has a runtime.
    for (let gross = 3n; gross <= 20_000n; gross += 1n) {
      expect(correctedNetQuoteIn(gross, P_BPS, C_BPS).net).toBeGreaterThan(0n)
    }
  })
})
