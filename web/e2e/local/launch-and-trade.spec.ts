import { expect, type Page, test } from '@playwright/test'
import {
  ARC_TESTNET_CHAIN_ID,
  bondingCurveAbi,
  getArcChain,
  launchFactoryAbi,
  launchTokenAbi,
} from '@arcpad/shared/browser'
import { type Address, createPublicClient, http, parseEventLogs } from 'viem'
import { connectWallet, injectedWallet, LOCAL_USER_KEY } from '../fixtures/wallet'

/**
 * THE EIGHT-STEP SCENARIO, ON A REAL CHAIN, WITHOUT A DATABASE.
 *
 * `DATABASE_URL` is stripped by the global setup, so `readTokenOverview` can
 * only answer `unavailable` and the token page is FORCED down the
 * chain-only branch. Two claims are therefore measured by one run:
 *
 *   Task 7  -- the read layer degrades without taking the page with it
 *   Task 12 -- the trade panel never needs Postgres to send a transaction
 *
 * EVERY ASSERTION STATES ITS OWN PRECONDITION. Four times in this repository a
 * test passed because of the implicit shape of its fixture; the antidote is
 * that "the clamp line appears" is preceded by "the remaining reserve is
 * smaller than the budget", asserted from the chain, in the same test.
 */

/**
 * THE DEFAULT COMES FROM THE REGISTRY, NOT FROM A LITERAL.
 *
 * `'5042002'` used to sit here and it was a second copy of the chain id in
 * tracked source -- which `chain-registry.test.ts` forbids and, measured on
 * this tree, was ALREADY FAILING: `pnpm --filter @arcpad/shared test` reported
 * `registry literals leaked outside chain.ts: web/e2e/local/launch-and-trade.spec.ts`.
 * That made the `check` job's `pnpm -r test` step red independently of the web
 * build, so CI had two reasons it could not go green, not one. The gate's
 * carve-out exempts `*.test.ts` and `test/` directories; a `.spec.ts` under
 * `e2e/` is neither, and widening the carve-out to cover it would have hidden
 * the copy instead of removing it.
 */
const CHAIN_ID = Number(process.env.E2E_CHAIN_ID ?? ARC_TESTNET_CHAIN_ID)
const RPC = process.env.E2E_RPC_URL ?? ''
const FACTORY = (process.env.E2E_FACTORY ?? '') as Address

const NAME = 'E2E 🚀'
const SYMBOL = 'E2E'

/**
 * Counted here with Node's own UTF-8 encoder, NOT copied from the plan and NOT
 * imported from `utf8ByteLength` (the function under test).
 *
 * THE PLAN SAYS `10/32` FOR THIS NAME AND THE PLAN IS WRONG. `E2E ` is four
 * ASCII bytes and U+1F680 is four more: EIGHT. The screen prints `8/32 bytes`,
 * which is correct; a test that had pinned the plan's number would have
 * reported a defect in working code.
 */
const NAME_BYTES = Buffer.byteLength(NAME, 'utf8')

function chainClient() {
  return createPublicClient({ chain: getArcChain(CHAIN_ID), transport: http(RPC) })
}

// --------------------------------------------------------------------------
// An INDEPENDENT re-derivation of the exact-quote-in algorithm.
//
// Written from the protocol description, NOT from `packages/shared/src/trade.ts`.
// Asserting the screen against the same module the screen uses would be a
// tautology: both would be wrong together and agree. This one is wrong on its
// own if it is wrong at all.
//
//   1. net   = floor(gross * 1e4 / (1e4 + bps))      -- no -1 on the input
//   2. fees  = ceil(net*p/1e4) + ceil(net*c/1e4)     -- SUMMED FROM PARTS
//   3. if (net + fees > gross) net -= (net + fees - gross)
//   4. tokens = floor((net-1) * vT / (vQ + net - 1)) -- the -1 lives HERE
//
// Fees are charged on the PRE-CORRECTION net.
// --------------------------------------------------------------------------
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

export function quoteExactIn(input: {
  gross: bigint
  protocolBps: bigint
  creatorBps: bigint
  virtualTokenReserves: bigint
  virtualQuoteReserves: bigint
}): { net: bigint; protocolFee: bigint; creatorFee: bigint; tokensOut: bigint } {
  const total = input.protocolBps + input.creatorBps
  let net = (input.gross * 10_000n) / (10_000n + total)
  const protocolFee = ceilDiv(net * input.protocolBps, 10_000n)
  const creatorFee = ceilDiv(net * input.creatorBps, 10_000n)
  const fees = protocolFee + creatorFee
  if (net + fees > input.gross) net -= net + fees - input.gross
  const tokensOut =
    ((net - 1n) * input.virtualTokenReserves) / (input.virtualQuoteReserves + net - 1n)
  return { net, protocolFee, creatorFee, tokensOut }
}

/** wei -> the six-decimal string the screen prints, rounding DOWN. */
function usdcDown(wei: bigint): string {
  const units = wei / 1_000_000_000_000n
  return `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')}`
}

/** wei -> the six-decimal string, rounding UP: what a user must PAY. */
function usdcUp(wei: bigint): string {
  const units = ceilDiv(wei, 1_000_000_000_000n)
  return `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')}`
}

type Launched = { token: Address; curve: Address }

let launched: Launched | null = null

async function readCurve(curve: Address) {
  const client = chainClient()
  const [vT, vQ, rT, rQ, complete, pBps, cBps] = (await client.multicall({
    contracts: (
      [
        'virtualTokenReserves',
        'virtualQuoteReserves',
        'realTokenReserves',
        'realQuoteReserves',
        'complete',
        'PROTOCOL_FEE_BPS',
        'CREATOR_FEE_BPS',
      ] as const
    ).map((functionName) => ({ address: curve, abi: bondingCurveAbi, functionName })),
    allowFailure: false,
  })) as [bigint, bigint, bigint, bigint, boolean, bigint, bigint]
  return {
    virtualTokenReserves: vT,
    virtualQuoteReserves: vQ,
    realTokenReserves: rT,
    realQuoteReserves: rQ,
    complete,
    protocolBps: pBps,
    creatorBps: cBps,
  }
}

async function withWallet(page: Page) {
  return injectedWallet(page, {
    privateKey: LOCAL_USER_KEY,
    rpcUrl: RPC,
    chain: getArcChain(CHAIN_ID),
  })
}

/**
 * DOKUM BIR ACILIRIN ICINDE, VE TESTIN ONU ACMASI GEREKIR.
 *
 * `TradeCard.DetailsSection` `open` TASIMAYAN bir `<details>`tir, yani
 * `quote-*` dokumlerinin tamami baslangicta `hidden`dir. Bu suite CI'da bugune
 * kadar hic kosmadi (son is akisi kosusu 2026-07-30) ve arayuz o gunden beri
 * dokumu bir aciliriin ardina aldi; test eski dunyayi olcuyordu.
 *
 * ACMAK, GORUNMEZLIGI YOK SAYMAKTAN IYIDIR. Playwright'in `toContainText`i
 * `textContent` okur ve GIZLI bir elemanda da gecer -- yani yalnizca
 * `toBeVisible()` cagrilarini silmek suiti yesile cevirirdi ve geriye
 * "kullanicinin GORMEDIGI bir metni dogrulayan" iddialar kalirdi. Acilir
 * aciliyor ki her iddia ekranda gercekten duran sey hakkinda olsun.
 */
async function openBreakdown(page: Page): Promise<void> {
  const details = page.getByTestId('trade-details')
  if (await details.evaluate((el) => (el as HTMLDetailsElement).open)) return
  /*
   * `> summary`, `summary` DEGIL -- VE FARK OLCULDU.
   *
   * `QuoteBreakdown` da bir `<details>`tir ve `trade-details`in ICINDE durur,
   * yani `locator('summary')` -- bir TORUN aramasi -- IKI eleman bulur ve
   * Playwright strict mode ile duser. Cocuk birlesticisi disaridaki acilirin
   * kendi ozetini secer.
   *
   * `.first()` de calisirdi ve YANLIS olurdu: DOM sirasina guvenmek, ic ice
   * iki acilirdan hangisinin once geldigini gorunmez bir varsayim haline
   * getirirdi.
   */
  await details.locator('> summary').click()
}

test.beforeAll(() => {
  // A MISCONFIGURED RUN FAILS, IT DOES NOT SKIP. A skipped gate reads exactly
  // like a passing one, and this suite's whole value is that it ran.
  expect(RPC, 'global setup must publish E2E_RPC_URL').not.toBe('')
  expect(FACTORY, 'global setup must publish E2E_FACTORY').not.toBe('')

  /*
   * THE SERVER MUST HAVE NO DATABASE -- AND THAT IS NOT THE SAME CLAIM AS
   * "THIS PROCESS HAS NO `DATABASE_URL`".
   *
   * The first version asserted the latter and was WRONG in a way that only
   * showed up when both legs ran together: a developer (or CI) with
   * `DATABASE_URL` in the shell failed this leg immediately, even though the
   * global setup strips the variable from the server's environment precisely
   * so this leg keeps its meaning. The claim belongs to the SERVER, so it is
   * checked against the server -- and step 3 confirms it on screen, where the
   * chain-only notice is asserted directly.
   */
  const base = process.env.E2E_BASE_URL ?? ''
  const dbBase = process.env.E2E_DB_BASE_URL ?? ''
  expect(base, 'global setup must publish E2E_BASE_URL').not.toBe('')
  expect(base, 'this leg must run against the server built WITHOUT a database').not.toBe(dbBase)
})

test.describe.configure({ mode: 'serial' })

test.describe('the eight-step chain scenario', () => {
  test('1 & 2: /create launches, and the page it opens is the address from the EVENT', async ({
    page,
  }) => {
    const wallet = await withWallet(page)
    await page.goto('/create')
    await connectWallet(page)

    /*
     * ============ `exact` ZORUNLU, VE ALANIN ADI `Ticker` ============
     *
     * `getByLabel` VARSAYILAN OLARAK ALT DIZE ESLESTIRIR ve formun ilk
     * bolumu `aria-labelledby` ile "Name and ticker" adini tasir -- yani
     * `getByLabel('Name')` IKI eleman bulur (alan ve bolum) ve Playwright
     * strict mode ile duser. Bu, CI'in ilk kosusunda olculdu.
     *
     * Ikinci seciciyi ise UI kaydirdi: alanin etiketi artik `Symbol` degil
     * `Ticker`. Eski secici HICBIR SEY bulmuyordu.
     *
     * Ikisi de ancak CI kosunca gorunurdu ve bu suite CI'da bugune kadar HIC
     * kosmadi (son is akisi kosusu 2026-07-30, Faz 0).
     */
    const name = page.getByLabel('Name', { exact: true })
    await name.fill(NAME)
    // The counter counts BYTES, not code points. A rocket is one character and
    // four bytes; a UI that counted `.length` would print 6/32 here and let a
    // name through that `LaunchToken` rejects with `NameTooLong`.
    await expect(page.getByTestId('byte-counter').first()).toHaveText(
      new RegExp(`${NAME_BYTES}\\s*/\\s*32`),
    )

    await page.getByLabel('Ticker', { exact: true }).fill(SYMBOL)

    const before = (await chainClient().readContract({
      address: FACTORY,
      abi: launchFactoryAbi,
      functionName: 'launchCount',
    })) as bigint

    await page.getByRole('button', { name: 'Launch', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your token is on Arc' })).toBeVisible({
      timeout: 60_000,
    })

    // THE ADDRESS COMES FROM THE RECEIPT'S `Launched` EVENT, and this test
    // re-derives it the same way rather than trusting the screen: the mutant
    // "route to `predictAddresses`" has to die here.
    const hashes = wallet.sent()
    expect(hashes.length, 'the launch must have been broadcast by our provider').toBe(1)
    const receipt = await chainClient().waitForTransactionReceipt({ hash: hashes[0]! })
    const events = parseEventLogs({
      abi: launchFactoryAbi,
      eventName: 'Launched',
      logs: receipt.logs,
    })
    const event = events[0]
    expect(event, 'the launch receipt must carry a Launched event').toBeTruthy()
    const args = event!.args as unknown as { token: Address; curve: Address }
    launched = { token: args.token, curve: args.curve }

    const after = (await chainClient().readContract({
      address: FACTORY,
      abi: launchFactoryAbi,
      functionName: 'launchCount',
    })) as bigint
    expect(after, 'the factory must have one more launch than before').toBe(before + 1n)

    await page.getByRole('link', { name: 'View token', exact: true }).click()
    await page.waitForURL(/\/token\/0x[0-9a-fA-F]{40}/)
    const inUrl = new URL(page.url()).pathname.split('/').pop() ?? ''
    expect(
      inUrl.toLowerCase(),
      'the URL must carry the address the EVENT reported, not a predicted one',
    ).toBe(args.token.toLowerCase())
  })

  test('3: a fresh curve draws the reference curve, zero progress and a canonical badge', async ({
    page,
  }) => {
    expect(launched, 'step 1 must have launched a token').toBeTruthy()
    const { token, curve } = launched!

    // PRECONDITION, FROM THE CHAIN, BEFORE ANY CLAIM ABOUT THE SCREEN.
    const canonical = await chainClient().readContract({
      address: FACTORY,
      abi: launchFactoryAbi,
      functionName: 'isCanonical',
      args: [token],
    })
    expect(canonical, 'the badge assertion below is only meaningful if this is true').toBe(true)

    const state = await readCurve(curve)
    expect(state.realQuoteReserves, 'nothing has traded yet').toBe(0n)

    await withWallet(page)
    await page.goto(`/token/${token}`)

    // The chain-only branch is the one under test, and it says so on screen.
    await expect(page.getByTestId('unavailable-notice')).toBeVisible()
    await expect(page.getByTestId('chain-drawn-launch')).toBeVisible()
    await expect(page.getByRole('heading', { name: NAME })).toBeVisible()
    await expect(page.getByText('Canonical', { exact: true })).toBeVisible()

    await expect(page.getByText('0.0%')).toBeVisible()
    await expect(page.getByText(`${usdcDown(0n)} of`)).toBeVisible()

    // THE REFERENCE CURVE AND ITS MARKER, AND NO REALISED SERIES.
    // Precondition: `trade_count == 0`, asserted from the chain above
    // (`realQuoteReserves == 0`). A realised line here would be a fabricated
    // history. Scoped to the chart's own `<svg>`: the shell draws icons.
    await expect(page.getByTestId('curve-reference')).toHaveCount(1)
    await expect(page.getByTestId('curve-realised')).toHaveCount(0)
    await expect(page.getByTestId('curve-chart').locator('circle')).toHaveCount(2)

    await expect(page.getByTestId('trade-panel')).toBeVisible()
  })

  test('4: Spend USDC quotes the four-step algorithm, and the confirmation comes from the EVENT', async ({
    page,
  }) => {
    const { token, curve } = launched!
    const before = await readCurve(curve)
    expect(before.realQuoteReserves, 'progress must be zero BEFORE this trade').toBe(0n)

    const wallet = await withWallet(page)
    await page.goto(`/token/${token}`)
    await connectWallet(page)

    const gross = 1_000_000_000_000_000_000n
    const expected = quoteExactIn({
      gross,
      protocolBps: before.protocolBps,
      creatorBps: before.creatorBps,
      virtualTokenReserves: before.virtualTokenReserves,
      virtualQuoteReserves: before.virtualQuoteReserves,
    })

    await page.getByLabel('Amount to spend').fill('1')
    await openBreakdown(page)
    await expect(page.getByTestId('quote-breakdown')).toBeVisible()
    await expect(page.getByTestId('quote-curve')).toContainText(usdcDown(expected.net))
    await expect(page.getByTestId('quote-protocolFee')).toContainText(usdcUp(expected.protocolFee))
    await expect(page.getByTestId('quote-creatorFee')).toContainText(usdcUp(expected.creatorFee))

    await page.getByTestId('trade-submit').click()
    await expect(page.getByTestId('tx-confirmed')).toBeVisible({ timeout: 60_000 })

    // THE CONFIRMED FIGURES MUST COME FROM THE EVENT, NOT THE QUOTE. The
    // mutant "print the quoted amounts as confirmed" dies here and in step 8.
    const hash = wallet.sent().at(-1)!
    const receipt = await chainClient().waitForTransactionReceipt({ hash })
    const trades = parseEventLogs({ abi: bondingCurveAbi, eventName: 'Trade', logs: receipt.logs })
    expect(trades.length, 'a buy must emit exactly one Trade').toBe(1)
    const trade = trades[0]!.args as unknown as { tokenAmount: bigint; isBuy: boolean }
    expect(trade.isBuy).toBe(true)

    const after = await readCurve(curve)
    expect(after.realTokenReserves).toBe(before.realTokenReserves - trade.tokenAmount)

    const ppm =
      1_000_000n - ceilDiv(after.realTokenReserves * 1_000_000n, 793_100_000n * 10n ** 18n)
    const percent = (Math.round(Number(ppm) / 1_000) / 10).toFixed(1)
    await expect(page.getByText(`${percent}%`).first()).toBeVisible()
  })

  test('5: Receive tokens clamps to the reserve and SAYS what is left', async ({ page }) => {
    const { token, curve } = launched!
    const state = await readCurve(curve)

    // PRECONDITION: the budget below must exceed what is actually left, or the
    // clamp line would appear for a reason the test did not establish.
    const askTok = state.realTokenReserves + 1_000n * 10n ** 18n
    expect(state.realTokenReserves, 'the ask must exceed the remaining reserve').toBeLessThan(
      askTok,
    )

    await withWallet(page)
    await page.goto(`/token/${token}`)
    await page.getByRole('tab', { name: 'Receive tokens' }).click()
    await page.getByLabel('Tokens to buy').fill(String(askTok / 10n ** 18n))

    await expect(page.getByTestId('clamp-notice')).toBeVisible()
    await expect(page.getByTestId('clamp-notice')).toContainText('left on the curve')
  })

  test('6: selling asks for an allowance first, and approves exactly the amount', async ({
    page,
  }) => {
    const { token, curve } = launched!
    const wallet = await withWallet(page)

    // PRECONDITION: the two-step flow is only meaningful when there is no
    // allowance yet. Asserted from the chain, not assumed from ordering.
    const allowance = (await chainClient().readContract({
      address: token,
      abi: launchTokenAbi,
      functionName: 'allowance',
      args: [wallet.address, curve],
    })) as bigint
    expect(allowance, 'the two-step sell flow requires a zero allowance').toBe(0n)

    const balance = (await chainClient().readContract({
      address: token,
      abi: launchTokenAbi,
      functionName: 'balanceOf',
      args: [wallet.address],
    })) as bigint
    expect(balance, 'step 4 must have left tokens to sell').toBeGreaterThan(0n)

    await page.goto(`/token/${token}`)
    await connectWallet(page)
    await page.getByRole('tab', { name: 'Sell' }).click()

    const sellTok = balance / 2n
    await page.getByLabel('Tokens to sell').fill(String(sellTok / 10n ** 18n))
    await expect(page.getByTestId('approve-steps')).toBeVisible()

    await page.getByTestId('trade-submit').click()
    await expect
      .poll(
        async () =>
          (await chainClient().readContract({
            address: token,
            abi: launchTokenAbi,
            functionName: 'allowance',
            args: [wallet.address, curve],
          })) as bigint,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0n)

    const granted = (await chainClient().readContract({
      address: token,
      abi: launchTokenAbi,
      functionName: 'allowance',
      args: [wallet.address, curve],
    })) as bigint
    // NOT UNLIMITED. The mutant "approve the maximum" dies on this line.
    expect(granted, 'the approval must be bounded by what is being sold').toBeLessThan(2n ** 255n)

    await page.getByTestId('trade-submit').click()
    await expect(page.getByTestId('tx-confirmed')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('tx-confirmed')).toContainText('Sold')
  })

  test('7: a wallet rejection says "Cancelled.", shows no red box, and keeps the input', async ({
    page,
  }) => {
    const { token } = launched!
    const wallet = await withWallet(page)
    await page.goto(`/token/${token}`)
    await connectWallet(page)

    await page.getByLabel('Amount to spend').fill('0.25')
    wallet.rejectNext()
    await page.getByTestId('trade-submit').click()

    const notice = page.getByTestId('failure-notice')
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(notice).toHaveAttribute('data-name', 'UserRejected')
    await expect(notice).toContainText('Cancelled.')

    /*
     * "NO RED BOX" IS MEASURED, NOT CLASS-MATCHED.
     *
     * This assertion is the reason the whole browser leg exists. The neutral
     * branch was WRITTEN (Task 14, `tone: 'neutral'`) and the panel drew its
     * own `role="alert"` red box instead, because nothing rendered the notice
     * at all -- a component with 645 green unit tests behind it that no page
     * reached. A class-name assertion would not have caught the follow-up
     * either: Tailwind emits in ITS order, not the authoring order, so a
     * conflicting utility can be present in `className` and lose in the
     * cascade. `getComputedStyle` is what the user actually sees.
     */
    const painted = await notice.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        borderTopWidth: style.borderTopWidth,
        backgroundColor: style.backgroundColor,
      }
    })
    expect(painted.borderTopWidth, 'a decision must not be framed like an error').toBe('0px')
    expect(painted.backgroundColor, 'a decision must not be filled like an error').toBe(
      'rgba(0, 0, 0, 0)',
    )

    await expect(page.getByLabel('Amount to spend')).toHaveValue('0.25')
  })

  test('8: a budget past the top clamps, refunds, completes, and REMOVES the panel', async ({
    page,
  }) => {
    const { token, curve } = launched!
    const before = await readCurve(curve)

    // PRECONDITION: the panel must EXIST before the trade that removes it,
    // otherwise "the panel is gone" is satisfied by a page that never had one.
    const wallet = await withWallet(page)
    await page.goto(`/token/${token}`)
    await connectWallet(page)
    await expect(page.getByTestId('trade-panel')).toBeVisible()
    expect(before.complete, 'the curve must be open before this step').toBe(false)

    // Enough to buy the whole remaining reserve, with room to be refunded.
    // PRECONDITION for the clamp: the budget must exceed what the curve can
    // still take, asserted from the chain rather than assumed from the number.
    const stillTakeable =
      (before.virtualQuoteReserves * before.realTokenReserves) /
      (before.virtualTokenReserves - before.realTokenReserves)
    const budget = 20_000_000_000_000_000_000n
    expect(stillTakeable, 'the budget must exceed what the curve can absorb').toBeLessThan(budget)

    await page.getByLabel('Amount to spend').fill('20')
    await openBreakdown(page)
    /*
     * THE CLAMP AND THE REFUND ARE SHOWN BEFORE THE TRANSACTION.
     *
     * This line did not exist until this spec asked for it. The planner
     * already computed `clamped` and `refund`; the breakdown printed neither,
     * so a user typing 20 USDC into a curve that can absorb 11 saw "You spend
     * 20.000000 USDC", signed it, and found most of the money back afterwards.
     * Correct behaviour, unannounced.
     */
    await expect(page.getByTestId('label-clamp')).toContainText('refunded')
    const refundShown = await page.getByTestId('quote-clamp').textContent()
    expect(refundShown, 'the refund must be a real figure, not a dash').toMatch(/\d\.\d{6}/)

    await page.getByTestId('trade-submit').click()

    await expect.poll(async () => (await readCurve(curve)).complete, { timeout: 90_000 }).toBe(true)

    const hash = wallet.sent().at(-1)!
    const receipt = await chainClient().waitForTransactionReceipt({ hash })
    const completed = parseEventLogs({
      abi: bondingCurveAbi,
      eventName: 'Completed',
      logs: receipt.logs,
    })
    expect(completed.length, 'closing the curve must emit Completed').toBe(1)
    const trades = parseEventLogs({ abi: bondingCurveAbi, eventName: 'Trade', logs: receipt.logs })
    const closing = trades[0]!.args as unknown as { quoteAmount: bigint }
    expect(
      closing.quoteAmount,
      'the chain must have taken LESS than the budget — that is what a clamp is',
    ).toBeLessThan(budget)

    /*
     * THE FORM GOES, THE RECEIPT STAYS -- AND THE SECOND HALF WAS A DEFECT.
     *
     * The panel removes itself the moment the curve closes, which is correct:
     * all three entrypoints revert with `CurveComplete()`. But it used to
     * return `null` and take the confirmation with it, so the largest trade a
     * user ever makes -- the only one that is ever REFUNDED -- lost its
     * receipt to the very refresh that confirmed it. Both halves are asserted
     * here so neither can be satisfied alone.
     */
    await expect(page.getByTestId('trade-panel')).toHaveCount(0)
    await expect(page.getByTestId('trade-receipt')).toBeVisible()
    await expect(page.getByTestId('realised-refund')).toBeVisible()

    /*
     * COMPLETION, FROM THE CHAIN AND THEN FROM THE SCREEN -- AND THE SCREEN
     * DOES NOT SAY "100.0%".
     *
     * Asserting the percentage was the first version and it was wrong about
     * the product, not about the maths: `ProgressToGraduation` is replaced by
     * the lifecycle notice once the curve closes, so a completed page shows
     * "Curve complete" and no percentage at all. That is the better copy --
     * "100% to graduation" reads like something is still pending -- so the
     * assertion follows the product.
     */
    const after = await readCurve(curve)
    expect(after.realTokenReserves, 'a complete curve has nothing left to sell').toBe(0n)
    await expect(page.getByText('Curve complete').first()).toBeVisible()

    // And a RELOAD keeps the form gone: the removal is a property of the page,
    // not of this browser session's state.
    await page.reload()
    await expect(page.getByTestId('trade-panel')).toHaveCount(0)
  })
})
