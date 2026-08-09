import {
  planBuyExactQuoteIn,
  planBuyExactTokensOut,
  planSellExactTokensIn,
  USDC_ERC20_ADDRESS,
} from '@arcpad/shared/browser'
import { describe, expect, it } from 'vitest'
import { BUTTON_ORDER_SOURCE, CURVE_BUTTON_ORDER } from './ladder'
import {
  buildPoolPlan,
  CLOCK_SKEW_WARN_SECONDS,
  clockSkewSeconds,
  isPoolBuyTab,
  POOL_BOUND_LABEL,
  POOL_BUTTON_ORDER,
  POOL_DEADLINE_TTL_SECONDS,
  POOL_TAB_ACTION,
  POOL_TAB_QUOTE,
  POOL_TABS,
  poolButtonFor,
  poolDeadline,
  poolQuoteRequest,
  residualAllowance,
  slipDown,
  slipUp,
  type PoolTab,
} from '@/components/token/poolPlan'
import { quoteUnitsFromWei, quoteWeiFromUnits } from '@/lib/quoteUnits'
import { ROUTER_QUOTE_FUNCTIONS, ROUTER_SWAP_FUNCTIONS } from '@/lib/routerAbi'
import { CLIMBED, FEES, FRESH, TESTNET_PROFILE, TOKEN, TRADER } from '../trade/fixtures'

const DEADLINE = 1_786_292_807n
const ONE_USDC_WEI = 10n ** 18n

function plan(tab: PoolTab, amount: bigint, quoted: bigint, slipBps = 100) {
  return buildPoolPlan({
    tab,
    token: TOKEN,
    tokenSymbol: 'DIFF',
    quoteAsset: USDC_ERC20_ADDRESS,
    amount,
    quoted,
    slipBps,
    recipient: TRADER,
    deadline: DEADLINE,
  })
}

// --------------------------------------------------------------------------
// Each tab reaches its own entrypoint -- and its own QUOTE entrypoint
// --------------------------------------------------------------------------

describe('each tab reaches its own entrypoint', () => {
  it('Spend USDC sends buyExactIn with the budget IN UNITS and a token floor', () => {
    const p = plan('spend', ONE_USDC_WEI, 17_000_000_000_000_000_000n)
    expect(p.action).toBe('buyExactIn')
    // `[token, quoteIn, minTokensOut, to, deadline]`
    expect(p.args[0]).toBe(TOKEN)
    // THE UNIT: 1 USDC is 1e18 native wei and 1_000_000 to the router.
    expect(p.args[1]).toBe(1_000_000n)
    expect(p.args[2]).toBe(slipDown(17_000_000_000_000_000_000n, 100))
    expect(p.args[3]).toBe(TRADER)
    expect(p.args[4]).toBe(DEADLINE)
    expect(p.boundKind).toBe('minOut')
  })

  it('Receive tokens sends buyExactOut with a USDC CAP, not a token floor', () => {
    const p = plan('receive', 17_000_000_000_000_000_000n, 1_000_000n)
    expect(p.action).toBe('buyExactOut')
    expect(p.args[1]).toBe(17_000_000_000_000_000_000n)
    expect(p.args[2]).toBe(slipUp(1_000_000n, 100))
    expect(p.boundKind).toBe('maxIn')
    // THE MUTANT THAT WOULD LIVE HERE: reading `amountOut` as the quote. The
    // user typed the OUTPUT on this tab, so the quoted number is the INPUT.
    expect(p.amountOut).toBe(17_000_000_000_000_000_000n)
    expect(p.amountIn).toBe(1_000_000n)
  })

  it('Sell sends sellExactIn with a USDC floor', () => {
    const p = plan('sell', 500n * 10n ** 18n, 1_000_000n)
    expect(p.action).toBe('sellExactIn')
    expect(p.args[1]).toBe(500n * 10n ** 18n)
    expect(p.args[2]).toBe(slipDown(1_000_000n, 100))
    expect(p.boundKind).toBe('minOut')
  })

  it('the declared tab->entrypoint maps are the ones the router actually has', () => {
    // Without this the two tables could name a function that does not exist and
    // every call would fail at the wallet.
    for (const tab of POOL_TABS) {
      expect(ROUTER_SWAP_FUNCTIONS).toContain(POOL_TAB_ACTION[tab])
      expect(ROUTER_QUOTE_FUNCTIONS).toContain(POOL_TAB_QUOTE[tab])
      expect(POOL_BOUND_LABEL[tab].length).toBeGreaterThan(0)
    }
    // AND THE THREE ARE DISTINCT: a map that sent two tabs to one entrypoint
    // would make one tab silently do the other's job.
    expect(new Set(POOL_TABS.map((t) => POOL_TAB_ACTION[t])).size).toBe(3)
    expect(new Set(POOL_TABS.map((t) => POOL_TAB_QUOTE[t])).size).toBe(3)
    // The fourth shape exists on the router and is deliberately unexposed.
    expect(ROUTER_SWAP_FUNCTIONS).toContain('sellExactOut')
    expect(POOL_TABS.map((t) => POOL_TAB_ACTION[t])).not.toContain('sellExactOut')
  })

  it('the quote request converts ONLY on the spend tab, and refuses sub-quantum budgets', () => {
    expect(poolQuoteRequest({ tab: 'spend', token: TOKEN, amount: ONE_USDC_WEI })).toEqual({
      fn: 'quoteBuyExactIn',
      args: [TOKEN, 1_000_000n],
    })
    // A token amount is NOT converted: it is already 18-decimal on both sides.
    expect(poolQuoteRequest({ tab: 'sell', token: TOKEN, amount: ONE_USDC_WEI })).toEqual({
      fn: 'quoteSellExactIn',
      args: [TOKEN, ONE_USDC_WEI],
    })
    // Below one micro-USDC there is nothing to ask: `quoteBuyExactIn(token, 0)`
    // reverts `AmountOutOfRange` rather than answering.
    expect(poolQuoteRequest({ tab: 'spend', token: TOKEN, amount: 999_999_999_999n })).toBeNull()
    expect(poolQuoteRequest({ tab: 'spend', token: TOKEN, amount: null })).toBeNull()
  })
})

// --------------------------------------------------------------------------
// The approval -- the biggest UX difference between the two venues
// --------------------------------------------------------------------------

describe('the approval names the right asset and the right amount', () => {
  it('a buy approves USDC, a sell approves the token', () => {
    expect(plan('spend', ONE_USDC_WEI, 1n).approval.token).toBe(USDC_ERC20_ADDRESS)
    expect(plan('receive', 1n, 1_000_000n).approval.token).toBe(USDC_ERC20_ADDRESS)
    expect(plan('sell', 1n, 1_000_000n).approval.token).toBe(TOKEN)
    expect(plan('spend', ONE_USDC_WEI, 1n).approval.decimals).toBe(6)
    expect(plan('sell', 1n, 1_000_000n).approval.decimals).toBe(18)
    expect(plan('sell', 1n, 1_000_000n).approval.symbol).toBe('DIFF')
  })

  /**
   * THE DEFECT THIS TEST EXISTS FOR.
   *
   * On `buyExactOut` the router pulls whatever the swap COSTS and only then
   * compares it against `maxQuoteIn`. An allowance sized to the QUOTE therefore
   * fails exactly when the price moved -- which is the case the slippage
   * tolerance exists to survive, so the user would meet
   * "ERC20: transfer amount exceeds allowance" in precisely the situation the
   * panel promised to handle.
   */
  it('exact-output approves the BOUND, not the quote', () => {
    const p = plan('receive', 17_000_000_000_000_000_000n, 1_000_000n, 100)
    expect(p.approval.amount).toBe(1_010_000n)
    expect(p.approval.amount).toBe(p.bound)
    expect(p.approval.amount).toBeGreaterThan(p.amountIn)
  })

  it('exact-input approves EXACTLY what is spent, on both legs', () => {
    const buy = plan('spend', ONE_USDC_WEI, 17n)
    expect(buy.approval.amount).toBe(1_000_000n)
    expect(residualAllowance(buy)).toBe(0n)

    const sell = plan('sell', 500n * 10n ** 18n, 1_000_000n)
    expect(sell.approval.amount).toBe(500n * 10n ** 18n)
    expect(residualAllowance(sell)).toBe(0n)
  })

  /**
   * AND THE ONE SHAPE WHERE THE PROMISE CANNOT BE KEPT IS NAMED.
   *
   * `maxQuoteIn - amountIn` stays approved after the swap. That is a real
   * standing authority over the user's USDC, and the panel says so rather than
   * letting them discover it.
   */
  it('exact-output leaves a residual allowance, and its size is exact', () => {
    const p = plan('receive', 17_000_000_000_000_000_000n, 1_000_000n, 100)
    expect(residualAllowance(p)).toBe(10_000n)
    // At zero tolerance there is nothing left over -- the residual is the
    // tolerance, not an accident.
    expect(residualAllowance(plan('receive', 17n, 1_000_000n, 0))).toBe(0n)
  })
})

// --------------------------------------------------------------------------
// Slippage -- DIFFERENTIAL against the shared planners
// --------------------------------------------------------------------------

describe('the slippage helpers agree with packages/shared, measured not assumed', () => {
  /**
   * `slipDown`/`slipUp` are PRIVATE in `packages/shared/src/trade.ts` and
   * `packages/` belongs to another track, so this file carries a second copy.
   * Two implementations of one rule is how a rounding difference is born, so
   * the copy is pinned by RUNNING the real planners and reading the bound they
   * emit. If the shared implementation changes, this goes red here.
   */
  const budgets = [10n ** 12n, 10n ** 15n, ONE_USDC_WEI, 5n * ONE_USDC_WEI]
  const tolerances = [0, 1, 50, 100, 300, 500, 10_000]

  it('slipDown equals what planBuyExactQuoteIn puts in minTokensOut', () => {
    let checked = 0
    for (const budget of budgets) {
      for (const slip of tolerances) {
        const shared = planBuyExactQuoteIn(FRESH, TESTNET_PROFILE, FEES, budget, slip)
        expect(slipDown(shared.tokens, slip), `budget=${budget} slip=${slip}`).toBe(shared.args[0])
        checked += 1
      }
    }
    // ANTI-VACUITY: an empty grid would satisfy the loop.
    expect(checked).toBe(budgets.length * tolerances.length)
  })

  it('slipDown equals what planSellExactTokensIn puts in minQuoteOut', () => {
    for (const tokens of [10n ** 21n, 10n ** 24n, 10n ** 25n]) {
      for (const slip of tolerances) {
        const shared = planSellExactTokensIn(CLIMBED, TESTNET_PROFILE, FEES, tokens, slip)
        const netOut = shared.curveAmount - shared.protocolFee - shared.creatorFee
        expect(slipDown(netOut, slip), `tokens=${tokens} slip=${slip}`).toBe(shared.args[1])
      }
    }
  })

  it('slipUp equals what planBuyExactTokensOut puts in maxQuoteIn', () => {
    for (const tokens of [10n ** 21n, 10n ** 24n, 10n ** 25n]) {
      for (const slip of tolerances) {
        const shared = planBuyExactTokensOut(FRESH, TESTNET_PROFILE, FEES, tokens, slip)
        const total = shared.curveAmount + shared.protocolFee + shared.creatorFee
        expect(slipUp(total, slip), `tokens=${tokens} slip=${slip}`).toBe(shared.args[1])
      }
    }
  })

  it('the two directions are NOT the same function -- a ceil and a floor', () => {
    // Without this the differential above could pass with both helpers being
    // the same rounding, which is only visible when the product is not exact.
    expect(slipDown(1_000_001n, 1)).toBe(999_900n)
    expect(slipUp(1_000_001n, 1)).toBe(1_000_102n)
    expect(slipUp(1_000_000n, 0)).toBe(1_000_000n)
    expect(slipDown(1_000_000n, 0)).toBe(1_000_000n)
  })

  it('an out-of-range tolerance is refused rather than silently clamped', () => {
    expect(() => slipDown(1n, 10_001)).toThrow(RangeError)
    expect(() => slipUp(1n, -1)).toThrow(RangeError)
    expect(() => slipDown(1n, 0.5)).toThrow(RangeError)
  })
})

// --------------------------------------------------------------------------
// The deadline
// --------------------------------------------------------------------------

describe('the deadline is anchored to the CHAIN clock', () => {
  /**
   * A browser clock ten minutes fast produces a deadline that is already past
   * by the chain's reckoning, and then EVERY swap reverts `DeadlinePassed`
   * instantly -- a total, machine-specific failure no devchain can reproduce,
   * because there the two clocks are the same clock.
   */
  it('a skewed browser clock does not move the deadline', () => {
    const chain = 1_786_292_507n
    const browserFast = (Number(chain) + 600) * 1000
    expect(poolDeadline(chain, browserFast)).toBe(chain + POOL_DEADLINE_TTL_SECONDS)
    const browserSlow = (Number(chain) - 600) * 1000
    expect(poolDeadline(chain, browserSlow)).toBe(chain + POOL_DEADLINE_TTL_SECONDS)
  })

  it('with no chain reading the browser is the fallback, not a refusal', () => {
    const ms = 1_786_292_507_400
    expect(poolDeadline(null, ms)).toBe(1_786_292_507n + POOL_DEADLINE_TTL_SECONDS)
  })

  it('the skew is reported signed, and the live reading was one second', () => {
    // MEASURED 2026-08-09: head timestamp 1786292507, Date.now() 1786292508.
    expect(clockSkewSeconds(1_786_292_507n, 1_786_292_508_000)).toBe(1n)
    expect(clockSkewSeconds(1_786_292_507n, 1_786_291_907_000)).toBe(-600n)
    expect(clockSkewSeconds(null, 1_786_292_508_000)).toBeNull()
    // The threshold is far above the measured skew, so a healthy machine is
    // never told its clock is wrong.
    expect(CLOCK_SKEW_WARN_SECONDS).toBeGreaterThan(1n)
  })

  it('five minutes, and it is on the plan rather than applied somewhere later', () => {
    expect(POOL_DEADLINE_TTL_SECONDS).toBe(300n)
    expect(plan('spend', ONE_USDC_WEI, 1n).deadline).toBe(DEADLINE)
    expect(plan('spend', ONE_USDC_WEI, 1n).args[4]).toBe(DEADLINE)
  })
})

// --------------------------------------------------------------------------
// The button ladder
// --------------------------------------------------------------------------

describe('the button ladder', () => {
  const READY = {
    connection: 'connected' as const,
    chainName: 'Arc Testnet',
    symbol: 'DIFF',
    tab: 'spend' as PoolTab,
    amount: ONE_USDC_WEI,
    plan: plan('spend', ONE_USDC_WEI, 17n),
    available: 100n * ONE_USDC_WEI,
    approval: 'sufficient' as const,
    phase: 'idle' as const,
    quoteFailure: null,
    routerMissing: false,
  }

  it('no router outranks everything, including connect', () => {
    // Connecting a wallet cannot help: without a router there is no entrypoint
    // to a v4 pool at all.
    const button = poolButtonFor({ ...READY, routerMissing: true, connection: 'disconnected' })
    expect(button.intent).toBe('blocked')
    expect(button.disabled).toBe(true)
  })

  it('the full ladder, in order', () => {
    expect(poolButtonFor({ ...READY, connection: 'disconnected' }).intent).toBe('connect')
    expect(poolButtonFor({ ...READY, connection: 'wrongNetwork' }).label).toBe(
      'Switch to Arc Testnet',
    )
    expect(poolButtonFor({ ...READY, phase: 'pending' }).intent).toBe('busy')
    expect(poolButtonFor({ ...READY, amount: null }).intent).toBe('empty')
    expect(
      poolButtonFor({
        ...READY,
        quoteFailure: { title: 'This token has no pool yet.', code: 'no-pool' },
      }).label,
    ).toBe('This token has no pool yet.')
    expect(poolButtonFor({ ...READY, available: 1n }).intent).toBe('insufficient')
    expect(poolButtonFor({ ...READY, approval: 'required' }).label).toBe('Approve USDC')
    expect(poolButtonFor({ ...READY, approval: 'unknown' }).intent).toBe('busy')
    expect(poolButtonFor(READY)).toEqual({ intent: 'ready', label: 'Buy DIFF', disabled: false })
  })

  it('a sell asks to approve the TOKEN, not USDC', () => {
    // The single most likely wrong label: one `Approve USDC` string for both
    // legs, which tells a seller to approve an asset they are not spending.
    const sell = plan('sell', 500n * 10n ** 18n, 1_000_000n)
    const button = poolButtonFor({
      ...READY,
      tab: 'sell',
      plan: sell,
      available: 10n ** 24n,
      approval: 'required',
    })
    expect(button.label).toBe('Approve DIFF')
  })

  /**
   * THE COMPARISON THAT CROSSES THE TWO VIEWS.
   *
   * On `receive` the user typed TOKENS and the wallet pays USDC. Comparing the
   * typed number against a USDC balance compares two different units and would
   * report "insufficient" for a wallet that can easily afford the trade -- or,
   * worse, the reverse.
   */
  it('affordability is measured on what LEAVES the wallet, in the 18-decimal view', () => {
    const receive = plan('receive', 17_000_000_000_000_000_000n, 1_000_000n, 100)
    // `maxQuoteIn` is 1_010_000 units == 1.01 USDC == 1.01e18 wei.
    expect(quoteWeiFromUnits(receive.bound)).toBe(1_010_000_000_000_000_000n)
    expect(
      poolButtonFor({
        ...READY,
        tab: 'receive',
        plan: receive,
        available: 1_010_000_000_000_000_000n,
      }).intent,
    ).toBe('ready')
    expect(
      poolButtonFor({
        ...READY,
        tab: 'receive',
        plan: receive,
        available: 1_009_999_999_999_999_999n,
      }).intent,
    ).toBe('insufficient')
  })

  it('a sell measures affordability in TOKENS', () => {
    const sell = plan('sell', 500n * 10n ** 18n, 1_000_000n)
    expect(
      poolButtonFor({ ...READY, tab: 'sell', plan: sell, available: 500n * 10n ** 18n }).intent,
    ).toBe('ready')
    expect(
      poolButtonFor({ ...READY, tab: 'sell', plan: sell, available: 499n * 10n ** 18n }).intent,
    ).toBe('insufficient')
    expect(
      poolButtonFor({ ...READY, tab: 'sell', plan: sell, available: 499n * 10n ** 18n }).label,
    ).toBe('Insufficient DIFF')
  })

  it('no plan yet is a WAIT, never a ready button', () => {
    // A ready button with no plan would send `undefined` args to the wallet.
    expect(poolButtonFor({ ...READY, plan: null }).disabled).toBe(true)
    expect(poolButtonFor({ ...READY, plan: null }).intent).toBe('busy')
  })

  /**
   * THE TWO LADDERS SHARE THEIR ORDER.
   *
   * A user must not learn one sequence of states on the curve and meet another
   * on the pool. The curve's order is read out of `tradeModel.ts`'s own source
   * so this cannot drift by editing one file.
   */
  it('the pool ladder is the curve ladder, with `blocked` moved to the top', () => {
    expect(POOL_BUTTON_ORDER[0]).toBe('blocked')
    expect(POOL_BUTTON_ORDER.slice(1)).toEqual(BUTTON_ORDER_SOURCE)
    // ANTI-VACUITY: the extraction really read a ladder out of the curve panel.
    expect(CURVE_BUTTON_ORDER).toContain('blocked')
    expect(CURVE_BUTTON_ORDER.length).toBeGreaterThan(BUTTON_ORDER_SOURCE.length)
  })
})

describe('the units of every field are the router’s, not the screen’s', () => {
  it('a spend plan carries units in, token wei out', () => {
    const p = plan('spend', 12_161_433_000_000_000_000n, 200_723_953_120_761_740_526_324_105n)
    expect(p.amountIn).toBe(12_161_433n)
    expect(quoteWeiFromUnits(p.amountIn)).toBe(12_161_433_000_000_000_000n)
    expect(p.amountOut).toBe(200_723_953_120_761_740_526_324_105n)
  })

  it('the dust a budget loses on the way in is exactly its remainder', () => {
    // A budget that is not on the 1e12 grid cannot come from the field, but an
    // API caller could produce one, and truncation must not be silent upstream.
    const odd = ONE_USDC_WEI + 999_999_999_999n
    expect(quoteUnitsFromWei(odd)).toBe(1_000_000n)
    expect(plan('spend', odd, 1n).amountIn).toBe(1_000_000n)
  })

  it('isPoolBuyTab is the one place "is this a buy" is decided', () => {
    expect(POOL_TABS.filter(isPoolBuyTab)).toEqual(['spend', 'receive'])
  })
})
