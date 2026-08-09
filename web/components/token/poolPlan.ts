import type { Address } from 'viem'
import { quoteUnitsFromWei, quoteWeiFromUnits } from '@/lib/quoteUnits'
import type { RouterQuoteFn, RouterSwapFn } from '@/lib/routerAbi'
import type {
  ApprovalState,
  ButtonIntent,
  ButtonPlan,
  ConnectionState,
  TradePhase,
} from './tradeModel'

/**
 * ==========================================================================
 *  EVERY POOL DECISION, AWAY FROM REACT -- the twin of `tradeModel.ts`.
 * ==========================================================================
 *
 * The curve panel's arithmetic lives in `@arcpad/shared/trade` because the
 * curve is a closed formula. **The pool's does not, and cannot**: a v4 price is
 * only knowable by running the swap. The pool fee is zero and `ArcpadHook`
 * takes its cut through `beforeSwap`/`afterSwap` return deltas, so an off-chain
 * re-derivation of the AMM curve would be systematically wrong by the fee and
 * the user would sign for a number they never get.
 *
 * So there is NO pool arithmetic in this repository. The quote comes from
 * `ArcpadRouter.quote*`, which runs the real swap through the real hook inside
 * `unlock` and reverts with the answer -- and `quote == realized` is asserted in
 * the contract's own suite for four shapes x two currency orderings. This file
 * does three things and nothing else: it says which entrypoint a tab reaches,
 * it applies the slippage tolerance, and it says how much the router may pull.
 */

// --------------------------------------------------------------------------
// Tabs -> entrypoints
// --------------------------------------------------------------------------

export type PoolTab = 'spend' | 'receive' | 'sell'

export const POOL_TABS: readonly PoolTab[] = ['spend', 'receive', 'sell']

/**
 * THE SAME THREE TABS AS THE CURVE, AND THAT IS THE PRODUCT DECISION.
 *
 * The router exposes FOUR shapes; `sellExactOut` ("receive exactly N USDC") has
 * no curve twin, so exposing it here would mean the panel a user meets after
 * graduation offers something the panel they learned did not. The capability is
 * not missing -- `test/pool/abi.test.ts` asserts the ABI carries all four -- it
 * is deliberately not surfaced, which is a reversible decision, unlike shipping
 * a fourth control nobody asked for.
 */
export const POOL_TAB_ACTION: Readonly<Record<PoolTab, RouterSwapFn>> = {
  spend: 'buyExactIn',
  receive: 'buyExactOut',
  sell: 'sellExactIn',
}

export const POOL_TAB_QUOTE: Readonly<Record<PoolTab, RouterQuoteFn>> = {
  spend: 'quoteBuyExactIn',
  receive: 'quoteBuyExactOut',
  sell: 'quoteSellExactIn',
}

export const POOL_TAB_LABEL: Readonly<Record<PoolTab, string>> = {
  spend: 'Buy · Spend USDC',
  receive: 'Buy · Receive tokens',
  sell: 'Sell',
}

export const POOL_DEFAULT_TAB: PoolTab = 'spend'

export const isPoolBuyTab = (tab: PoolTab): boolean => tab !== 'sell'

/**
 * WHICH LABEL THE BOUND CARRIES, PER TAB -- not per direction.
 *
 * `buyExactIn` guards `minTokensOut`; `buyExactOut` guards `maxQuoteIn`. Both
 * are buys and the two protect opposite things, so a label derived from
 * "is this a buy" would tell the user the wrong one.
 */
export const POOL_BOUND_LABEL: Readonly<Record<PoolTab, string>> = {
  spend: 'Minimum tokens you receive',
  receive: 'Maximum USDC you spend',
  sell: 'Minimum USDC you receive',
}

// --------------------------------------------------------------------------
// Slippage
// --------------------------------------------------------------------------

/**
 * `floor(x * (10_000 - slipBps) / 10_000)` and
 * `ceil(x * (10_000 + slipBps) / 10_000)`.
 *
 * A SECOND COPY OF `packages/shared/src/trade.ts`'S PRIVATE HELPERS, AND THE
 * DUPLICATION IS NAMED RATHER THAN HIDDEN: `slipDown`/`slipUp` are not
 * exported from that module and `packages/` belongs to another track. Two
 * implementations of one rule is how a repository grows a rounding difference
 * nobody can see, so `test/pool/plan.test.ts` closes it by DIFFERENTIAL
 * TESTING -- it runs the real curve planners and asserts the bound they emit
 * equals what these two functions produce, across a grid of amounts and
 * tolerances. If the shared copy ever changes, that test goes red here.
 */
export function slipDown(value: bigint, slipBps: number): bigint {
  assertSlip(slipBps)
  return (value * (10_000n - BigInt(slipBps))) / 10_000n
}

export function slipUp(value: bigint, slipBps: number): bigint {
  assertSlip(slipBps)
  const scaled = value * (10_000n + BigInt(slipBps))
  return scaled / 10_000n + (scaled % 10_000n === 0n ? 0n : 1n)
}

function assertSlip(slipBps: number): void {
  if (!Number.isInteger(slipBps) || slipBps < 0 || slipBps > 10_000) {
    throw new RangeError(`slipBps must be an integer in [0, 10000], got ${slipBps}`)
  }
}

// --------------------------------------------------------------------------
// The deadline
// --------------------------------------------------------------------------

/**
 * FIVE MINUTES, AND THE NUMBER IS AN ARC NUMBER.
 *
 * A deadline protects against a transaction that sits unmined and then executes
 * at a price the user never saw. On Arc inclusion is sub-second (~350 ms
 * blocks, `latest` == `finalized`), so the only real latency between the quote
 * and the mine is the HUMAN in the wallet dialog. Five minutes is generous for
 * a person and is still ~850 blocks -- Uniswap's 30-minute default is sized for
 * a chain where a transaction can genuinely sit in a mempool, which this is not.
 */
export const POOL_DEADLINE_TTL_SECONDS = 300n

/**
 * THE DEADLINE IS ANCHORED TO THE CHAIN'S CLOCK, NOT THE BROWSER'S.
 *
 * `_swap` compares against `block.timestamp`. A browser clock running ten
 * minutes FAST would produce a deadline that is already in the past by the
 * chain's reckoning, and then EVERY swap reverts `DeadlinePassed` instantly --
 * a total, silent, machine-specific failure that no local devchain can
 * reproduce, because there the two clocks are the same clock. That is precisely
 * failure mode 3: a test that passes because of a precondition nobody wrote
 * down.
 *
 * `chainNowSeconds` is `null` only when the head read has not landed; the
 * browser is then the fallback, because refusing to quote a deadline at all
 * would be a worse failure than a possibly-skewed one.
 */
export function poolDeadline(
  chainNowSeconds: bigint | null,
  browserNowMs: number,
  ttlSeconds: bigint = POOL_DEADLINE_TTL_SECONDS,
): bigint {
  const now = chainNowSeconds ?? BigInt(Math.floor(browserNowMs / 1000))
  return now + ttlSeconds
}

/** Positive when the browser is AHEAD of the chain. `null` when unknown. */
export function clockSkewSeconds(
  chainNowSeconds: bigint | null,
  browserNowMs: number,
): bigint | null {
  if (chainNowSeconds === null) return null
  return BigInt(Math.floor(browserNowMs / 1000)) - chainNowSeconds
}

/** Above this the panel says so: it is the one cause of a total, instant failure. */
export const CLOCK_SKEW_WARN_SECONDS = 60n

// --------------------------------------------------------------------------
// The quote request
// --------------------------------------------------------------------------

export type PoolQuoteRequest = {
  readonly fn: RouterQuoteFn
  /** `[token, amount]`. The amount's UNIT depends on the tab -- see below. */
  readonly args: readonly [Address, bigint]
}

/**
 * What to ask the router, given what the user typed.
 *
 * `amount` arrives in the field's own unit: NATIVE WEI on `spend` (the user
 * typed USDC and `parseUsdcAmount` returns the 18-decimal view), token wei on
 * the other two. The conversion to the router's 6-decimal quote units happens
 * HERE and only here on the way in, through `lib/quoteUnits.ts`.
 *
 * `null` when there is nothing to ask -- an empty field, or a budget so small
 * it quantises to zero units. The second case matters: `1e11` wei is a real
 * number the field will not produce (the parser quantises first) but an API
 * caller could, and `quoteBuyExactIn(token, 0)` reverts `AmountOutOfRange`
 * rather than answering.
 */
export function poolQuoteRequest(input: {
  readonly tab: PoolTab
  readonly token: Address
  /** `spend`: native wei. `receive`/`sell`: token wei. */
  readonly amount: bigint | null
}): PoolQuoteRequest | null {
  const { tab, token, amount } = input
  if (amount === null || amount <= 0n) return null
  if (tab === 'spend') {
    const units = quoteUnitsFromWei(amount)
    if (units === 0n) return null
    return { fn: POOL_TAB_QUOTE.spend, args: [token, units] }
  }
  return { fn: POOL_TAB_QUOTE[tab], args: [token, amount] }
}

// --------------------------------------------------------------------------
// The plan
// --------------------------------------------------------------------------

export type PoolApproval = {
  /** The ERC-20 the router will call `transferFrom` on. */
  readonly token: Address
  /**
   * THE MOST THE ROUTER MAY PULL FOR THIS PLAN -- the bound, not the quote.
   *
   * On `receive` the router pulls whatever the swap actually costs and only
   * then checks it against `maxQuoteIn`, so an allowance sized to the QUOTE
   * fails exactly when the price moved -- which is the case the slippage
   * tolerance exists to survive. Approving the bound is the only amount that
   * makes the two guards agree.
   */
  readonly amount: bigint
  /** `'USDC'` or the launch token's symbol. Drawn in the approve step. */
  readonly symbol: string
  /** 6 for USDC, 18 for the token. Decides which formatter draws the amount. */
  readonly decimals: 6 | 18
}

export type PoolPlan = {
  readonly tab: PoolTab
  readonly action: RouterSwapFn
  /** `[token, amount, bound, to, deadline]` -- the router's own parameter order. */
  readonly args: readonly [Address, bigint, bigint, Address, bigint]
  /** Quoted input. `spend`/`receive`: USDC units. `sell`: token wei. */
  readonly amountIn: bigint
  /** Quoted output. `spend`: token wei. `receive`/`sell`: USDC units. */
  readonly amountOut: bigint
  /** The slippage-adjusted guard that goes on chain. */
  readonly bound: bigint
  readonly boundKind: 'minOut' | 'maxIn'
  readonly approval: PoolApproval
  readonly deadline: bigint
}

export type BuildPoolPlanInput = {
  readonly tab: PoolTab
  readonly token: Address
  readonly tokenSymbol: string
  readonly quoteAsset: Address
  /** `spend`: native wei. `receive`/`sell`: token wei. */
  readonly amount: bigint
  /** Straight from `ArcpadRouter.quote*`. */
  readonly quoted: bigint
  readonly slipBps: number
  readonly recipient: Address
  readonly deadline: bigint
}

/**
 * THE THREE SHAPES, WRITTEN OUT. No shared "planner" table.
 *
 * A table would hide that the three tabs guard three different quantities and
 * approve three different amounts of two different assets, and this repository
 * has eleven measured instances of a property closed on one entrypoint reading
 * as closed on all of them. The `switch` makes each one its own line, and each
 * one has its own test.
 */
export function buildPoolPlan(input: BuildPoolPlanInput): PoolPlan {
  const { tab, token, tokenSymbol, quoteAsset, amount, quoted, slipBps, recipient, deadline } =
    input
  assertSlip(slipBps)

  switch (tab) {
    case 'spend': {
      // The user typed USDC. The router takes 6-decimal units; the quote came
      // back in token wei.
      const quoteIn = quoteUnitsFromWei(amount)
      const minTokensOut = slipDown(quoted, slipBps)
      return {
        tab,
        action: 'buyExactIn',
        args: [token, quoteIn, minTokensOut, recipient, deadline],
        amountIn: quoteIn,
        amountOut: quoted,
        bound: minTokensOut,
        boundKind: 'minOut',
        // EXACTLY the budget: `buyExactIn` spends all of it, never more.
        approval: { token: quoteAsset, amount: quoteIn, symbol: 'USDC', decimals: 6 },
        deadline,
      }
    }
    case 'receive': {
      // The user typed tokens. The quote came back in USDC units.
      const maxQuoteIn = slipUp(quoted, slipBps)
      return {
        tab,
        action: 'buyExactOut',
        args: [token, amount, maxQuoteIn, recipient, deadline],
        amountIn: quoted,
        amountOut: amount,
        bound: maxQuoteIn,
        boundKind: 'maxIn',
        // THE BOUND, NOT THE QUOTE. See `PoolApproval.amount`.
        approval: { token: quoteAsset, amount: maxQuoteIn, symbol: 'USDC', decimals: 6 },
        deadline,
      }
    }
    case 'sell': {
      const minQuoteOut = slipDown(quoted, slipBps)
      return {
        tab,
        action: 'sellExactIn',
        args: [token, amount, minQuoteOut, recipient, deadline],
        amountIn: amount,
        amountOut: quoted,
        bound: minQuoteOut,
        boundKind: 'minOut',
        // EXACTLY the tokens being sold: `sellExactIn` spends all of them.
        approval: { token, amount, symbol: tokenSymbol, decimals: 18 },
        deadline,
      }
    }
  }
}

/**
 * DOES THIS PLAN LEAVE THE ROUTER A STANDING ALLOWANCE?
 *
 * Only `receive` can: it approves `maxQuoteIn` and the swap spends `amountIn`,
 * so `maxQuoteIn - amountIn` stays approved afterwards. The other two approve
 * exactly what is spent and leave zero. The panel SAYS SO rather than leaving
 * the user to discover it, because "approve exactly what you spend" is the
 * promise the curve panel already made and this is the one shape where it
 * cannot be kept.
 */
export function residualAllowance(plan: PoolPlan): bigint {
  return plan.boundKind === 'maxIn' ? plan.bound - plan.amountIn : 0n
}

// --------------------------------------------------------------------------
// The button ladder
// --------------------------------------------------------------------------

export type PoolButtonInput = {
  readonly connection: ConnectionState
  readonly chainName: string
  readonly symbol: string
  readonly tab: PoolTab
  /** Parsed input in the field's own unit. `null` -> empty or unreadable. */
  readonly amount: bigint | null
  /** `null` while the quote is in flight or unavailable. */
  readonly plan: PoolPlan | null
  /** Buy tabs: spendable native wei. Sell: token balance. `null` -> unknown. */
  readonly available: bigint | null
  readonly approval: ApprovalState
  readonly phase: TradePhase
  /** The pool could not be quoted. Nothing may be signed. */
  readonly quoteFailure: { readonly title: string; readonly code: string } | null
  /** No `arcpadRouter` in this build's env: there is no entrypoint at all. */
  readonly routerMissing: boolean
}

const BUSY_LABEL: Partial<Record<TradePhase, string>> = {
  simulating: 'Checking…',
  awaitingSignature: 'Confirm in your wallet',
  pending: 'Submitting…',
}

/**
 * THE SAME LADDER AS `buttonFor`, IN THE SAME ORDER, PLUS ONE RUNG AT THE TOP.
 *
 * The order is binding because two conditions are often true at once and the
 * one that is written decides the user's next step. The new rung is
 * `routerMissing`: without a router there is no entrypoint to a v4 pool at all,
 * so it outranks even "connect wallet" -- connecting would not help.
 * `test/pool/plan.test.ts` asserts the two ladders share their rung ORDER,
 * because a user must not learn one sequence on the curve and another here.
 */
export function poolButtonFor(input: PoolButtonInput): ButtonPlan {
  const { connection, chainName, symbol, tab, amount, plan, available, approval } = input

  if (input.routerMissing) {
    return { intent: 'blocked', label: 'Trading unavailable', disabled: true }
  }
  if (connection === 'disconnected') {
    return { intent: 'connect', label: 'Connect wallet', disabled: false }
  }
  if (connection === 'wrongNetwork') {
    return { intent: 'switch', label: `Switch to ${chainName}`, disabled: false }
  }

  const busy = BUSY_LABEL[input.phase]
  if (busy !== undefined) return { intent: 'busy', label: busy, disabled: true }

  if (amount === null || amount === 0n) {
    return { intent: 'empty', label: 'Enter an amount', disabled: true }
  }

  if (input.quoteFailure !== null) {
    return { intent: 'planError', label: input.quoteFailure.title, disabled: true }
  }

  if (plan === null) {
    return { intent: 'busy', label: 'Fetching a quote…', disabled: true }
  }

  // WHAT LEAVES THE WALLET, NOT WHAT WAS TYPED. On `receive` the user typed
  // tokens and the wallet pays `maxQuoteIn`; comparing the typed number against
  // a USDC balance would compare two different units.
  const needed = isPoolBuyTab(tab) ? spendWei(plan) : plan.amountIn
  if (needed !== null && available !== null && needed > available) {
    return {
      intent: 'insufficient',
      label: isPoolBuyTab(tab) ? 'Insufficient USDC' : `Insufficient ${symbol}`,
      disabled: true,
    }
  }

  if (approval === 'required') {
    return { intent: 'approve', label: `Approve ${plan.approval.symbol}`, disabled: false }
  }
  if (approval === 'unknown') {
    return { intent: 'busy', label: 'Checking allowance…', disabled: true }
  }

  return {
    intent: 'ready',
    label: `${isPoolBuyTab(tab) ? 'Buy' : 'Sell'} ${symbol}`,
    disabled: false,
  }
}

/**
 * What a buy costs the wallet, in the 18-decimal view the balance is read in.
 *
 * `null` on a sell: the tokens are the cost there, and the USDC balance is only
 * needed for gas -- which `useGasReserve` already accounts for on the curve.
 */
function spendWei(plan: PoolPlan): bigint | null {
  if (plan.tab === 'sell') return null
  const units = plan.tab === 'spend' ? plan.amountIn : plan.bound
  // THROUGH THE SEAM, NOT THROUGH AN INLINE `1e12`. The first draft of this
  // line wrote the constant out -- the fix for a class carrying a fresh
  // instance of that class, for the sixth time in this repository.
  return quoteWeiFromUnits(units)
}

export const POOL_BUTTON_ORDER: readonly ButtonIntent[] = [
  'blocked',
  'connect',
  'switch',
  'busy',
  'empty',
  'planError',
  'insufficient',
  'approve',
  'ready',
]
