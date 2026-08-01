/**
 * `CurveMath.sol`, PORTED -- SAME ROUNDING, SAME REVERTS.
 *
 * `BondingCurve` has NO view quote function (S1), so the frontend has to do
 * this arithmetic itself. A wrong rounding direction here does not show a
 * slightly wrong number: it makes the user SIGN something different from what
 * they were shown -- overpaying, or signing a transaction that cannot succeed.
 *
 * TWO SOURCES, AND THEY DISAGREE. The exact-tokens-out path (`quoteBuyCost`,
 * `quoteSellProceeds`, `feeOn`) comes from pump-sdk 1.36.0. The exact-quote-in
 * path (`netQuoteInBeforeCorrection` -> `correctedNetQuoteIn` ->
 * `quoteBuyTokensOut`) comes from the CHAIN ALGORITHM in the IDL doc-comment on
 * `buy_exact_sol_in`, NOT from the SDK: the SDK's
 * `getBuyTokenAmountFromSolAmount` helper is an off-chain ESTIMATOR that
 * diverges on 51.16% of 200,000 measured samples and promises MORE tokens than
 * the chain delivers every single time it diverges.
 *
 * The four rules, all of them from the contract:
 *   1. `quoteBuyCost` is `floor(...) + 1`, NOT `mulDivRoundingUp`. On an exact
 *      division it takes one unit more, and that carries the direction of the
 *      graduation price (spec 10, invariant 6).
 *   2. `quoteBuyTokensOut`'s `-1` lives INSIDE the curve term -- `net - 1` in
 *      BOTH numerator and denominator. The SDK applies it to the input before
 *      dividing; those are not the same number and the difference always
 *      favours the user.
 *   3. `correctedNetQuoteIn` charges the fees on the PRE-CORRECTION net and
 *      does NOT recompute them afterwards. Recomputing undercharges by one unit
 *      on 1.23% of inputs at (95, 30) bps, and the party short-changed is the
 *      creator.
 *   4. Fees are SUMMED FROM PARTS and never divided from a combined rate.
 *      Measured on the live smoke, trade 1 of 4: summed `...635` versus
 *      divided-from-125 `...634`, and the escrow on chain holds the summed
 *      figure.
 *
 * Every rounding direction is toward the protocol. One rounding in the buyer's
 * favour lets an attacker drain the curve a wei at a time.
 */

const BPS = 10_000n
const UINT256_MAX = 2n ** 256n - 1n

export type CurveErrorName =
  | 'ZeroAmount'
  | 'ZeroReserve'
  | 'InsufficientTokenReserve'
  | 'InvalidBps'
  | 'NetTooSmall'
  /**
   * NOT a contract error. `FullMath.mulDiv` reverts with a panic when the
   * RESULT does not fit in uint256; bigint has no such ceiling, so the port
   * would happily return a number the chain cannot produce. Given its own name
   * rather than being folded into `InvalidBps` (which the brief suggested),
   * because a user shown "a fee rate is out of range" for an overflow has been
   * told something false.
   */
  | 'MulDivOverflow'

export class CurveMathError extends Error {
  readonly errorName: CurveErrorName
  constructor(errorName: CurveErrorName) {
    super(errorName)
    this.name = 'CurveMathError'
    this.errorName = errorName
  }
}

/**
 * `FullMath.mulDiv`'s counterpart. bigint is arbitrary precision so the
 * INTERMEDIATE product cannot overflow here -- but IT DOES ON CHAIN, where
 * `FullMath.mulDiv` reverts if the result exceeds uint256. The bound is checked
 * explicitly; otherwise TypeScript says "fine" while the chain reverts, which
 * is the quietest way for what the user signed and what happens to diverge.
 */
function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new CurveMathError('ZeroReserve')
  const q = (a * b) / d
  if (q > UINT256_MAX) throw new CurveMathError('MulDivOverflow')
  return q
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/**
 * The quote amount owed to the curve for exactly `tokensOut` tokens, EXCLUDING
 * fees.
 *
 * `floor(...) + 1`. This is NOT `mulDivRoundingUp`: on an exact division it
 * takes one unit more. That `+1` is load-bearing for the direction of the
 * graduation price and must not be "simplified".
 */
export function quoteBuyCost(
  tokensOut: bigint,
  quoteReserve: bigint,
  tokenReserve: bigint,
): bigint {
  if (tokensOut === 0n) throw new CurveMathError('ZeroAmount')
  if (quoteReserve === 0n) throw new CurveMathError('ZeroReserve')
  if (tokensOut >= tokenReserve) throw new CurveMathError('InsufficientTokenReserve')
  return mulDiv(tokensOut, quoteReserve, tokenReserve - tokensOut) + 1n
}

/**
 * Step 4 of the chain's exact-quote-in algorithm.
 *
 * Floors. The `-1` is INSIDE the curve term: `net - 1` appears in both the
 * numerator and the denominator.
 */
export function quoteBuyTokensOut(
  netQuoteIn: bigint,
  quoteReserve: bigint,
  tokenReserve: bigint,
): bigint {
  if (netQuoteIn <= 1n) throw new CurveMathError('NetTooSmall')
  if (quoteReserve === 0n || tokenReserve === 0n) throw new CurveMathError('ZeroReserve')
  const net = netQuoteIn - 1n
  return mulDiv(net, tokenReserve, quoteReserve + net)
}

/** What the curve pays for exactly `tokensIn` tokens, EXCLUDING fees. Floors. */
export function quoteSellProceeds(
  tokensIn: bigint,
  quoteReserve: bigint,
  tokenReserve: bigint,
): bigint {
  if (tokensIn === 0n) throw new CurveMathError('ZeroAmount')
  if (quoteReserve === 0n || tokenReserve === 0n) throw new CurveMathError('ZeroReserve')
  return mulDiv(tokensIn, quoteReserve, tokenReserve + tokensIn)
}

/**
 * A fee ON TOP of `amount` (the EXCLUSIVE contract -- `amount` is a net
 * principal). Rounds UP.
 *
 * This is NOT the inverse of the INCLUSIVE contract `netQuoteInBeforeCorrection`
 * uses, and `feeOn(n, p) + feeOn(n, c) != feeOn(n, p + c)` in general. That gap
 * is exactly the overshoot `correctedNetQuoteIn` trims.
 */
export function feeOn(amount: bigint, feeBps: bigint): bigint {
  if (feeBps > BPS) throw new CurveMathError('InvalidBps')
  if (feeBps === 0n) return 0n
  return ceilDiv(amount * feeBps, BPS)
}

/**
 * Step 1. NO `-1` IS SUBTRACTED FROM THE INPUT. The SDK's estimator subtracts
 * one here; it is an off-chain approximation and it is wrong for this purpose.
 */
export function netQuoteInBeforeCorrection(grossQuoteIn: bigint, totalFeeBps: bigint): bigint {
  if (grossQuoteIn === 0n) throw new CurveMathError('ZeroAmount')
  if (totalFeeBps > BPS) throw new CurveMathError('InvalidBps')
  return mulDiv(grossQuoteIn, BPS, totalFeeBps + BPS)
}

export type CorrectedNet = {
  readonly net: bigint
  readonly protocolFee: bigint
  readonly creatorFee: bigint
}

/**
 * Steps 1 through 3: the net principal that fits the budget, and the TWO fee
 * parts charged alongside it.
 *
 * THE FEES ARE COMPUTED ON THE PRE-CORRECTION NET AND ARE NOT RECOMPUTED.
 * A caller that calls `feeOn` on the RETURNED net gets a different (smaller)
 * figure, and one unit of the user's payment accounts as neither principal nor
 * fee. Measured at (95, 30) bps: recomputation differs on 12,345 of the gross
 * values in [1, 1e6] -- 1.23% -- and the short-changed party is the creator.
 *
 * The two parts are returned SEPARATELY, not their sum: the escrow takes two
 * independent deposits, and this project's rule is that a fee is SUMMED FROM
 * PARTS, never DIVIDED from a combined rate.
 *
 * Guarantee: `net + protocolFee + creatorFee <= grossQuoteIn`, with a gap of at
 * most 1. EQUALITY IS NOT UNIVERSAL -- when the correction does not fire the
 * total can fall one unit short. Measured at (95, 30) bps: equal on 99.95% of
 * gross in [1, 1e6]; at (5000, 5000) bps only 75%. Nothing here or downstream
 * may be written as `== gross`.
 */
export function correctedNetQuoteIn(
  grossQuoteIn: bigint,
  protocolFeeBps: bigint,
  creatorFeeBps: bigint,
): CorrectedNet {
  let net = netQuoteInBeforeCorrection(grossQuoteIn, protocolFeeBps + creatorFeeBps)
  const protocolFee = feeOn(net, protocolFeeBps)
  const creatorFee = feeOn(net, creatorFeeBps)
  const total = net + protocolFee + creatorFee
  if (total > grossQuoteIn) {
    const overshoot = total - grossQuoteIn
    if (overshoot >= net) throw new CurveMathError('NetTooSmall')
    net -= overshoot
  }
  return { net, protocolFee, creatorFee }
}

/**
 * Market cap. `supplyConstant` is the FIXED supply constant, not the mint's
 * live supply -- every launch has the same supply, which reduces market cap to
 * a pure function of price.
 */
export function marketCap(
  quoteReserve: bigint,
  tokenReserve: bigint,
  supplyConstant: bigint,
): bigint {
  if (tokenReserve === 0n) throw new CurveMathError('ZeroReserve')
  return mulDiv(quoteReserve, supplyConstant, tokenReserve)
}

/**
 * The quote that will have accumulated in the curve once the sale supply is
 * gone: `R = V*S/(T-S)`. INDEPENDENT of the fee rate, because fees are taken
 * outside the curve and never enter the reserves.
 */
export function graduationRaise(
  saleSupply: bigint,
  quoteReserve: bigint,
  tokenReserve: bigint,
): bigint {
  if (saleSupply >= tokenReserve) throw new CurveMathError('InsufficientTokenReserve')
  return mulDiv(quoteReserve, saleSupply, tokenReserve - saleSupply)
}

/** The seed supply that opens the pool at the curve's closing price: `D = S(T-S)/T`. */
export function poolSeedSupply(saleSupply: bigint, tokenReserve: bigint): bigint {
  if (saleSupply >= tokenReserve) throw new CurveMathError('InsufficientTokenReserve')
  return mulDiv(saleSupply, tokenReserve - saleSupply, tokenReserve)
}

/**
 * The spot price in native wei per WHOLE token.
 *
 * Per WHOLE token, not per base unit: a base unit costs about 4e-9 wei on a
 * fresh curve, which is zero in integer arithmetic. Multiplying by 1e18 first
 * keeps four significant digits at every point on the curve.
 */
export function priceWeiPerToken(quoteReserve: bigint, tokenReserve: bigint): bigint {
  if (tokenReserve === 0n) throw new CurveMathError('ZeroReserve')
  return mulDiv(quoteReserve, 10n ** 18n, tokenReserve)
}

/**
 * Sale progress in parts per million: `1_000_000 - ceil(rT * 1_000_000 / S)`.
 *
 * IDENTICAL TO PHASE 3'S DEFINITION, and it has to be: a token card and a token
 * page that disagree by one ppm are two different numbers on one screen. The
 * REMAINDER rounds UP, so one wei of token left reads `999_999` and never
 * `1_000_000` -- "sold out" is reserved for actually sold out.
 */
export function progressPpm(realTokenReserves: bigint, saleSupply: bigint): number {
  if (saleSupply === 0n) throw new CurveMathError('ZeroReserve')
  if (realTokenReserves < 0n) throw new CurveMathError('ZeroAmount')
  return Number(1_000_000n - ceilDiv(realTokenReserves * 1_000_000n, saleSupply))
}

/**
 * The economics-defining triple of a curve profile.
 *
 * Defined HERE rather than in `profiles.ts` so that browser code can name the
 * type without pulling in a module that reads the filesystem; `profiles.ts`
 * re-exports it, so every existing importer is unaffected. The field names
 * match `web/lib/profile.ts` exactly -- there is deliberately no translation
 * layer between the two sides.
 */
export type CurveProfile = {
  virtualTokenReserves: bigint
  virtualQuoteReserves: bigint
  saleSupply: bigint
}
