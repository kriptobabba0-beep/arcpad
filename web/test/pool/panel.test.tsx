import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USDC_ERC20_ADDRESS } from '@arcpad/shared/browser'
import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  poolPanelFailure,
  PoolTradeForm,
  type PoolTradeFormProps,
} from '@/components/token/PoolTradePanel'
import { maxAmount } from '@/components/token/gas'
import type { PoolPlan } from '@/components/token/poolPlan'
import { decodePoolSwapError } from '@/lib/poolOutcome'
import { MEASURED_ROUTER_SELECTORS, MEASURED_USDC_ALLOWANCE_REVERT } from '@/lib/routerAbi'
import { TOKEN, TRADER } from '../trade/fixtures'

/**
 * ============ THE POOL PANEL'S BEHAVIOUR ============
 *
 * `PoolTradeForm` -- the PURE half -- is rendered, and everything that touches
 * a chain (the quote, the allowance, the balance, the head timestamp) arrives
 * as a prop. Same reason `panel.test.tsx` gives for the curve: measuring which
 * entrypoint a tab reaches through an RPC ties the assertion to the network, so
 * a broken tab and a slow node fail identically.
 */

const CHAIN_NOW = 1_786_292_507n
const NOW_MS = 1_786_292_508_000
const ONE_USDC_WEI = 10n ** 18n

/** A quote in the router's own units: 1 USDC in, 17 tokens out. */
const QUOTE_BUY = {
  kind: 'ok',
  amountIn: 1_000_000n,
  amountOut: 17_000_000_000_000_000_000n,
} as const

const DEFAULTS: PoolTradeFormProps = {
  symbol: 'DIFF',
  connection: 'connected',
  chainName: 'Arc Testnet',
  token: TOKEN,
  usdcBalance: 100n * ONE_USDC_WEI,
  spendable: 99n * ONE_USDC_WEI,
  gasReason: null,
  tokenBalance: 10n ** 24n,
  quote: QUOTE_BUY,
  approval: 'sufficient',
  approvalPhase: 'idle',
  phase: 'idle',
  failure: null,
  realised: null,
  routerMissing: false,
  chainNowSeconds: CHAIN_NOW,
  nowMs: NOW_MS,
  recipient: TRADER,
}

function setup(overrides: Partial<PoolTradeFormProps> = {}) {
  const onSubmit = vi.fn<(plan: PoolPlan) => void>()
  const onApprove = vi.fn()
  const onConnect = vi.fn()
  const onSwitch = vi.fn()
  const view = render(
    <PoolTradeForm
      {...DEFAULTS}
      {...overrides}
      onSubmit={onSubmit}
      onApprove={onApprove}
      onConnect={onConnect}
      onSwitch={onSwitch}
    />,
  )
  const q = within(view.container)
  return {
    q,
    view,
    onSubmit,
    onApprove,
    onConnect,
    onSwitch,
    user: userEvent.setup(),
    button: () => q.getByTestId('pool-submit'),
    field: () => q.getByRole('textbox', { name: /amount|tokens/i }),
    tab: (name: RegExp) => q.getByRole('tab', { name }),
  }
}

// --------------------------------------------------------------------------
// Three tabs, three entrypoints
// --------------------------------------------------------------------------

describe('each tab reaches its own router entrypoint', () => {
  it('Spend USDC sends buyExactIn with the budget IN 6-DECIMAL UNITS', async () => {
    const t = setup()
    await t.user.type(t.field(), '1')
    await t.user.click(t.button())

    expect(t.onSubmit).toHaveBeenCalledTimes(1)
    const plan = t.onSubmit.mock.calls[0]?.[0] as PoolPlan
    expect(plan.action).toBe('buyExactIn')
    // THE SEAM, END TO END: the user typed "1" USDC and the router gets
    // 1_000_000. A panel that passed 1e18 would ask for a trillion USDC.
    expect(plan.args[1]).toBe(1_000_000n)
    expect(plan.args[3]).toBe(TRADER)
    expect(plan.args[4]).toBe(CHAIN_NOW + 300n)
  })

  it('Receive tokens sends buyExactOut with a USDC cap', async () => {
    const t = setup({ quote: { kind: 'ok', amountIn: 1_000_000n, amountOut: 17n } })
    await t.user.click(t.tab(/Receive tokens/))
    await t.user.type(t.field(), '17')
    await t.user.click(t.button())

    const plan = t.onSubmit.mock.calls[0]?.[0] as PoolPlan
    expect(plan.action).toBe('buyExactOut')
    expect(plan.args[1]).toBe(17n * 10n ** 18n)
    expect(plan.args[2]).toBe(1_010_000n)
  })

  it('Sell sends sellExactIn with a USDC floor', async () => {
    const t = setup({ quote: { kind: 'ok', amountIn: 17n, amountOut: 1_000_000n } })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.type(t.field(), '500')
    await t.user.click(t.button())

    const plan = t.onSubmit.mock.calls[0]?.[0] as PoolPlan
    expect(plan.action).toBe('sellExactIn')
    expect(plan.args[1]).toBe(500n * 10n ** 18n)
    expect(plan.args[2]).toBe(990_000n)
  })

  it('the SELL quote line reads the OUTPUT leg, in USDC', async () => {
    // The mutant this kills reads `amountIn` on every tab. On a sell that is
    // the TOKEN leg, so "you receive" would print the number of tokens being
    // sold as a USDC amount -- 17 wei drawn as 0.000000 USDC here, and a
    // wildly wrong figure on any real trade.
    const t = setup({ quote: { kind: 'ok', amountIn: 17n, amountOut: 1_000_000n } })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.type(t.field(), '500')
    expect(t.q.getByTestId('pool-quote-amount').textContent).toBe('1.000000 USDC')
    expect(t.q.getByTestId('pool-quote-bound').textContent).toBe('0.990000 USDC')
  })

  it('the RECEIVE quote line reads the INPUT leg, in USDC', async () => {
    const t = setup({ quote: { kind: 'ok', amountIn: 1_000_000n, amountOut: 17n } })
    await t.user.click(t.tab(/Receive tokens/))
    await t.user.type(t.field(), '17')
    expect(t.q.getByTestId('pool-quote-amount').textContent).toBe('1.000000 USDC')
    expect(t.q.getByTestId('pool-quote-bound').textContent).toBe('1.010000 USDC')
  })

  it('the SPEND quote line reads the OUTPUT leg, in TOKENS', async () => {
    const t = setup()
    await t.user.type(t.field(), '1')
    expect(t.q.getByTestId('pool-quote-amount').textContent).toBe('17.000000 DIFF')
  })

  it('switching tabs CLEARS the field, because the unit changed', async () => {
    const t = setup()
    await t.user.type(t.field(), '1.5')
    await t.user.click(t.tab(/^Sell$/))
    // "1.5 USDC" silently becoming "1.5 DIFF" is a different trade.
    expect((t.field() as HTMLInputElement).value).toBe('')
  })
})

// --------------------------------------------------------------------------
// Approvals -- the biggest difference between the two venues
// --------------------------------------------------------------------------

describe('approvals are new to this product, and the panel says so up front', () => {
  it('the panel states that BUYS need an approval too', async () => {
    // The curve taught "sell is two steps, buy is one". Here both are two, and
    // an unexpected second wallet dialog is what people learn to reject.
    const t = setup()
    expect(t.q.getByTestId('pool-venue-note').textContent).toMatch(/transferFrom/)
    expect(t.q.getByTestId('pool-venue-note').textContent).toMatch(/buys included/i)
  })

  it('a BUY that needs approval asks for USDC and does not submit', async () => {
    const t = setup({ approval: 'required' })
    await t.user.type(t.field(), '1')
    expect(t.button().textContent).toBe('Approve USDC')
    await t.user.click(t.button())
    expect(t.onApprove).toHaveBeenCalledTimes(1)
    // THE MUTANT THIS KILLS: an "Approve" press that also fires the swap. The
    // user must never sign something they did not press.
    expect(t.onSubmit).not.toHaveBeenCalled()
  })

  it('a SELL that needs approval asks for the TOKEN, not USDC', async () => {
    const t = setup({
      approval: 'required',
      quote: { kind: 'ok', amountIn: 17n, amountOut: 1_000_000n },
    })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.type(t.field(), '500')
    expect(t.button().textContent).toBe('Approve DIFF')
  })

  it('the two-step list names the asset AND the amount, in that asset’s decimals', async () => {
    const t = setup({ approval: 'required' })
    await t.user.type(t.field(), '1')
    const step = t.q.getByTestId('approve-step-1')
    // 1_000_000 units drawn as 1.000000 USDC -- through the seam, so a 1e12
    // error here would read as 0.000001.
    expect(step.textContent).toContain('Approve USDC')
    expect(step.textContent).toContain('1.000000 USDC')
    expect(t.q.getByTestId('approve-step-2').textContent).toBe('Swap')
  })

  it('a SELL’s approve list is drawn in TOKEN decimals', async () => {
    const t = setup({
      approval: 'required',
      quote: { kind: 'ok', amountIn: 17n, amountOut: 1_000_000n },
    })
    await t.user.click(t.tab(/^Sell$/))
    await t.user.type(t.field(), '500')
    expect(t.q.getByTestId('approve-step-1').textContent).toContain('500.000000 DIFF')
    expect(t.q.getByTestId('approve-step-2').textContent).toBe('Sell')
  })

  /**
   * THE ONE SHAPE WHERE "APPROVE EXACTLY WHAT YOU SPEND" CANNOT HOLD.
   *
   * `buyExactOut` approves `maxQuoteIn` and spends `amountIn`; the difference
   * stays approved. Approving only the quote instead would fail exactly when
   * the price moved -- the case slippage exists to survive.
   */
  it('exact-output warns that part of the approval survives the swap', async () => {
    const t = setup({
      approval: 'required',
      quote: { kind: 'ok', amountIn: 1_000_000n, amountOut: 17n },
    })
    await t.user.click(t.tab(/Receive tokens/))
    await t.user.type(t.field(), '17')
    expect(t.q.getByTestId('approve-step-1').textContent).toContain('1.010000 USDC')
    const residual = t.q.getByTestId('approve-residual')
    expect(residual.textContent).toContain('0.010000 USDC')
    expect(residual.textContent).toMatch(/stay approved/i)
  })

  it('the OTHER two shapes carry no residual line, because they leave none', async () => {
    // Without this the notice could be unconditional and would teach users to
    // distrust the two shapes that keep the promise.
    const t = setup({ approval: 'required' })
    await t.user.type(t.field(), '1')
    expect(t.q.queryByTestId('approve-residual')).toBeNull()
  })

  it('an unknown allowance WAITS rather than guessing', async () => {
    const t = setup({ approval: 'unknown' })
    await t.user.type(t.field(), '1')
    expect(t.button().textContent).toBe('Checking allowance…')
    expect(t.button()).toBeDisabled()
  })
})

// --------------------------------------------------------------------------
// No pool, no router
// --------------------------------------------------------------------------

describe('what the panel shows when there is no pool -- which is every token today', () => {
  /**
   * MEASURED 2026-08-09: `quoteBuyExactIn` against BOTH production tokens
   * answers `PoolNotInitialized()` (`0x486aa307`) on the live router. This is
   * the only pool state reachable on any chain right now.
   */
  it('a PoolNotInitialized quote is a NOT-YET, not a red error', async () => {
    const failure = decodePoolSwapError({
      cause: { data: MEASURED_ROUTER_SELECTORS.PoolNotInitialized },
    })
    expect(failure.code).toBe('no-pool')
    const t = setup({ quote: { kind: 'failed', failure } })
    await t.user.type(t.field(), '1')
    const notice = t.q.getByTestId('pool-absent')
    expect(notice.textContent).toMatch(/no pool yet/i)
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.className).not.toContain('text-negative')
    // And nothing can be signed.
    expect(t.button()).toBeDisabled()
    await t.user.click(t.button())
    expect(t.onSubmit).not.toHaveBeenCalled()
  })

  it('CONTROL: a real fault IS drawn as an alert', async () => {
    // Without this the "not red" assertion could be satisfied by making every
    // quote failure neutral.
    const failure = decodePoolSwapError({ cause: { data: { errorName: 'NotPoolManager' } } })
    const t = setup({ quote: { kind: 'failed', failure } })
    await t.user.type(t.field(), '1')
    expect(t.q.getByTestId('pool-quote-failed').getAttribute('role')).toBe('alert')
  })

  it('a build with no router explains itself and offers NO control', () => {
    const t = setup({ routerMissing: true })
    expect(t.q.getByTestId('pool-no-router').textContent).toMatch(/no entrypoint/i)
    // NOT a disabled button: a control that can never do anything is worse
    // than no control. `poolButtonFor` still carries a `routerMissing` rung as
    // an independent guard for any caller that DOES render the button, and
    // `usePoolTrade.submit` refuses a null router as a third -- three guards,
    // one screen.
    expect(t.q.queryByTestId('pool-submit')).toBeNull()
    expect(t.q.queryByRole('tab')).toBeNull()
  })

  it('a quote in flight says so rather than showing a stale number', async () => {
    const t = setup({ quote: { kind: 'loading' } })
    await t.user.type(t.field(), '1')
    expect(t.q.getByTestId('pool-quote-loading')).toBeInTheDocument()
    expect(t.button()).toBeDisabled()
  })
})

// --------------------------------------------------------------------------
// Slippage, deadline, clock
// --------------------------------------------------------------------------

describe('slippage and the deadline are visible, and the deadline follows the chain', () => {
  it('the default tolerance is drawn and it moves the bound', async () => {
    const t = setup()
    expect(t.q.getByTestId('slippage-value').textContent).toBe('1%')
    await t.user.type(t.field(), '1')
    // 17 tokens minus 1% -> the floor that goes on chain.
    expect(t.q.getByTestId('pool-quote-bound').textContent).toContain('16.830000')
    /*
     * SLIPAJ ARTIK TEK SATIR: uc hap ve bir "Custom" kutusu yerine
     * "Auto 1% ✎". Degistirmek icin kalem acilir ve deger yazilir -- yani
     * kullanicinin yaptigi sey degil, ona ULASMA yolu degisti. Iddia ayni:
     * toleransi genisletmek zincire giden TABANI dusurur.
     */
    await t.user.click(t.q.getByTestId('slippage-edit'))
    await t.user.clear(t.q.getByLabelText(/max slippage, percent/i))
    await t.user.type(t.q.getByLabelText(/max slippage, percent/i), '3')
    expect(t.q.getByTestId('pool-quote-bound').textContent).toContain('16.490000')
  })

  it('the quote line says the fee is already taken out', async () => {
    // A separate "fee" row would be a SECOND implementation of a rule that has
    // already run on chain -- the router's amounts are net of the hook.
    const t = setup()
    await t.user.type(t.field(), '1')
    expect(t.q.getByTestId('pool-fee-note').textContent).toMatch(/already taken out/i)
  })

  it('the deadline is stated, and it is five minutes', () => {
    const t = setup()
    expect(t.q.getByTestId('pool-deadline-note').textContent).toMatch(/expires 5 minutes/)
  })

  it('a skewed clock is reported, and the deadline still follows the CHAIN', async () => {
    const t = setup({ nowMs: (Number(CHAIN_NOW) + 600) * 1000 })
    await t.user.type(t.field(), '1')
    expect(t.q.getByTestId('pool-clock-skew').textContent).toMatch(/600 seconds ahead of/)
    await t.user.click(t.button())
    const plan = t.onSubmit.mock.calls[0]?.[0] as PoolPlan
    expect(plan.args[4]).toBe(CHAIN_NOW + 300n)
  })

  it('a healthy clock says nothing -- the live skew was one second', () => {
    // Without this the notice could be unconditional and every user would be
    // told their clock is broken.
    expect(setup().q.queryByTestId('pool-clock-skew')).toBeNull()
  })
})

// --------------------------------------------------------------------------
// Balances and gas
// --------------------------------------------------------------------------

describe('balances, gas and the shortcuts', () => {
  it('ONE USDC figure on screen, never two views as two lines', () => {
    const t = setup()
    const balance = t.q.getByText(/^Balance/)
    expect(balance.textContent).toContain('100.000000')
    expect(balance.textContent).not.toContain('100000000')
  })

  it('the gas reserve is named when MAX is smaller than the balance', () => {
    expect(setup().q.getByTestId('pool-gas-reserve-note').textContent).toMatch(/for gas/)
  })

  /**
   * A POOL SWAP CANNOT BE GAS-ESTIMATED BEFORE IT IS APPROVED -- the estimate
   * runs the real call and it reverts inside `transferFrom`. MAX goes dark
   * WITH A REASON rather than reserving a made-up constant.
   */
  it('with no estimate MAX is disabled and the reason is on it', () => {
    const t = setup({ spendable: null, gasReason: 'Gas cannot be estimated until approved.' })
    const max = t.q.getByTestId('max-button')
    expect(max).toBeDisabled()
    expect(max.getAttribute('title')).toBe('Gas cannot be estimated until approved.')
  })

  it('MAX fills the field with a value the field accepts, and the dust is dropped', async () => {
    const t = setup({ spendable: 99n * ONE_USDC_WEI + 999_999_999_999n })
    await t.user.click(t.q.getByTestId('max-button'))
    expect((t.field() as HTMLInputElement).value).toBe('99.000000')
    // NO GROUPING SEPARATOR: `parseUsdcAmount` refuses commas, so a MAX that
    // produced one would be rejected by the field it just filled.
    const big = setup({ spendable: 1_234_567n * ONE_USDC_WEI })
    await big.user.click(big.q.getByTestId('max-button'))
    expect((big.field() as HTMLInputElement).value).toBe('1234567.000000')
  })

  /**
   * AND THE REASON THE ROUNDING DIRECTION ABOVE IS UNOBSERVABLE, WRITTEN DOWN.
   *
   * MEASURED by mutation: flipping the panel's formatter to `rounding: 'up'`
   * SURVIVES. That is not a hole -- it is because `maxAmount` has ALREADY
   * quantised to the 1e12 grid, so there is never a fraction left to round in
   * either direction. The first draft of this file also called
   * `quantiseToInput` in the panel, which was a THIRD copy of the same
   * quantisation and equally unobservable; it is gone.
   *
   * The precondition is asserted rather than assumed, because if `maxAmount`
   * ever stopped quantising, `rounding: 'down'` would become load-bearing --
   * rounding UP would overshoot `spendable` by a micro-USDC and eat exactly the
   * gas reserve it had just left.
   */
  it('CONTROL: the MAX helper is what quantises, and it always does', () => {
    const picked = maxAmount(99n * ONE_USDC_WEI + 999_999_999_999n)
    expect(picked).not.toBeNull()
    expect(picked! % 1_000_000_000_000n).toBe(0n)
  })

  it('affordability is measured on what leaves the wallet', async () => {
    const t = setup({ spendable: 1n * ONE_USDC_WEI, usdcBalance: 1n * ONE_USDC_WEI })
    await t.user.type(t.field(), '2')
    expect(t.button().textContent).toBe('Insufficient USDC')
  })
})

// --------------------------------------------------------------------------
// Failures and receipts
// --------------------------------------------------------------------------

describe('failures and the receipt', () => {
  /**
   * ============ TWO LEGS, TWO WIRE SHAPES, ONE SCREEN ============
   *
   * The same cause -- "the router may not move that much" -- arrives in two
   * completely different envelopes, one per leg, and BOTH are asserted here on
   * the RENDERED panel rather than only on the decoder:
   *
   *   BUY  USDC `0x3600…0000` is a Circle FiatToken. Measured 2026-08-09 by
   *        `eth_call`ing `transferFrom` with no allowance:
   *        `0x08c379a0…` -> `Error(string) "ERC20: transfer amount exceeds
   *        allowance"`. NO SELECTOR AT ALL.
   *   SELL `LaunchToken` is an OpenZeppelin ERC-20 and refuses with the custom
   *        error `ERC20InsufficientAllowance(address,uint256,uint256)`.
   *
   * The decoder half of this is in `abi.test.ts`. This is the composed half,
   * and it is the one that matters: a decoder that is right while the panel
   * draws something else is exactly the shape this package keeps shipping.
   */
  it.each([
    [
      'the live USDC string (BUY leg)',
      { cause: { message: `execution reverted: ${MEASURED_USDC_ALLOWANCE_REVERT}` } },
    ],
    [
      'the OZ custom error (SELL leg)',
      { cause: { data: { errorName: 'ERC20InsufficientAllowance' } } },
    ],
  ])('an allowance shortfall arriving as %s tells the user to Approve', async (_name, wire) => {
    const failure = decodePoolSwapError(wire)
    const t = setup({ failure })
    expect(t.q.getByTestId('pool-failure').textContent).toMatch(/not approved to move/i)
    expect(t.q.getByTestId('pool-failure').textContent).toMatch(/Press Approve/i)
  })

  it('CONTROL: an unrelated string revert is NOT read as an allowance problem', async () => {
    // Without this, the buy-leg branch could match every string revert and the
    // assertion above would pass while telling a user to press Approve for a
    // failure Approve cannot fix.
    const failure = decodePoolSwapError({
      cause: { message: 'execution reverted: Blacklistable: account is blacklisted' },
    })
    const t = setup({ failure })
    expect(t.q.getByTestId('pool-failure').textContent).not.toMatch(/Press Approve/i)
    expect(t.q.getByTestId('pool-failure').textContent).toContain('blacklisted')
  })

  /**
   * ============ THE DEFECT: A FAILED APPROVAL WAS SILENT ON THIS PANEL ============
   *
   * `TradePanel` (the curve) renders `trade.failure ?? approval.failure`.
   * `PoolTradePanel` rendered `trade.failure` alone, so an approval that failed
   * -- rejected in the wallet, out of gas, refused by USDC's blocklist -- put
   * NOTHING on screen: the button went back to "Approve" and the user was left
   * to guess. Covered on one panel, read as covered on both.
   *
   * The form half is asserted by rendering; the WIRING half cannot be, because
   * `PoolTradePanel` needs wagmi. So it is asserted in source, with anti-vacuity
   * -- the same shape `test/pool/page.test.ts` uses for the page's call sites.
   */
  it('a rejected APPROVAL is drawn, not swallowed', async () => {
    const failure = decodePoolSwapError({ code: 4001, message: 'User rejected' })
    const t = setup({ failure, approval: 'required', approvalPhase: 'failed' })
    expect(t.q.getByTestId('pool-failure').textContent).toMatch(/cancelled/i)
    expect(t.q.getByTestId('pool-failure').textContent).toMatch(/nothing was spent/i)
  })

  describe('poolPanelFailure — the merge itself, RUN rather than read', () => {
    const swapFailure = decodePoolSwapError({ cause: { data: { errorName: 'TooLittleReceived' } } })
    const approveRejected = { code: 4001, message: 'User rejected' }

    it('an approval error is surfaced when the swap has not failed', () => {
      const merged = poolPanelFailure(null, approveRejected)
      expect(merged).not.toBeNull()
      expect(merged?.code).toBe('rejected')
      // AND IT IS THE POOL'S DICTIONARY, not the curve's: `PoolFailure` carries
      // `tone`/`body`, `ArcpadFailure` carries `kind`/`detail`.
      expect(merged?.tone).toBe('neutral')
      expect(merged?.body.length).toBeGreaterThan(0)
    })

    it('the SWAP’s failure wins when both exist', () => {
      // The later, more specific event, and the one the user was waiting on.
      expect(poolPanelFailure(swapFailure, approveRejected)?.code).toBe('slippage')
    })

    it('no failure at all stays null -- an idle panel draws no notice', () => {
      expect(poolPanelFailure(null, null)).toBeNull()
      expect(poolPanelFailure(null, undefined)).toBeNull()
    })

    it('an approval refused by a STRING revert still says what the chain said', () => {
      // USDC on Arc is a FiatToken: `approve` can be refused by the blocklist or
      // by `whenNotPaused`, neither of which has a selector.
      const merged = poolPanelFailure(null, {
        cause: { message: 'execution reverted: Blacklistable: account is blacklisted' },
      })
      expect(merged?.body).toContain('blacklisted')
    })
  })

  it('the container FORWARDS the approval error into that merge', () => {
    // The merge is executed above; this is the hop that cannot be, because
    // `PoolTradePanel` needs wagmi to mount. Same shape as `page.test.ts`.
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'components',
        'token',
        'PoolTradePanel.tsx',
      ),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    expect(source).toMatch(/failure=\{poolPanelFailure\(trade\.failure, approval\.error\)\}/)
    // ANTI-VACUITY: the scan really reads this component.
    expect(source).toContain('usePoolTrade(router)')
    expect(source).toContain('<PoolTradeForm')
  })

  it('a user rejection is NEUTRAL, not an alert', () => {
    const failure = decodePoolSwapError({ code: 4001, message: 'User rejected' })
    const t = setup({ failure })
    expect(t.q.getByTestId('pool-failure').getAttribute('role')).toBe('status')
    expect(failure.tone).toBe('neutral')
  })

  it('the receipt draws the REALISED amounts, in the two right units', () => {
    const t = setup({
      realised: {
        buy: true,
        amountIn: 1_000_000n,
        amountOut: 17_000_000_000_000_000_000n,
        quoteWei: 1_000_000_000_000_000_000n,
        tokensTok: 17_000_000_000_000_000_000n,
        txHash: `0x${'cd'.repeat(32)}`,
      },
    })
    expect(t.q.getByTestId('pool-realised-tokens').textContent).toContain('17.000000 DIFF')
    expect(t.q.getByTestId('pool-realised-usdc').textContent).toContain('1.000000')
  })

  it('a pending transaction links to the explorer', () => {
    const t = setup({
      phase: 'pending',
      hash: `0x${'ef'.repeat(32)}`,
      explorerUrl: 'https://testnet.arcscan.app',
    })
    const link = t.q.getByRole('link', { name: /explorer/i })
    expect(link.getAttribute('href')).toBe(`https://testnet.arcscan.app/tx/0x${'ef'.repeat(32)}`)
  })
})

describe('the wallet rungs', () => {
  it('disconnected points at the shell’s connect button', async () => {
    const t = setup({ connection: 'disconnected', recipient: null })
    await t.user.click(t.button())
    expect(t.onConnect).toHaveBeenCalledTimes(1)
    expect(t.onSubmit).not.toHaveBeenCalled()
  })

  it('the wrong network offers the switch, named', async () => {
    const t = setup({ connection: 'wrongNetwork' })
    expect(t.button().textContent).toBe('Switch to Arc Testnet')
    await t.user.click(t.button())
    expect(t.onSwitch).toHaveBeenCalledTimes(1)
  })

  it('NO PLAN IS EVEN BUILT without a recipient', async () => {
    // A plan with a placeholder recipient is a plan that could be submitted;
    // `ZeroRecipient()` would be the router refusing what this component should
    // never have constructed.
    const t = setup({ connection: 'disconnected', recipient: null })
    await t.user.type(t.field(), '1')
    expect(t.q.queryByTestId('pool-quote')).toBeNull()
  })

  it('the quote asset is the ERC-20 view of USDC, not a second token', async () => {
    const t = setup()
    await t.user.type(t.field(), '1')
    await t.user.click(t.button())
    const plan = t.onSubmit.mock.calls[0]?.[0] as PoolPlan
    expect(plan.approval.token).toBe(USDC_ERC20_ADDRESS)
  })
})
