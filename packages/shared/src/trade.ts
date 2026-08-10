import {
  correctedNetQuoteIn,
  type CurveProfile,
  feeOn,
  priceWeiPerToken,
  progressPpm,
  quoteBuyCost,
  quoteBuyTokensOut,
  quoteSellProceeds,
} from './curve'

/**
 * THE PLANNER FOR ALL THREE ENTRYPOINTS.
 *
 * A plan is the WHOLE transaction: the calldata arguments, the `msg.value`, and
 * the breakdown shown on screen -- and the breakdown is DERIVED FROM THE SAME
 * NUMBERS that go into the calldata, never computed a second time. Two
 * computations of "the fee" is exactly how a screen and a signature come to
 * disagree.
 *
 * THE THREE ENTRYPOINTS ARE THREE ENTRYPOINTS. Nothing proved about one is
 * proved about the others: they take different arguments, they protect
 * different quantities (`minTokensOut` versus `maxQuoteIn` versus
 * `minQuoteOut`), and only one of them clamps. `test/trade.test.ts` is written
 * per entrypoint for that reason.
 */

/**
 * The 18-decimal native USDC view -- what `msg.value` is denominated in.
 *
 * A BRAND, AND ITS LIMIT IS KNOWN: `bigint & {...}` is still BigIntLike, so
 * `WeiUsdc + TokAmount` COMPILES (measured, and recorded in
 * `test/two-views-typegate.test.ts`). What the brand does buy is that ASSIGNING
 * one where the other is expected is a compile error, which is the mistake that
 * actually happens -- both are 1e18-scaled, so a swapped argument is otherwise
 * invisible at every layer including the chain.
 */
export type WeiUsdc = bigint & { readonly __view: 'nativeUsdcWei' }

/** The launch token's base-unit view (`_tok`), also 1e18-scaled. */
export type TokAmount = bigint & { readonly __view: 'launchTokenBase' }

export const asWei = (v: bigint): WeiUsdc => v as WeiUsdc
export const asTok = (v: bigint): TokAmount => v as TokAmount

export const TRADE_ACTIONS = ['buyExactQuoteIn', 'buyExactTokensOut', 'sellExactTokensIn'] as const

export type TradeAction = (typeof TRADE_ACTIONS)[number]

export type { CurveProfile }

/**
 * The curve's live state, exactly as the four getters report it.
 *
 * `creator` is an address string; `0x0000...0000` means there is no creator and
 * the creator fee is ZERO. That branch is not cosmetic -- see `creatorBpsFor`.
 */
export type CurveState = {
  virtualTokenReserves: bigint
  virtualQuoteReserves: bigint
  realTokenReserves: TokAmount
  realQuoteReserves: WeiUsdc
  complete: boolean
  creator: string
}

export type FeeBps = {
  /** `BondingCurve.PROTOCOL_FEE_BPS`. 95 on this deployment. */
  readonly protocolFeeBps: bigint
  /** `BondingCurve.CREATOR_FEE_BPS`. 30 on this deployment. */
  readonly creatorFeeBps: bigint
}

export type TradePlan = {
  action: TradeAction
  /** These go into the calldata VERBATIM; the on-screen breakdown derives from them. */
  args: readonly [bigint] | readonly [bigint, bigint]
  /** `msg.value`. Zero on a sell. */
  value: WeiUsdc
  /** The curve amount, fees EXCLUDED. */
  curveAmount: WeiUsdc
  protocolFee: WeiUsdc
  /** Zero when `creator` is the zero address, and it does NOT fold into the protocol share. */
  creatorFee: WeiUsdc
  tokens: TokAmount
  /** Which side of the fee boundary the guard sits on. This decides the label. */
  boundKind: 'maxSpendIncludingFees' | 'minReceiveAfterFees'
  /** Only `buyExactQuoteIn` can ever set this. */
  clamped: boolean
  /** `value - (curveAmount + fees)`. One wei on a normal buy, large on a clamp. */
  refund: WeiUsdc
  priceAfterWeiPerToken: bigint
  progressPpmAfter: number
  /** True when this trade takes `realTokenReserves` to zero. */
  completesCurve: boolean
}

/**
 * A refusal the PLANNER predicts, named with the CONTRACT'S OWN error name.
 *
 * These are not `CurveMath` errors -- they are `BondingCurve`'s entrypoint
 * guards, and the planner exists precisely to reach them before the user pays
 * gas to find out. Sharing the name means the form and the revert decoder say
 * the same word for the same refusal.
 *
 * THE ZERO-INPUT NAMES ARE PER ENTRYPOINT, and that is the whole reason Faz 1c
 * split the curve's single `ZeroAmount()` into three. Delegating the zero check
 * to `CurveMath` instead would make the planner say `ZeroAmount` while the
 * chain says `ZeroTokensOut` -- the form and the revert decoder would print two
 * different words for one refusal, and `FAILURE_TABLE` would carry three cells
 * the planner could never produce. Reconciled by guarding here, in the
 * contract's own order: bound -> complete -> zero -> reserve.
 */
export type TradePlanErrorName =
  | 'CurveComplete'
  | 'ZeroQuoteIn'
  | 'ZeroTokensOut'
  | 'ZeroTokensIn'
  | 'NotEnoughTokensToBuy'
  | 'ProceedsTooSmall'
  /** Invariant check on `net + fees <= gross`. Proven unreachable; kept because a proof is not a runtime. */
  | 'BudgetOverrun'

export class TradePlanError extends Error {
  readonly errorName: TradePlanErrorName
  constructor(errorName: TradePlanErrorName) {
    super(errorName)
    this.name = 'TradePlanError'
    this.errorName = errorName
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * ZERO CREATOR MEANS ZERO CREATOR BPS, on every entrypoint.
 *
 * Faz 1c measured this on the contract: the `buyExactQuoteIn` x `creator == 0`
 * cell had NEVER been walked, and dropping the ternary broke that entrypoint
 * forever -- `correctedNetQuoteIn` returns a non-zero creator share, `_settleBuy`
 * tries `deposit{value: creatorFee}(address(0))`, and `FeeEscrow` answers
 * `ZeroRecipient()`. In the port the same omission SHIFTS the whole return of
 * `correctedNetQuoteIn` and makes every quote wrong, not just the fee line.
 */
function creatorBpsFor(state: CurveState, fees: FeeBps): bigint {
  return state.creator.toLowerCase() === ZERO_ADDRESS ? 0n : fees.creatorFeeBps
}

function creatorFeeFor(state: CurveState, fees: FeeBps, amount: bigint): bigint {
  const bps = creatorBpsFor(state, fees)
  return bps === 0n ? 0n : feeOn(amount, bps)
}

/** `floor(x * (10_000 - slipBps) / 10_000)`. A FLOOR on a minimum: never asks for more than quoted. */
function slipDown(value: bigint, slipBps: number): bigint {
  assertSlip(slipBps)
  return (value * (10_000n - BigInt(slipBps))) / 10_000n
}

/** `ceil(x * (10_000 + slipBps) / 10_000)`. A CEIL on a maximum: never caps below the quote. */
function slipUp(value: bigint, slipBps: number): bigint {
  assertSlip(slipBps)
  const scaled = value * (10_000n + BigInt(slipBps))
  return (scaled + 9_999n) / 10_000n
}

function assertSlip(slipBps: number): void {
  if (!Number.isInteger(slipBps) || slipBps < 0 || slipBps > 10_000) {
    throw new RangeError(`slipBps must be an integer in [0, 10000], got ${slipBps}`)
  }
}

function assertTradable(state: CurveState): void {
  if (state.complete) throw new TradePlanError('CurveComplete')
}

/** The state after a BUY, and the two display figures derived from it. */
function afterBuy(
  state: CurveState,
  profile: CurveProfile,
  curveIn: bigint,
  tokensOut: bigint,
): { priceAfterWeiPerToken: bigint; progressPpmAfter: number; completesCurve: boolean } {
  const vQ = state.virtualQuoteReserves + curveIn
  const vT = state.virtualTokenReserves - tokensOut
  const rT = state.realTokenReserves - tokensOut
  return {
    priceAfterWeiPerToken: priceWeiPerToken(vQ, vT),
    progressPpmAfter: progressPpm(rT, profile.saleSupply),
    completesCurve: rT === 0n,
  }
}

/** The state after a SELL. A sell can never complete a curve. */
function afterSell(
  state: CurveState,
  profile: CurveProfile,
  proceeds: bigint,
  tokensIn: bigint,
): { priceAfterWeiPerToken: bigint; progressPpmAfter: number; completesCurve: boolean } {
  const vQ = state.virtualQuoteReserves - proceeds
  const vT = state.virtualTokenReserves + tokensIn
  const rT = state.realTokenReserves + tokensIn
  return {
    priceAfterWeiPerToken: priceWeiPerToken(vQ, vT),
    progressPpmAfter: progressPpm(rT, profile.saleSupply),
    completesCurve: false,
  }
}

/**
 * "Spend X USDC" -- THE DEFAULT, and the reason is one sentence: it is the only
 * entrypoint that CANNOT fail at the top of the curve because of a stale quote.
 * A budget larger than the remaining reserve is CLAMPED, not reverted, and the
 * remainder is refunded.
 *
 * `value` is the gross budget. The guard is `minTokensOut`, floored by the
 * slippage tolerance.
 */
export function planBuyExactQuoteIn(
  state: CurveState,
  profile: CurveProfile,
  fees: FeeBps,
  grossValue: bigint,
  slipBps: number,
): TradePlan {
  assertTradable(state)
  assertSlip(slipBps)
  // The contract's order: bound -> complete -> `msg.value == 0`.
  if (grossValue === 0n) throw new TradePlanError('ZeroQuoteIn')

  const creatorBps = creatorBpsFor(state, fees)
  const corrected = correctedNetQuoteIn(grossValue, fees.protocolFeeBps, creatorBps)

  let curveAmount = corrected.net
  let protocolFee = corrected.protocolFee
  let creatorFee = corrected.creatorFee
  let tokens = quoteBuyTokensOut(
    curveAmount,
    state.virtualQuoteReserves,
    state.virtualTokenReserves,
  )
  let clamped = false

  if (tokens > state.realTokenReserves) {
    // THE CLAMP. The whole remaining reserve is sold and the trade lands
    // exactly where `buyExactTokensOut(realTokenReserves)` would -- reserves to
    // zero, no dust. The principal changed, so the fee is taken on the NEW
    // principal. That is NOT recomputing the fee on a returned net (which is
    // forbidden); it is the fee of a DIFFERENT principal under the exclusive
    // contract.
    clamped = true
    tokens = state.realTokenReserves
    curveAmount = quoteBuyCost(tokens, state.virtualQuoteReserves, state.virtualTokenReserves)
    protocolFee = feeOn(curveAmount, fees.protocolFeeBps)
    creatorFee = creatorBps === 0n ? 0n : feeOn(curveAmount, creatorBps)
  }

  const spent = curveAmount + protocolFee + creatorFee
  // `<=`, NEVER `==`. Equality holds 99.95% of the time at (95, 30) bps and
  // only 75% at (5000, 5000): when the correction does not fire the total can
  // fall one unit short of the budget, and that unit is refunded.
  if (spent > grossValue) throw new TradePlanError('BudgetOverrun')

  return {
    action: 'buyExactQuoteIn',
    args: [slipDown(tokens, slipBps)],
    value: asWei(grossValue),
    curveAmount: asWei(curveAmount),
    protocolFee: asWei(protocolFee),
    creatorFee: asWei(creatorFee),
    tokens: asTok(tokens),
    boundKind: 'maxSpendIncludingFees',
    clamped,
    refund: asWei(grossValue - spent),
    ...afterBuy(state, profile, curveAmount, tokens),
  }
}

/**
 * "Buy exactly Y tokens." REVERTS at the boundary rather than partially
 * filling: `tokensOut > realTokenReserves` is `NotEnoughTokensToBuy()`.
 *
 * `value == maxQuoteIn` DELIBERATELY. The contract refuses on `total >
 * maxQuoteIn` OR `total > msg.value`, so sending less than the cap makes the cap
 * meaningless -- there would be two guards and the tighter one would be the
 * invisible one. Equalising them leaves exactly one, and the change is refunded
 * anyway.
 */
export function planBuyExactTokensOut(
  state: CurveState,
  profile: CurveProfile,
  fees: FeeBps,
  tokensOut: bigint,
  slipBps: number,
): TradePlan {
  assertTradable(state)
  assertSlip(slipBps)
  // Zero is checked BEFORE the reserve, exactly as the contract orders it.
  if (tokensOut === 0n) throw new TradePlanError('ZeroTokensOut')
  if (tokensOut > state.realTokenReserves) throw new TradePlanError('NotEnoughTokensToBuy')

  const curveAmount = quoteBuyCost(
    tokensOut,
    state.virtualQuoteReserves,
    state.virtualTokenReserves,
  )
  const protocolFee = feeOn(curveAmount, fees.protocolFeeBps)
  const creatorFee = creatorFeeFor(state, fees, curveAmount)
  const total = curveAmount + protocolFee + creatorFee
  // The cap is FEE-INCLUSIVE, because the contract compares the fee-inclusive
  // total against it. A cap computed on the curve amount alone would be ~1.25%
  // too tight and would revert every trade at zero slippage.
  const maxQuoteIn = slipUp(total, slipBps)

  return {
    action: 'buyExactTokensOut',
    args: [tokensOut, maxQuoteIn],
    value: asWei(maxQuoteIn),
    curveAmount: asWei(curveAmount),
    protocolFee: asWei(protocolFee),
    creatorFee: asWei(creatorFee),
    tokens: asTok(tokensOut),
    boundKind: 'maxSpendIncludingFees',
    clamped: false,
    refund: asWei(maxQuoteIn - total),
    ...afterBuy(state, profile, curveAmount, tokensOut),
  }
}

/**
 * "Sell exactly Y tokens." `value` is zero; the tokens move by `transferFrom`,
 * so an allowance is required first.
 *
 * `minQuoteOut` guards the NET the seller actually receives, fees ALREADY
 * DEDUCTED -- the contract compares it against `netOut`, not against the
 * pre-fee proceeds. Guarding the proceeds instead would set the floor ~1.25%
 * above what can ever arrive.
 */
export function planSellExactTokensIn(
  state: CurveState,
  profile: CurveProfile,
  fees: FeeBps,
  tokensIn: bigint,
  slipBps: number,
): TradePlan {
  assertTradable(state)
  assertSlip(slipBps)
  if (tokensIn === 0n) throw new TradePlanError('ZeroTokensIn')

  const proceeds = quoteSellProceeds(
    tokensIn,
    state.virtualQuoteReserves,
    state.virtualTokenReserves,
  )
  const protocolFee = feeOn(proceeds, fees.protocolFeeBps)
  const creatorFee = creatorFeeFor(state, fees, proceeds)
  // `ProceedsTooSmall`: both fee parts round UP, so for proceeds of 1 or 2 they
  // swallow the whole amount. Rejected before anything else, exactly as the
  // contract does.
  if (proceeds <= protocolFee + creatorFee) throw new TradePlanError('ProceedsTooSmall')
  const netOut = proceeds - protocolFee - creatorFee

  return {
    action: 'sellExactTokensIn',
    args: [tokensIn, slipDown(netOut, slipBps)],
    value: asWei(0n),
    curveAmount: asWei(proceeds),
    protocolFee: asWei(protocolFee),
    creatorFee: asWei(creatorFee),
    tokens: asTok(tokensIn),
    boundKind: 'minReceiveAfterFees',
    clamped: false,
    refund: asWei(0n),
    ...afterSell(state, profile, proceeds, tokensIn),
  }
}

/**
 * ==========================================================================
 *  "SELL $50 WORTH" -- RESOLVED IN THE SELL DIRECTION, BY THE SELL PLANNER
 * ==========================================================================
 *
 * A money-denominated shortcut on the SELL side names a figure the user wants
 * to RECEIVE; the field underneath it takes TOKENS. Something has to invert
 * the curve, and the direction matters more than it looks:
 * `quoteBuyCost`/`quoteBuyTokensOut` and `quoteSellProceeds` are DIFFERENT
 * functions of the same reserves -- the buy path divides by `vT - tokens` and
 * the sell path by `vT + tokens`. Resolving a sell with buy-side arithmetic
 * produces a number of exactly the right magnitude and the wrong value, which
 * is the failure mode that survives a screenshot review.
 *
 * SO NOTHING HERE COMPUTES THE CURVE. It calls `planSellExactTokensIn` --
 * literally the function that will quote the trade -- and searches its OUTPUT.
 * A second closed-form inverse would be a second implementation of the fee
 * rounding, and the two would drift.
 *
 * THE TARGET IS THE **NET**, fees already deducted. That is what "I want fifty
 * dollars" means, and it is the same quantity `minQuoteOut` guards
 * (`boundKind: 'minReceiveAfterFees'`). Targeting the pre-fee proceeds would
 * hand the user ~1.25% less than the chip promised, every time.
 *
 * MINIMALITY IS APPROXIMATE BY ONE UNIT, AND THAT IS NOT A BUG TO FIX.
 * `netOut(p) = p - ceil(p*pBps/1e4) - ceil(p*cBps/1e4)`, so as proceeds rise by
 * one unit both ceilings can tick together and the net can fall by one:
 * `netOut` is non-decreasing IN THE LARGE but dips by 1 at isolated points. A
 * bisection over a predicate that is not a true up-set can therefore land one
 * unit above the true minimum. The GUARANTEE is restored by verifying the
 * winner forward before returning it, which is what `confirm` below does --
 * the returned `tokensIn` always satisfies `netOut >= target`. One unit here is
 * 1e-18 USDC, six orders of magnitude below the input field's own quantum.
 */

export type SellForNetResult =
  /** `tokensIn` reaches `target`, verified against the sell planner. */
  | { readonly ok: true; readonly tokensIn: TokAmount; readonly netOut: WeiUsdc }
  /**
   * Unreachable, and the two reasons are NOT the same sentence to a user:
   * `holding` -> sell everything you have and it still falls short.
   * `curve`   -> the curve itself cannot pay that much to ANYONE. Sell proceeds
   *              are `x*vQ/(vT+x)`, which approaches `virtualQuoteReserves` and
   *              never reaches it, so every arcpad curve has a hard ceiling on
   *              what any sell can ever return.
   */
  | {
      readonly ok: false
      readonly reason: 'holding' | 'curve'
      /** The best net the holding can actually realise. */
      readonly bestNetOut: WeiUsdc
    }

/** The net a given `tokensIn` realises, straight off the sell plan. `null` -> the planner refuses it. */
function netOutFor(
  state: CurveState,
  profile: CurveProfile,
  fees: FeeBps,
  tokensIn: bigint,
): bigint | null {
  if (tokensIn <= 0n) return null
  try {
    return netProceedsOf(planSellExactTokensIn(state, profile, fees, tokensIn, 0))
  } catch {
    // `ProceedsTooSmall` at the bottom, `CurveComplete` everywhere. Both mean
    // "this quantity realises nothing you can have", which is a zero for the
    // search, not an exception for the caller.
    return null
  }
}

/**
 * The smallest `tokensIn <= maxTokensIn` whose sell realises at least
 * `targetNet`.
 *
 * `maxTokensIn` is the USER'S BALANCE. Searching past it would return a
 * quantity the wallet cannot deliver, and `sellExactTokensIn` would revert in
 * `transferFrom` after the user had already signed.
 *
 * ------------------------------------------------------------------------
 *  `step` -- AND IT IS LOAD-BEARING, NOT A CONVENIENCE
 * ------------------------------------------------------------------------
 *
 * MEASURED, at the composed panel level, on the first run of
 * `web/test/trade/panel.test.tsx`: a `$25` sell chip resolved EXACTLY, was
 * written into the amount field, and came back out worth
 * `24_999_999_999_996_747_628` -- 3.25e-6 USDC SHORT of what the chip had
 * promised. Nothing in the resolver was wrong. The amount field carries SIX
 * DECIMALS and `formatTokenAmount` quantises DOWN, so a quantity resolved at
 * full precision loses its guarantee on the way through the text box.
 *
 * A caller that will round the answer must therefore not be handed an answer
 * that only works unrounded. `step` makes the SEARCH walk the caller's own
 * quantum -- the returned quantity is already a multiple of it, so the text the
 * user sees, the number that is parsed back, and the number that was verified
 * against `targetNet` are all the same number. Correcting after the fact would
 * have been a second rounding rule in a second place, which is how the screen
 * and the signature come to disagree.
 *
 * This is an instance of the class it was written to close, found inside the
 * fix for that class. That keeps happening here; it is why the assertion runs
 * on the assembled panel and not only on this function.
 */
export function resolveSellForNet(
  state: CurveState,
  profile: CurveProfile,
  fees: FeeBps,
  targetNet: bigint,
  maxTokensIn: bigint,
  step = 1n,
): SellForNetResult {
  if (targetNet <= 0n)
    throw new RangeError(`resolveSellForNet: target must be positive (${targetNet})`)
  if (step <= 0n) throw new RangeError(`resolveSellForNet: step must be positive (${step})`)

  // THE CURVE'S OWN CEILING FIRST, and it is checked against the WHOLE sale
  // supply rather than the holding: it answers a different question ("could
  // anyone ever get this much out of this curve?") and it is the honest reason
  // to show when the answer is no.
  const ceilingProbe = netOutFor(state, profile, fees, profile.saleSupply)
  if (ceilingProbe !== null && ceilingProbe < targetNet) {
    const best = maxTokensIn <= 0n ? 0n : (netOutFor(state, profile, fees, maxTokensIn) ?? 0n)
    return { ok: false, reason: 'curve', bestNetOut: asWei(best) }
  }

  // THE CEILING OF THE SEARCH IS ON THE STEP, not the raw balance: a quantity
  // the field cannot express is a quantity the user cannot send.
  const steps = maxTokensIn / step
  const reachable = steps * step
  const best = reachable <= 0n ? null : netOutFor(state, profile, fees, reachable)
  if (best === null || best < targetNet) {
    return { ok: false, reason: 'holding', bestNetOut: asWei(best ?? 0n) }
  }

  let lo = 1n
  let hi = steps
  let winner = steps
  while (lo <= hi) {
    const mid = (lo + hi) / 2n
    const net = netOutFor(state, profile, fees, mid * step)
    if (net !== null && net >= targetNet) {
      winner = mid
      hi = mid - 1n
    } else {
      lo = mid + 1n
    }
  }

  // THE VERIFY-FORWARD STEP. See the header: the predicate dips by one unit at
  // isolated points, so the bisection's winner is confirmed -- and nudged up if
  // it landed in a dip -- against the planner that will quote the trade.
  let confirm = netOutFor(state, profile, fees, winner * step)
  while ((confirm === null || confirm < targetNet) && winner < steps) {
    winner += 1n
    confirm = netOutFor(state, profile, fees, winner * step)
  }
  if (confirm === null || confirm < targetNet) {
    return { ok: false, reason: 'holding', bestNetOut: asWei(best) }
  }

  return { ok: true, tokensIn: asTok(winner * step), netOut: asWei(confirm) }
}

/** What the seller actually receives: the curve amount minus both fee parts. */
export function netProceedsOf(plan: TradePlan): WeiUsdc {
  if (plan.action !== 'sellExactTokensIn') {
    throw new RangeError('netProceedsOf is only meaningful for a sell')
  }
  return asWei(plan.curveAmount - plan.protocolFee - plan.creatorFee)
}

/** What a buyer actually parts with: the curve amount plus both fee parts. */
export function totalSpentOf(plan: TradePlan): WeiUsdc {
  if (plan.action === 'sellExactTokensIn') {
    throw new RangeError('totalSpentOf is only meaningful for a buy')
  }
  return asWei(plan.curveAmount + plan.protocolFee + plan.creatorFee)
}
