'use client'

import { formatTokenAmount, formatUsdcAmount, USDC_ERC20_ADDRESS } from '@arcpad/shared/browser'
import { useCallback, useMemo, useState } from 'react'
import { encodeFunctionData } from 'viem'
import type { HexAddress } from '@/components/read/types'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Money } from '@/components/ui/Money'
import { Tabs } from '@/components/ui/Tabs'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { useChainNow } from '@/hooks/useChainNow'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { getWebConfig } from '@/lib/addresses'
import { decodePoolSwapError, type PoolFailure } from '@/lib/poolOutcome'
import { quoteWeiFromUnits } from '@/lib/quoteUnits'
import { ARCPAD_ROUTER_ABI } from '@/lib/routerAbi'
import { AmountInput } from './AmountInput'
import { ApproveStep } from './ApproveStep'
import { spendableFrom } from './gas'
import { SpendableMaxButton } from './SpendableMaxButton'
import { useGasReserve } from './useGasReserve'
import {
  buildPoolPlan,
  CLOCK_SKEW_WARN_SECONDS,
  clockSkewSeconds,
  isPoolBuyTab,
  POOL_BOUND_LABEL,
  POOL_DEADLINE_TTL_SECONDS,
  POOL_DEFAULT_TAB,
  POOL_TAB_LABEL,
  POOL_TABS,
  poolButtonFor,
  poolDeadline,
  poolQuoteRequest,
  type PoolPlan,
  type PoolTab,
  residualAllowance,
} from './poolPlan'
import { DEFAULT_SLIP_BPS, SlippageRow } from './SlippageRow'
import { parseAmount, type ApprovalState, type TradePhase } from './tradeModel'
import { useApproval } from './useApproval'
import { usePoolQuote, type PoolQuoteState } from './usePoolQuote'
import { usePoolTrade, type RealisedPoolSwap } from './usePoolTrade'
import { useTokenBalance } from './useTokenBalance'

/**
 * ==========================================================================
 *  POST-GRADUATION TRADING. THE SECOND VENUE, AND THE FIRST WITH APPROVALS.
 * ==========================================================================
 *
 * THREE THINGS ARE GENUINELY DIFFERENT FROM THE CURVE PANEL, and each one is a
 * place a user can lose money if it is presented as if it were the same:
 *
 * 1. **THE BUY LEG NOW NEEDS AN APPROVAL.** The curve took `msg.value`; the
 *    router pulls funds with `transferFrom`. So a BUY is two transactions --
 *    approve USDC, then swap. The curve panel taught "sell is two steps, buy is
 *    one"; here both are two, and hiding the second behind one button would open
 *    a wallet dialog the user did not ask for. An unexpected signature request
 *    is the thing people learn to reject.
 *
 * 2. **THE AMOUNT APPROVED IS THE BOUND, NOT THE QUOTE.** On `Receive tokens`
 *    the router pulls whatever the swap actually costs and only THEN compares it
 *    against `maxQuoteIn`. An allowance sized to the quote fails precisely when
 *    the price moved -- the case the slippage tolerance exists to survive. So
 *    the approval is `maxQuoteIn`, the leftover authority is real, and
 *    `<ApproveStep residual>` says so out loud rather than quietly breaking the
 *    "approve exactly what you spend" promise the curve panel made.
 *
 * 3. **THE QUOTE IS A CHAIN READ, NOT ARITHMETIC.** There is no pool formula in
 *    this repository and there must not be: the pool fee is zero and
 *    `ArcpadHook` takes its cut through return deltas, so any re-derivation is
 *    wrong by the fee. `usePoolQuote` calls `ArcpadRouter.quote*`, which runs
 *    the real swap through the real hook and reverts with the answer.
 *
 * AND ONE THING IS THE SAME ON PURPOSE: the tabs, their order, their default,
 * the slippage control, the button ladder and the two-step approve list. A user
 * who learned the curve panel has learned this one.
 *
 * ============ TODAY THIS PANEL IS UNREACHABLE IN PRODUCTION ============
 *
 * No token has graduated on any chain -- the production factory's
 * `graduationTarget` is `0x0` deliberately, and the first graduation window
 * opens 2026-08-11T23:01:51Z. MEASURED 2026-08-09 against the live router:
 * `quoteBuyExactIn` on BOTH production tokens answers `PoolNotInitialized()`
 * (`0x486aa307`). So `lifecycle.kind === 'graduated'` is false everywhere and
 * `<TradeSurface>` draws the curve panel instead. The pool panel's own "no pool
 * yet" branch is the one state that IS reachable today, and it is the one the
 * live probe exercises.
 */

/** `useApproval` needs the launch token's ABI shape; USDC answers the same two selectors. */
const QUOTE_ASSET = USDC_ERC20_ADDRESS as HexAddress

/**
 * ============ WHICH FAILURE THE PANEL SHOWS. A FAILED APPROVAL WAS SILENT. ============
 *
 * `TradePanel` (the curve) renders `trade.failure ?? approval.failure`. This
 * panel rendered `trade.failure` ALONE, so an approval that failed -- rejected
 * in the wallet, out of gas, refused by USDC's blocklist -- put nothing on
 * screen at all: the button simply went back to "Approve" and the user was left
 * to guess what had happened. That is this repository's number-one failure mode
 * with a PANEL standing in for an entrypoint -- the property was covered on the
 * curve and read as covered on the pool.
 *
 * It matters most on the leg that is new here. The curve only ever approves on
 * a SELL; a pool BUY approves USDC, and USDC on Arc is a Circle FiatToken with
 * refusals of its own (`0x1800…0001.isBlocklisted`, `whenNotPaused`) that the
 * curve's approve leg cannot produce at all.
 *
 * DECODED WITH THE POOL'S OWN DICTIONARY, not carried over from the curve's.
 * `useApproval` decodes with `decodeArcpadError` because the curve owns that
 * hook; `lib/poolOutcome.ts` exists precisely so a user does not learn one
 * vocabulary for a curve trade and another for a pool trade, and the branch
 * order of the two decoders is identical on purpose. So the RAW error is
 * re-decoded here. A name this surface has no text for still lands on the LOUD
 * "no text for this" branch, which is this repository's rule and strictly better
 * than the silence it replaces.
 *
 * THE SWAP'S FAILURE WINS when both exist: it is the later and more specific
 * event, and it is the one the user was waiting on.
 *
 * EXPORTED AND PURE so the precedence and the decoding are RUN by a test rather
 * than read out of a component that needs wagmi to mount.
 */
export function poolPanelFailure(
  tradeFailure: PoolFailure | null,
  approvalError: unknown,
): PoolFailure | null {
  if (tradeFailure !== null) return tradeFailure
  if (approvalError === null || approvalError === undefined) return null
  return decodePoolSwapError(approvalError)
}

export const POOL_GAS_NEEDS_APPROVAL =
  'Gas cannot be estimated until the router is approved: the estimate runs the real swap, and ' +
  'without an allowance that call reverts. Approve first and the shortcuts come back.'

export type PoolTradeFormProps = {
  readonly symbol: string
  readonly connection: 'disconnected' | 'wrongNetwork' | 'connected'
  readonly chainName: string
  readonly token: HexAddress
  /** Raw USDC balance, 18-decimal native view -- the ONE figure on screen. */
  readonly usdcBalance: bigint
  /** Gas-reserved USDC. `null` -> not measurable; the shortcuts go dark. */
  readonly spendable: bigint | null
  readonly gasReason: string | null
  readonly tokenBalance: bigint | null
  readonly quote: PoolQuoteState
  readonly approval: ApprovalState
  readonly approvalPhase: TradePhase
  readonly phase: TradePhase
  readonly hash?: `0x${string}` | undefined
  readonly failure: PoolFailure | null
  readonly realised: RealisedPoolSwap | null
  readonly explorerUrl?: string | undefined
  readonly routerMissing: boolean
  /** Head block timestamp, seconds. `null` -> not read yet. */
  readonly chainNowSeconds: bigint | null
  readonly nowMs?: number
  /**
   * WHERE THE OUTPUT GOES. `null` while no wallet is connected -- and then NO
   * PLAN IS BUILT AT ALL. A plan with a placeholder recipient is a plan that
   * could be submitted; `ZeroRecipient()` would be the router refusing what
   * this component should never have constructed.
   */
  readonly recipient: HexAddress | null
  readonly onConnect?: (() => void) | undefined
  readonly onSwitch?: (() => void) | undefined
  readonly onApprove?: (() => void) | undefined
  readonly onSubmit?: ((plan: PoolPlan) => void) | undefined
  /**
   * THE RAW REQUEST GOES UP, NOT JUST THE PLAN, AND THAT ORDER IS FORCED.
   *
   * The plan needs the quote and the quote needs the amount. Reporting only the
   * plan would mean no plan -> no request -> no quote -> no plan: a deadlock at
   * the first keystroke, which is exactly what the first draft of this file did.
   */
  readonly onRequest?: ((request: PoolFormRequest) => void) | undefined
  readonly initialTab?: PoolTab
}

export type PoolFormRequest = {
  readonly tab: PoolTab
  /** `spend`: native wei. `receive`/`sell`: token wei. `null` -> empty field. */
  readonly amount: bigint | null
  readonly plan: PoolPlan | null
}

export function PoolTradeForm({
  symbol,
  connection,
  chainName,
  token,
  usdcBalance,
  spendable,
  gasReason,
  tokenBalance,
  quote,
  approval,
  approvalPhase,
  phase,
  hash,
  failure,
  realised,
  explorerUrl,
  routerMissing,
  chainNowSeconds,
  nowMs,
  recipient,
  onConnect,
  onSwitch,
  onApprove,
  onSubmit,
  onRequest,
  initialTab = POOL_DEFAULT_TAB,
}: PoolTradeFormProps) {
  const [tab, setTab] = useState<PoolTab>(initialTab)
  const [text, setText] = useState('')
  const [slipBps, setSlipBps] = useState(DEFAULT_SLIP_BPS)
  // "Auto" yalnizca bir rozet: bu degeri kullanicinin SECMEDIGINI soyler.
  const [slipAuto, setSlipAuto] = useState(true)

  const parsed = parseAmount(text)
  const amount = parsed.ok ? parsed.value : null
  const at = nowMs ?? Date.now()
  const deadline = poolDeadline(chainNowSeconds, at)
  const skew = clockSkewSeconds(chainNowSeconds, at)

  const plan =
    amount === null || amount === 0n || quote.kind !== 'ok' || recipient === null
      ? null
      : buildPoolPlan({
          tab,
          token,
          tokenSymbol: symbol,
          quoteAsset: QUOTE_ASSET,
          amount,
          // THE QUOTED LEG IS THE ONE THE USER DID NOT TYPE. On `receive` the
          // user typed the OUTPUT, so the answer is `amountIn`; on the other
          // two they typed the INPUT and the answer is `amountOut`. Reading the
          // same field on all three would show a token count as a USDC price on
          // one tab out of three -- and that tab's own test is the only thing
          // that would notice.
          quoted: tab === 'receive' ? quote.amountIn : quote.amountOut,
          slipBps,
          recipient,
          deadline,
        })

  const button = poolButtonFor({
    connection,
    chainName,
    symbol,
    tab,
    amount,
    plan,
    available: isPoolBuyTab(tab) ? usdcBalance : tokenBalance,
    approval,
    phase,
    quoteFailure:
      quote.kind === 'failed' ? { title: quote.failure.title, code: quote.failure.code } : null,
    routerMissing,
  })

  const press = useCallback(() => {
    switch (button.intent) {
      case 'connect':
        onConnect?.()
        return
      case 'switch':
        onSwitch?.()
        return
      case 'approve':
        onApprove?.()
        return
      case 'ready':
        if (plan !== null) onSubmit?.(plan)
        return
      default:
        return
    }
  }, [button.intent, onApprove, onConnect, onSubmit, onSwitch, plan])

  // Reported UP so the quote, the approval and the write hooks all see the same
  // request. Compared through a KEY: a fresh object every render would spin an
  // effect forever -- the trap `TradePanel` records. The key carries the AMOUNT
  // as well as the plan, so a keystroke reaches the quoter even while no plan
  // can be built yet.
  const requestKey = `${tab}|${amount ?? ''}|${plan === null ? 'none' : plan.args.join(',')}`
  useRequestReport(requestKey, { tab, amount, plan }, onRequest)

  const unit = tab === 'spend' ? 'USDC' : symbol
  const label =
    tab === 'spend' ? 'Amount to spend' : tab === 'receive' ? 'Tokens to buy' : 'Tokens to sell'

  if (routerMissing) {
    return (
      <Card className="flex flex-col gap-2 px-4 py-4" data-testid="pool-panel">
        <p className="font-serif text-lg leading-tight">Pool trading is not configured.</p>
        <p className="text-[12px] leading-relaxed text-muted" data-testid="pool-no-router">
          This build was not given a router address, and a Uniswap v4 pool has no entrypoint an
          ordinary wallet can call — the router IS the entrypoint. Nothing is wrong with the pool or
          with your funds; this site simply cannot reach it.
        </p>
      </Card>
    )
  }

  return (
    <Card className="flex flex-col gap-3 px-4 py-4" data-testid="pool-panel">
      <Tabs
        items={POOL_TABS.map((id) => ({ id, label: POOL_TAB_LABEL[id] }))}
        value={tab}
        onChange={(next) => {
          setTab(next as PoolTab)
          // The unit changes with the tab; leaving the old TEXT turns "1.5"
          // USDC into 1.5 TOKENS without the user noticing.
          setText('')
        }}
        label="Pool trade action"
        idBase="pool-trade"
      />

      <p className="text-[12px] leading-snug text-muted" data-testid="pool-venue-note">
        This token has graduated, so trading happens in its Uniswap v4 pool. Every swap here moves
        your funds with <span className="font-medium">transferFrom</span>, so each leg needs an
        approval first — buys included.
      </p>

      <div
        role="tabpanel"
        id={`pool-trade-panel-${tab}`}
        aria-labelledby={`pool-trade-tab-${tab}`}
        className="flex flex-col gap-3"
      >
        <AmountInput
          label={label}
          unit={unit}
          value={text}
          onChange={setText}
          {...(parsed.ok || parsed.reason === null ? {} : { error: parsed.reason })}
        />

        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] text-muted">
            Balance <Money native={usdcBalance} rounding="down" unit />
            {tokenBalance !== null && tab !== 'spend' ? (
              <span className="ml-2 tabular-nums">
                · {formatTokenAmount(tokenBalance)} {symbol}
              </span>
            ) : null}
          </p>
          <SpendableMaxButton
            spendable={tab === 'sell' ? tokenBalance : spendable}
            reason={gasReason}
            onPick={(picked) =>
              setText(
                /*
                 * `rounding: 'down'` IS THE QUANTISATION, and a second one was
                 * measured to be dead. This line called `quantiseToInput(picked)`
                 * first; `formatUsdcAmount(_, { rounding: 'down' })` already
                 * truncates to six decimals, so a mutant deleting the extra call
                 * changed nothing and SURVIVED -- a step that reads as a
                 * safeguard while doing nothing is worse than its absence,
                 * because the next reader trusts it. The direction is the
                 * load-bearing part: rounding UP would overshoot `spendable` by
                 * a micro-USDC and eat exactly the gas reserve.
                 */
                tab === 'spend'
                  ? formatUsdcAmount(picked, { rounding: 'down' }).replace(/,/g, '')
                  : formatTokenAmount(picked).replace(/,/g, ''),
              )
            }
          />
        </div>

        {/*
          THE GAS RESERVE IS NOT SILENT. On Arc gas is paid in the very asset
          being spent, so MAX must be smaller than the balance -- and a MAX that
          is smaller than the balance without saying why reads as a bug.
        */}
        {isPoolBuyTab(tab) && spendable !== null && spendable < usdcBalance ? (
          <p className="text-[12px] text-muted" data-testid="pool-gas-reserve-note">
            MAX leaves <Money native={usdcBalance - spendable} rounding="up" unit /> for gas. On Arc
            the gas asset is USDC too.
          </p>
        ) : null}

        <SlippageRow
          value={slipBps}
          auto={slipAuto}
          onChange={(bps, auto) => {
            setSlipBps(bps)
            setSlipAuto(auto)
          }}
        />

        <PoolQuoteLine quote={quote} tab={tab} plan={plan} symbol={symbol} />

        {plan !== null ? (
          <ApproveStep
            symbol={plan.approval.symbol}
            amountTok={plan.approval.amount}
            decimals={plan.approval.decimals}
            actionLabel={isPoolBuyTab(tab) ? 'Swap' : 'Sell'}
            residual={residualAllowance(plan)}
            approval={approval}
            phase={approvalPhase}
          />
        ) : null}

        {/*
          THE DEADLINE IS NOT A CONTROL, AND THE NUMBER IS SHOWN ANYWAY.
          A user cannot choose it -- the only correct value on a chain with
          sub-second inclusion is "long enough for a human", and offering a
          field invites a value that makes every swap fail. But a guard the user
          cannot see is a guard they will blame the site for.
        */}
        <p className="text-[12px] text-muted" data-testid="pool-deadline-note">
          This swap expires {String(POOL_DEADLINE_TTL_SECONDS / 60n)} minutes after you sign it,
          measured by the chain&rsquo;s clock.
        </p>
        {skew !== null && (skew > CLOCK_SKEW_WARN_SECONDS || -skew > CLOCK_SKEW_WARN_SECONDS) ? (
          <p role="status" className="text-[12px] text-negative" data-testid="pool-clock-skew">
            Your computer&rsquo;s clock is {String(skew < 0n ? -skew : skew)} seconds{' '}
            {skew > 0n ? 'ahead of' : 'behind'} the chain. The deadline follows the chain, so this
            does not break your swap — but it is worth fixing.
          </p>
        ) : null}

        <Button
          variant="primary"
          size="lg"
          disabled={button.disabled}
          onClick={press}
          data-testid="pool-submit"
        >
          {button.label}
        </Button>

        {phase === 'pending' && hash !== undefined ? (
          <p role="status" className="text-[12px] text-muted" data-testid="pool-tx-pending">
            Submitted.{' '}
            {explorerUrl === undefined ? (
              <span className="tabular-nums">{hash}</span>
            ) : (
              <a className="underline" href={`${explorerUrl}/tx/${hash}`} rel="noreferrer">
                View on the explorer
              </a>
            )}
          </p>
        ) : null}

        {realised !== null ? <PoolRealised realised={realised} symbol={symbol} /> : null}

        {failure !== null ? <PoolFailureNotice failure={failure} /> : null}
      </div>
    </Card>
  )
}

/**
 * The quote line. `PoolNotInitialized` gets its OWN sentence rather than the
 * generic failure box, because it is not a failure -- it is the state of every
 * token on this chain today.
 */
function PoolQuoteLine({
  quote,
  tab,
  plan,
  symbol,
}: {
  quote: PoolQuoteState
  tab: PoolTab
  plan: PoolPlan | null
  symbol: string
}) {
  if (quote.kind === 'idle') return null
  if (quote.kind === 'loading') {
    return (
      <p className="text-[12px] text-muted" data-testid="pool-quote-loading">
        Reading the pool&hellip;
      </p>
    )
  }
  if (quote.kind === 'failed') {
    return (
      <p
        role={quote.failure.tone === 'error' ? 'alert' : 'status'}
        className={`text-[12px] leading-snug ${quote.failure.tone === 'error' ? 'text-negative' : 'text-muted'}`}
        data-testid={quote.failure.code === 'no-pool' ? 'pool-absent' : 'pool-quote-failed'}
      >
        <span className="font-medium">{quote.failure.title}</span> {quote.failure.body}
      </p>
    )
  }
  if (plan === null) return null

  const receiveText =
    tab === 'spend'
      ? `${formatTokenAmount(plan.amountOut)} ${symbol}`
      : tab === 'receive'
        ? `${formatUsdcAmount(quoteWeiFromUnits(plan.amountIn), { rounding: 'up' })} USDC`
        : `${formatUsdcAmount(quoteWeiFromUnits(plan.amountOut), { rounding: 'down' })} USDC`

  const boundText =
    plan.boundKind === 'minOut'
      ? tab === 'spend'
        ? `${formatTokenAmount(plan.bound)} ${symbol}`
        : `${formatUsdcAmount(quoteWeiFromUnits(plan.bound), { rounding: 'down' })} USDC`
      : `${formatUsdcAmount(quoteWeiFromUnits(plan.bound), { rounding: 'up' })} USDC`

  return (
    <dl className="flex flex-col gap-1 text-[12px]" data-testid="pool-quote">
      <div className="flex items-baseline justify-between gap-2">
        <dt className="text-muted">{tab === 'receive' ? 'You spend' : 'You receive'}</dt>
        <dd className="tabular-nums" data-testid="pool-quote-amount">
          {receiveText}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <dt className="text-muted">{POOL_BOUND_LABEL[tab]}</dt>
        <dd className="tabular-nums" data-testid="pool-quote-bound">
          {boundText}
        </dd>
      </div>
      {/*
        THE FEE IS NOT A SEPARATE LINE, AND ITS ABSENCE IS THE DESIGN.
        `ArcpadHook` takes its cut inside the swap and `PoolManager.swap`
        returns the delta ALREADY NET OF IT, so the two numbers above are what
        the wallet actually pays and receives. A "fee" row here would have to be
        a SECOND implementation of a rule that already ran on chain, and this
        repository has measured what happens when a fee is recomputed off the
        wrong principal.
      */}
      <p className="text-[11px] text-muted" data-testid="pool-fee-note">
        Quoted through the pool&rsquo;s own hook, so the fee is already taken out of these numbers.
      </p>
    </dl>
  )
}

function PoolRealised({ realised, symbol }: { realised: RealisedPoolSwap; symbol: string }) {
  return (
    <div role="status" className="text-[12px] leading-snug" data-testid="pool-tx-confirmed">
      <p className="font-medium text-positive">
        {realised.buy ? 'Bought' : 'Sold'}{' '}
        <span className="tabular-nums" data-testid="pool-realised-tokens">
          {formatTokenAmount(realised.tokensTok)} {symbol}
        </span>{' '}
        for{' '}
        <span data-testid="pool-realised-usdc">
          <Money native={realised.quoteWei} rounding={realised.buy ? 'up' : 'down'} unit />
        </span>
      </p>
    </div>
  )
}

function PoolFailureNotice({ failure }: { failure: PoolFailure }) {
  return (
    <div
      role={failure.tone === 'error' ? 'alert' : 'status'}
      className={`text-[12px] leading-relaxed ${failure.tone === 'error' ? 'text-negative' : 'text-muted'}`}
      data-testid="pool-failure"
    >
      <p className="font-medium">{failure.title}</p>
      <p>{failure.body}</p>
      <p>{failure.remedy}</p>
      {failure.showRaw ? (
        <p className="mt-1 break-all font-mono text-[11px]" data-testid="pool-failure-raw">
          {String(failure.name)}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Reports the request upward exactly once per distinct request.
 *
 * Render-phase `setState` on the SAME component is React's own supported way to
 * derive state from props, and it is used instead of an effect because an
 * effect would report one render LATE -- the quote would always lag the field
 * by a keystroke.
 */
function useRequestReport(
  key: string,
  request: PoolFormRequest,
  onRequest: ((request: PoolFormRequest) => void) | undefined,
) {
  const [last, setLast] = useState<string | null>(null)
  if (last !== key) {
    setLast(key)
    onRequest?.(request)
  }
}

// --------------------------------------------------------------------------
// Connected panel
// --------------------------------------------------------------------------

export type PoolTradePanelProps = {
  readonly token: HexAddress
  readonly symbol: string
}

export function PoolTradePanel({ token, symbol }: PoolTradePanelProps) {
  const network = useArcNetwork()
  const balance = useUsdcBalance()
  const account = network.address as HexAddress | undefined
  const config = getWebConfig()
  const router = (config.addresses.arcpadRouter ?? null) as HexAddress | null

  const [report, setReport] = useState<PoolFormRequest>({
    tab: POOL_DEFAULT_TAB,
    amount: null,
    plan: null,
  })

  const tokenBalance = useTokenBalance(token, account)
  const chainNow = useChainNow(router !== null)

  // THE QUOTE IS DRIVEN BY THE FIELD, NOT BY THE PLAN -- a plan needs a quote,
  // so deriving the request from the plan deadlocks at the first keystroke.
  const request = useMemo(
    () => poolQuoteRequest({ tab: report.tab, token, amount: report.amount }),
    [report.tab, report.amount, token],
  )
  const quote = usePoolQuote(router, request)

  // ONE APPROVAL HOOK, TWO ASSETS. The spender is always the router; the token
  // and the amount come from the plan, which is the only thing that knows which
  // leg is being paid.
  const approval = useApproval(
    report.plan?.approval.token as HexAddress | undefined,
    router ?? undefined,
    account,
    report.plan?.approval.amount ?? null,
  )

  /**
   * A POOL SWAP CANNOT BE GAS-ESTIMATED BEFORE IT IS APPROVED, AND THE PANEL
   * SAYS SO RATHER THAN GUESSING.
   *
   * `eth_estimateGas` runs the real call. Without an allowance that call
   * reverts inside `transferFrom`, so no estimate exists -- this is not a
   * limitation of the RPC, it is what "estimate the transaction you are about
   * to send" means when the transaction pulls funds. The curve never met it:
   * its buys are `payable` and need no allowance.
   *
   * So MAX goes dark WITH A REASON, exactly as `SpendableMaxButton` was built
   * for. The alternative -- reserving a made-up constant -- is trying an
   * unmeasured number on the user's money, which `gas.ts` refuses by design.
   */
  const gasRequest =
    report.plan === null ||
    account === undefined ||
    router === null ||
    approval.state !== 'sufficient'
      ? null
      : {
          to: router,
          data: encodeFunctionData({
            abi: ARCPAD_ROUTER_ABI,
            functionName: report.plan.action,
            args: report.plan.args as never,
          }),
          value: 0n,
          account,
        }
  const gas = useGasReserve(gasRequest)
  const gasReason =
    gasRequest === null && report.plan !== null && approval.state !== 'sufficient'
      ? POOL_GAS_NEEDS_APPROVAL
      : gas.reason

  const trade = usePoolTrade(router)

  /**
   * ============ A FAILED APPROVAL WAS SILENT ON THIS PANEL. ============
   *
   * `TradePanel` (the curve) renders `trade.failure ?? approval.failure`. This
   * panel rendered `trade.failure` alone, so an approval that FAILED -- rejected
   * in the wallet, out of gas, refused by USDC's blocklist -- put nothing on
   * screen at all: the button simply went back to "Approve" and the user was
   * left to guess. That is this repository's number-one failure mode with a
   * PANEL standing in for an entrypoint: the property was covered on the curve
   * and read as covered on the pool.
   *
   * It matters most on the leg that is new here. The curve only ever approves on
   * a SELL; a pool BUY approves USDC, and USDC on Arc is a Circle FiatToken with
   * refusals of its own (`0x1800…0001.isBlocklisted`, `whenNotPaused`) that the
   * curve's approve leg cannot produce.
   *
   * DECODED WITH THE POOL'S OWN DICTIONARY, not carried over from the curve's.
   * `useApproval` decodes with `decodeArcpadError` because the curve owns that
   * hook; `lib/poolOutcome.ts` exists precisely so a user does not learn one
   * vocabulary for a curve trade and another for a pool trade, and the branch
   * order of the two decoders is identical on purpose. So the RAW error is
   * re-decoded here. A name this surface has no text for still lands on the
   * LOUD "no text for this" branch, which is the repository's rule and strictly
   * better than the silence it replaces.
   *
   * THE SWAP'S FAILURE WINS when both exist: it is the later, more specific
   * event, and it is the one the user was waiting on.
   */
  const connection = network.wrongNetwork
    ? ('wrongNetwork' as const)
    : network.status === 'connected'
      ? ('connected' as const)
      : ('disconnected' as const)

  return (
    <PoolTradeForm
      symbol={symbol}
      connection={connection}
      chainName={config.chain.name}
      token={token}
      usdcBalance={balance.native.wei}
      spendable={spendableFrom(balance.native.wei, gas.reserve)}
      gasReason={gasReason}
      tokenBalance={tokenBalance}
      quote={quote.state}
      approval={approval.state}
      approvalPhase={approval.phase}
      phase={trade.phase}
      hash={trade.hash}
      failure={poolPanelFailure(trade.failure, approval.error)}
      realised={trade.realised}
      explorerUrl={config.chain.blockExplorers.default.url}
      routerMissing={router === null}
      chainNowSeconds={chainNow.seconds}
      recipient={account ?? null}
      onConnect={() => {
        document.querySelector<HTMLElement>('[data-wallet-connect]')?.click()
      }}
      onSwitch={network.switchToArc}
      onApprove={approval.approve}
      onSubmit={trade.submit}
      onRequest={setReport}
    />
  )
}
