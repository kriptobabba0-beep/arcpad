import { expect, test } from '@playwright/test'
import {
  ARC_TESTNET_CHAIN_ID,
  bondingCurveAbi,
  getArcChain,
  launchFactoryAbi,
  USDC_ERC20_ADDRESS,
  USDC_VIEW_SCALE,
} from '@arcpad/shared/browser'
import { type Address, createPublicClient, type Hex, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
/*
 * STATICALLY IMPORTED, AND IT USED TO BE A DYNAMIC `await import(...)` INSIDE
 * THE TEST. MEASURED, on the first run this leg ever had:
 *
 *   ReferenceError: exports is not defined in ES module scope
 *     at packages/shared/src/browser.ts:3
 *     at web/lib/decodeRevert.ts:7
 *     at e2e/arc/two-view-balance.spec.ts:386
 *
 * Playwright transpiles the files IT loads to CommonJS, but a dynamic `import()`
 * evaluated at run time goes through Node's own ESM loader instead -- and
 * `@arcpad/shared` is a `"type": "module"` package, so the CommonJS body arrived
 * in an ES module scope and `exports` did not exist. The static import above it
 * (`@arcpad/shared/browser`, line 2) proves the static path works in this very
 * file. The dynamic one could never have passed, on any chain, with any curve.
 */
import { decodeArcpadError } from '../../lib/decodeRevert'
// Same static-import rule as above: `lib/graduationOutcome.ts` reaches
// `@arcpad/shared/browser` through `lib/graduationAbi.ts`, so a dynamic
// `import()` of it would hit the identical CommonJS-in-ESM wall.
import { decodeGraduationError } from '../../lib/graduationOutcome'
import { connectWallet, injectedWallet } from '../fixtures/wallet'

/**
 * THE ARC LEG -- THE ONE THING ANVIL CANNOT MEASURE.
 *
 * On Arc the native gas asset IS USDC, and it has TWO VIEWS of ONE balance: an
 * 18-decimal native view (`eth_getBalance`) and a 6-decimal ERC-20 view
 * (`balanceOf` on 0x3600…0000). An interface that SUMS them is wrong by a
 * factor of ~1e12 and looks entirely plausible.
 *
 * THE RELATION IS TRUNCATION, NOT EQUALITY, AND IT WAS MEASURED. Task 15 step 4
 * and AGENT-CONTEXT both state `balanceOf * 1e12 === eth_getBalance`; on the
 * live chain that is FALSE (see the assertion below for the readings). The ERC-20
 * view cannot hold sub-micro-USDC dust, so `units === floor(wei / 1e12)`.
 *
 * THAT DEFECT CANNOT BE SEEN ON ANVIL, and this is the whole reason the suite
 * has two legs. There is no contract at 0x3600…0000 on a devchain, so the
 * second read reverts or returns nothing and the summing interface stays
 * green. The mutant "add the ERC-20 reading to the balance" is expected to
 * leave the local leg passing -- that is the proof the split is real, not the
 * failure of the local leg.
 *
 * THE GATE HAS THREE STATES AND NONE OF THEM IS SILENT:
 *
 *   E2E_ARC unset             -> skipped, AND the skip is printed and written
 *                                to the run's report as an OPEN CELL.
 *   E2E_ARC=1, factory has no  -> FAILS. A misconfigured run is a
 *   code                          configuration defect, not something to skip:
 *                                a silent skip reads exactly like a pass.
 *   E2E_ARC=1, factory live    -> runs.
 *
 * FUNDING, MEASURED: a launch plus one buy plus one sell stays under 1 USDC,
 * so a single faucet request (10 USDC) is more than enough. COMPLETING a curve
 * needs 12.313451 USDC plus gas -- two faucet requests -- so that scenario
 * lives behind `E2E_ARC_COMPLETE=1` and is not in the default run. The reason
 * is recorded rather than implied: a faucet rate limit cannot be a CI gate.
 */

const ENABLED = process.env.E2E_ARC === '1'
const RPC = process.env.E2E_ARC_RPC_URL ?? ''
const FACTORY = (process.env.E2E_ARC_FACTORY ?? '') as Address
const KEY = (process.env.E2E_ARC_PRIVATE_KEY ?? '') as Hex
/**
 * A FUNDED ADDRESS TO READ. Its private key is NOT needed.
 *
 * The K1 claim is a READ, and measuring it needs a NON-ZERO balance -- on zero
 * both views are zero and every relation between them holds vacuously. It does
 * not need the account's key. The funded testnet account's key lives in an
 * encrypted keystore that this harness cannot open, so the provider signs with
 * the configured key (if any) and REPORTS this address, which is enough for
 * every read path and incapable of moving anybody's money. Defaults to the
 * signing key's own address when both are configured.
 *
 * IT IS A `string`, NOT AN `Address`, AND THAT IS THE POINT. Reading it as
 * `(process.env.X ?? '') as Address` told the compiler that an UNSET variable
 * could never be `''`, so the "is it configured?" guard below was DEAD -- the
 * compiler called it out as TS2367, "these types have no overlap", and the
 * fallback to the signing key's address was unreachable as written. A cast at
 * the point of READING erases exactly the state the code exists to handle; the
 * narrowing belongs at the point of USE, after the shape has been checked.
 */
const WATCH = process.env.E2E_ARC_WATCH ?? ''
const IS_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const isAddress = (value: string): value is Address => IS_ADDRESS.test(value)
const BASE = process.env.E2E_ARC_BASE_URL ?? ''

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

function arcClient() {
  // `transport` is REQUIRED, so it cannot be spread in conditionally -- the
  // first version did exactly that and produced an optional property, which
  // the release gate's typecheck caught. `http()` with no argument falls back
  // to the chain registry's own RPC, which is the right default anyway.
  return createPublicClient({
    chain: getArcChain(ARC_TESTNET_CHAIN_ID),
    transport: RPC === '' ? http() : http(RPC),
  })
}

/**
 * THE SKIP IS AN ANNOUNCEMENT, AND IT IS A TEST RATHER THAN A HOOK.
 *
 * MEASURED, AND THE FIRST VERSION WAS WRONG IN EXACTLY THE WAY THIS FILE IS
 * ABOUT. The announcement lived in a top-level `beforeAll`, and Playwright does
 * not run hooks for a file whose every test is skipped -- so the run printed
 * NOTHING and reported "5 skipped" in grey, which is precisely the silent skip
 * the plan forbids. A test is not skippable by the `describe` below, so it
 * always runs and always says which of the two states the leg is in.
 *
 * It also carries an ANNOTATION, so a machine-readable report has the cell too
 * and a human does not have to grep console output for it.
 */
test('the Arc leg reports itself: it either ran, or it says plainly that it did not', () => {
  if (ENABLED) {
    expect(RPC, 'E2E_ARC=1 must come with a configured RPC').not.toBe('')
    return
  }
  const cell =
    'OPEN CELL — the Arc testnet leg did not run. E2E_ARC is not set, so the two-view ' +
    'balance relation (units === floor(wei / 1e12)) was NOT measured. Nothing on a ' +
    `devchain can measure it: there is no contract at ${USDC_ERC20_ADDRESS} on anvil, so an ` +
    'interface that SUMMED the two views would stay green on the local leg forever.'
  console.warn(`\n[e2e:arc] ${cell}\n`)
  test.info().annotations.push({ type: 'open-cell', description: cell })
  // NOT an assertion failure: an unconfigured Arc leg is a known gap, not a
  // broken build. The gate is that this sentence is IMPOSSIBLE to not emit.
  expect(cell.length).toBeGreaterThan(80)
})

test.describe('Arc testnet', () => {
  test.skip(!ENABLED, 'E2E_ARC is not set — see the OPEN CELL printed above')

  test.beforeAll(async () => {
    /*
     * A CONFIGURED-BUT-BROKEN RUN FAILS HERE, LOUDLY.
     *
     * Every one of these would otherwise surface much later as a confusing
     * browser error, and the most dangerous one -- a factory address with no
     * code behind it -- would surface as "the page shows dashes", which reads
     * like a UI bug rather than a pointer at nothing.
     */
    expect(RPC, 'E2E_ARC=1 requires E2E_ARC_RPC_URL').not.toBe('')
    expect(BASE, 'E2E_ARC=1 requires E2E_ARC_BASE_URL (a deployed or locally built app)').not.toBe(
      '',
    )
    /*
     * A KEY OR A WATCHED ADDRESS -- THE READ CLAIMS NEED ONLY THE SECOND.
     *
     * The K1 property is a read. Requiring a funded PRIVATE KEY for it was the
     * first version and it made the whole leg unrunnable wherever the key lives
     * in a keystore, which is everywhere it should live. `E2E_ARC_WATCH` names
     * a funded address; the write tests below still require the key.
     */
    expect(
      /^0x[0-9a-fA-F]{64}$/.test(KEY) || isAddress(WATCH),
      'E2E_ARC=1 requires E2E_ARC_PRIVATE_KEY (to sign) or E2E_ARC_WATCH (to read)',
    ).toBe(true)
    expect(FACTORY, 'E2E_ARC=1 requires E2E_ARC_FACTORY').toMatch(/^0x[0-9a-fA-F]{40}$/)

    const code = await arcClient().getCode({ address: FACTORY })
    expect(
      code !== undefined && code.length > 2,
      `E2E_ARC_FACTORY ${FACTORY} has NO CODE on this chain. ` +
        'This is a configuration failure, not a reason to skip.',
    ).toBe(true)

    const chainId = await arcClient().getChainId()
    expect(chainId, 'the configured RPC must actually be Arc testnet').toBe(ARC_TESTNET_CHAIN_ID)

    // And the factory must be the real thing, not merely some contract: a
    // wrong-but-deployed address would pass a code check and fail nothing.
    const count = await arcClient().readContract({
      address: FACTORY,
      abi: launchFactoryAbi,
      functionName: 'launchCount',
    })
    expect(typeof count, 'the address must answer launchCount()').toBe('bigint')
  })

  /**
   * K1. THE REASON THIS LEG EXISTS.
   */
  test('the ERC-20 view and the native view are ONE balance, and the screen shows ONE row', async ({
    page,
  }) => {
    // UNSET (or malformed) `E2E_ARC_WATCH` falls back to the signing key's own
    // address. `beforeAll` has already established that at least one of the two
    // is present, so this cannot silently read address zero.
    const watched: Address = isAddress(WATCH) ? WATCH : privateKeyToAccount(KEY).address
    const client = arcClient()

    /*
     * READ ORDER IS REVERSED RELATIVE TO THE OBVIOUS ONE, ON PURPOSE.
     *
     * Arc closes a block in ~350ms, so two sequential RPC calls are NOT
     * simultaneous observations -- that trap produced two false findings on
     * this project. A transfer landing between the two reads would break the
     * identity for a reason that has nothing to do with the interface. Reading
     * the ERC-20 view first and the native view second, then asserting again
     * in the other order, makes an interleaved block visible as a DISAGREEMENT
     * BETWEEN THE TWO PAIRS rather than as a false failure.
     */
    const units = (await client.readContract({
      address: USDC_ERC20_ADDRESS,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [watched],
    })) as bigint
    const wei = await client.getBalance({ address: watched })
    const weiAgain = await client.getBalance({ address: watched })
    const unitsAgain = (await client.readContract({
      address: USDC_ERC20_ADDRESS,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [watched],
    })) as bigint

    if (wei !== weiAgain || units !== unitsAgain) {
      test.skip(true, 'the balance moved between reads; this is a timing artefact, not a finding')
    }

    // NON-VACUITY. On a zero balance every relation below holds trivially.
    expect(units, 'the account must be funded for this leg to measure anything').toBeGreaterThan(0n)

    /*
     * =====================================================================
     *  THE PLAN'S IDENTITY IS FALSE, AND IT WAS MEASURED FALSE ON THE LIVE
     *  CHAIN RATHER THAN REASONED ABOUT.
     * =====================================================================
     *
     * Task 15 step 4 pins `balanceOf * 1e12 === nativeBalance`, and
     * AGENT-CONTEXT's example says the same ("a wallet with 100 USDC reads
     * 100e18 and 100e6"). Read against Arc testnet, on the deployer
     * 0xe92c64C4f36216eA773f2622f6D5f8530Ae92fD2, 2026-08-04:
     *
     *     balanceOf       87437450                 (6 decimals)
     *     eth_getBalance  87437450467213720651     (18 decimals)
     *     balanceOf*1e12  87437450000000000000     -> NOT equal
     *
     * The ERC-20 view TRUNCATES: it cannot represent sub-micro-USDC dust, and
     * a real account carries dust the moment it has paid for one transaction.
     * The equality holds only for balances that are exact multiples of 1e12 --
     * which is the shape a hand-written example has and a live account does
     * not. The first draft of this spec asserted it and would have failed
     * against the chain it was written for.
     *
     * The TRUE relation is `units === floor(wei / 1e12)`.
     * `packages/shared/src/balance.ts` (`unifyUsdcViews`) already implements
     * exactly that, so this is a defect in the PLAN, not in the application.
     * Both forms are asserted -- the true one because it is the claim, the
     * false one because somebody will otherwise re-derive it from the plan.
     */
    expect(units, 'the ERC-20 view is the native view floor-divided by 1e12').toBe(
      wei / USDC_VIEW_SCALE,
    )
    expect(units * USDC_VIEW_SCALE <= wei, 'lower bound of the truncation window').toBe(true)
    expect(wei < (units + 1n) * USDC_VIEW_SCALE, 'upper bound of the truncation window').toBe(true)
    console.warn(
      `[e2e:arc] units=${units} wei=${wei} dust=${wei - units * USDC_VIEW_SCALE} ` +
        `(the plan's "units*1e12 === wei" is ${units * USDC_VIEW_SCALE === wei})`,
    )

    await injectedWallet(page, {
      privateKey: KEY,
      // The page sees the WATCHED address, which may not be the signing key's.
      reportedAddress: watched,
      rpcUrl: RPC,
      chain: getArcChain(ARC_TESTNET_CHAIN_ID),
    })
    await page.goto(`${BASE}/`)
    await connectWallet(page)

    /*
     * EXACTLY ONE BALANCE ROW, AND IT SHOWS THE SIX-DECIMAL VIEW.
     *
     * An interface that summed the two views would still show ONE row -- with
     * a number about 1e12 too large. So the count is not the assertion; the
     * VALUE is. The count is asserted too, because two rows is the other way
     * the same misunderstanding shows up.
     */
    const chip = page.getByRole('button', { name: /Your wallet/ })
    await expect(chip).toHaveCount(1)
    const sixDecimal = `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')}`
    const withGrouping = `${(units / 1_000_000n).toLocaleString('en-US')}.${(units % 1_000_000n).toString().padStart(6, '0')}`

    /*
     * IT POLLS, AND THE ONE-SHOT VERSION FAILED ON THE FIRST RUN THIS LEG EVER
     * HAD. The chip is rendered as soon as the connection lands; the BALANCE
     * inside it arrives later, from a query the page still has in flight, and
     * until then `<Money>` draws an em dash. `toHaveCount(1)` resolves at the
     * first of those two moments, so a `textContent()` taken straight after it
     * read:
     *
     *     Your wallet: 0xe92c…2fD2—
     *
     * against a live RPC. On anvil the query answers on a loopback socket in
     * microseconds and the same code passes every time -- an UNSTATED
     * LOAD-BEARING PRECONDITION, which this repository counts as a finding even
     * while the test is green. The claim is unchanged: ONE row, showing the
     * SIX-DECIMAL view. Only the sampling retries. Measured against the same
     * build with a poll: the chip reads "Your wallet: 0xe92c…2fD2 74.617997
     * USDC" ~1.1 s after `goto`.
     */
    const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await expect
      .poll(async () => ((await chip.textContent()) ?? '').replace(/\s+/g, ' '), {
        message: `the wallet chip never showed the six-decimal view ${withGrouping}`,
        timeout: 30_000,
      })
      .toMatch(new RegExp(`${escapeRegExp(sixDecimal)}|${escapeRegExp(withGrouping)}`))
  })

  /**
   * THE PRECONDITION THE NEXT THREE TESTS NEVER STATED.
   *
   * Every one of them needs an OPEN curve: two need a trade panel, which the
   * application deliberately does not render once `complete()` is true (see
   * `components/token/LifecycleNotice.tsx` -- leaving it up would ask the user
   * to sign a transaction that is certain to revert), and the third needs a buy
   * to fail with `NetTooSmall()` rather than with `CurveComplete()`.
   *
   * Without this, a complete curve costs TWO MINUTES PER TEST of locator
   * timeout and reports "waiting for getByLabel('Amount to spend')" -- which
   * reads like a missing label, i.e. a UI defect, when the truth is that the
   * chain state cannot support the measurement. MEASURED on the live Phase 2
   * stack, 2026-08-09: `launchCount() == 1`, and that one curve is complete.
   */
  async function requireOpenCurve(): Promise<void> {
    const curve = process.env.E2E_ARC_CURVE ?? ''
    expect(curve, 'E2E_ARC=1 requires E2E_ARC_CURVE').toMatch(/^0x[0-9a-fA-F]{40}$/)
    const complete = (await arcClient().readContract({
      address: curve as Address,
      abi: bondingCurveAbi,
      functionName: 'complete',
    })) as boolean
    expect(
      complete,
      `the configured curve ${curve} is COMPLETE. This test needs an OPEN one: the ` +
        'trade panel is not rendered on a complete curve and every entry point reverts ' +
        'CurveComplete(). Launch a token on the configured factory (a WRITE) or point ' +
        'E2E_ARC_TOKEN / E2E_ARC_CURVE at an open pair.',
    ).toBe(false)
  }

  /**
   * GAS COMES OUT OF THE SAME BALANCE.
   */
  test('a buy costs exactly spend + gasUsed x effectiveGasPrice from the one balance', async ({
    page,
  }) => {
    await requireOpenCurve()
    const account = privateKeyToAccount(KEY)
    const client = arcClient()
    const wallet = await injectedWallet(page, {
      privateKey: KEY,
      rpcUrl: RPC,
      chain: getArcChain(ARC_TESTNET_CHAIN_ID),
    })

    const token = process.env.E2E_ARC_TOKEN ?? ''
    expect(token, 'E2E_ARC=1 requires E2E_ARC_TOKEN — an open curve to trade against').toMatch(
      /^0x[0-9a-fA-F]{40}$/,
    )
    /*
     * AND IT NEEDS A FUNDED SIGNING KEY, which `E2E_ARC_WATCH` cannot stand in
     * for: this is the ONE test in the file that BROADCASTS. The balance it
     * measures is the SIGNING account's, so a throwaway key does not make the
     * claim merely unfunded, it makes it unmeasurable -- `before - after` would
     * be `0 - 0`. Asserted as a READ of the real balance, because "the key is
     * configured" is not the property that matters and a regex on the key would
     * pass for the harness-generated one.
     */
    const funding = await client.getBalance({ address: account.address })
    expect(
      funding > 0n,
      `this test broadcasts a real buy, and the signing account ${account.address} holds ` +
        'nothing. Set E2E_ARC_PRIVATE_KEY to a FUNDED key; the harness generates an ' +
        'unfunded throwaway so that a read-only run cannot broadcast by accident.',
    ).toBe(true)

    await page.goto(`${BASE}/token/${token}`)
    await connectWallet(page)

    const before = await client.getBalance({ address: account.address })
    await page.getByLabel('Amount to spend').fill('0.05')
    await page.getByTestId('trade-submit').click()
    await expect(page.getByTestId('tx-confirmed')).toBeVisible({ timeout: 120_000 })

    const hash = wallet.sent().at(-1)!
    const receipt = await client.waitForTransactionReceipt({ hash })
    const tx = await client.getTransaction({ hash })
    const after = await client.getBalance({ address: account.address })

    const gas = receipt.gasUsed * receipt.effectiveGasPrice
    expect(
      before - after,
      'on Arc the trade and its gas leave the SAME balance; the delta must be their sum',
    ).toBe(tx.value + gas)
  })

  /**
   * MAX MUST NOT SPEND EVERYTHING.
   */
  test('MAX leaves room for gas: the transaction is not rejected for funds', async ({ page }) => {
    await requireOpenCurve()
    const client = arcClient()
    const token = process.env.E2E_ARC_TOKEN ?? ''

    /*
     * THE PAGE SEES THE WATCHED ADDRESS, AND THIS TEST DOES NOT SIGN ANYTHING.
     *
     * It used to report the signing key's own address, which made the claim
     * unmeasurable for a read-only run: the harness generates an UNFUNDED
     * throwaway when no key is configured, `spendableFrom(0, reserve)` is
     * `null`, `SpendableMaxButton` disables MAX, and Playwright's
     * `click()` waits for an enabled element -- so the test burned its full
     * 120 s timeout waiting for a button that was correctly disabled. MEASURED
     * on the first run against an open curve.
     *
     * The claim here -- "MAX must reserve something for gas" -- is about a
     * DISPLAYED balance, not about the ability to sign, and `E2E_ARC_WATCH`
     * exists for exactly this. `sent().length === 0` below is what keeps it
     * honest: nothing may leave the wallet.
     */
    const watched: Address = isAddress(WATCH) ? WATCH : privateKeyToAccount(KEY).address
    const wallet = await injectedWallet(page, {
      privateKey: KEY,
      reportedAddress: watched,
      rpcUrl: RPC,
      chain: getArcChain(ARC_TESTNET_CHAIN_ID),
    })

    await page.goto(`${BASE}/token/${token}`)
    await connectWallet(page)

    const balance = await client.getBalance({ address: watched })
    // NON-VACUITY. On a zero balance `asWei < balance` cannot hold at all, so
    // the test would fail for the wrong reason and read as a product defect.
    expect(balance, 'MAX reserves a fraction of a balance; there must be one').toBeGreaterThan(0n)

    await page.getByRole('button', { name: 'MAX' }).click()
    const typed = await page.getByLabel('Amount to spend').inputValue()
    const asWei = BigInt(Math.round(Number(typed) * 1e6)) * 1_000_000_000_000n
    expect(asWei, 'MAX must reserve something for gas').toBeLessThan(balance)

    /*
     * AND THE RESERVE IS EXPLAINED, not merely taken. On Arc gas is paid in the
     * asset being spent, so a MAX below the balance looks like a bug unless the
     * interface says why. The panel renders that sentence; assert it, because
     * "MAX is smaller" without a reason is the same screen as a rounding error.
     */
    /*
     * ACILIR ACILIR, VE BU BIR KOZMETIK DUZELTME DEGILDIR. Not
     * `DetailsSection`in icindedir ve o `<details>` `open` TASIMAZ, yani
     * baslangicta `hidden`dir. Playwright'in `toContainText`i `textContent`
     * okur ve GIZLI bir elemanda da GECER -- yani bu iddia acilir olmadan da
     * yesildi ve "kullanici sebebi goruyor" degil "sebep DOM'da var" diyordu.
     * Iddianin konusu ekranda duran seydir.
     */
    const details = page.getByTestId('trade-details')
    if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
      // `> summary`: `QuoteBreakdown` da bir `<details>`tir ve bunun ICINDE
      // durur, yani torun aramasi IKI ozet bulur ve strict mode ile duser.
      await details.locator('> summary').click()
    }
    await expect(page.getByTestId('gas-reserve-note')).toBeVisible()
    await expect(page.getByTestId('gas-reserve-note')).toContainText(/leaves .* for gas/i)
    expect(wallet.sent().length, 'MAX must not send anything on its own').toBe(0)
  })

  /**
   * A REAL REVERT, RESOLVED THROUGH THE LIBRARY LAYER.
   */
  test('a sub-quantum value reverts with NetTooSmall and the interface names it', async ({
    page,
  }) => {
    await requireOpenCurve()
    const curve = process.env.E2E_ARC_CURVE ?? ''
    expect(curve).toMatch(/^0x[0-9a-fA-F]{40}$/)
    const client = arcClient()

    /*
     * ======================================================================
     *  THE `from` MUST BE FUNDED, AND I PREVIOUSLY MEASURED THE OPPOSITE.
     * ======================================================================
     *
     * This is a read -- `eth_call`, no signing, nothing broadcast -- so it
     * looked like any address would do. I probed exactly that against the
     * COMPLETE smoke curve, from a funded address and an unfunded one, and got
     * the SAME revert from both. I concluded that Arc's `eth_call` does not
     * enforce the value transfer. THAT CONCLUSION WAS WRONG, and the run that
     * proved it is the first one against an OPEN curve:
     *
     *     Expected: "NetTooSmall"   Received: "InsufficientFunds"
     *
     * On a complete curve `CurveComplete()` fires BEFORE the 1-wei transfer is
     * ever attempted, so both probes short-circuited at the same guard and the
     * balance check was never reached. The agreement between them measured the
     * completeness guard, not the transfer. An open curve gets past that guard,
     * the 1-wei value transfer is then evaluated, and an empty `from` fails
     * there instead -- several guards earlier than the one under test.
     *
     * A test that passes for a reason nobody wrote down is a finding even while
     * it is green; this was the same shape, one step worse, because the reason
     * was written down and was FALSE. The `from` is now the funded watched
     * address, which costs nothing and signs nothing.
     */
    const account: Address = isAddress(WATCH) ? WATCH : privateKeyToAccount(KEY).address
    expect(
      await client.getBalance({ address: account }),
      'the simulated buy transfers 1 wei, so its sender must be able to afford it -- ' +
        'otherwise the call reverts InsufficientFunds several guards before NetTooSmall',
    ).toBeGreaterThan(0n)

    /*
     * THE INTERFACE CANNOT PRODUCE THIS INPUT -- the amount field's own parser
     * refuses a value below the quantum -- so the call is built directly. That
     * is the point: the guard being measured is the CONTRACT'S, and the claim
     * is that our decoder names it correctly when the chain, not the form,
     * produces it.
     */
    const failure = await client
      .simulateContract({
        address: curve as Address,
        abi: [
          {
            type: 'function',
            name: 'buyExactQuoteIn',
            stateMutability: 'payable',
            inputs: [{ name: 'minTokensOut', type: 'uint256' }],
            outputs: [],
          },
        ] as const,
        functionName: 'buyExactQuoteIn',
        args: [0n],
        value: 1n,
        account,
      })
      .then(
        () => null,
        (error: unknown) => error,
      )

    expect(failure, 'a 1-wei buy must revert on Arc').not.toBeNull()
    const decoded = decodeArcpadError(failure, { action: 'buyExactQuoteIn' })
    expect(
      decoded.name,
      'the decoder must resolve a REAL Arc revert, not only a hand-built one',
    ).toBe('NetTooSmall')
    expect(page).toBeTruthy()
  })

  /**
   * ========================================================================
   *  THE COMPLETED CURVE: WHY IT HAS NOT GRADUATED, AND NO BUTTON THAT
   *  COULD ONLY REVERT.
   * ========================================================================
   *
   * This is the one claim in this file that could not be made anywhere else.
   * The page's graduation surface reads `curve.graduated()`, `curve.factory()`
   * and `factory.graduationTarget()` LIVE, and on the production factory that
   * last one is `0x0` DELIBERATELY. A component test can render any of those
   * four states by handing them to a prop; only a browser pointed at the real
   * chain can say which one a real visitor gets, and that a control is absent
   * because the chain says so rather than because the component happened not to
   * render one.
   *
   * WHAT THIS REPLACED. Measured in a real browser on 2026-08-09, before the
   * change: the completed token page showed "Sale supply sold out. Trading on
   * the curve is closed; pool creation lands with Phase 2." -- Phase 2 having
   * been on chain since 2026-08-06 -- an empty right-hand column, and no
   * mention anywhere that graduation is a separate call or that anyone may send
   * it. A user looking at a curve the keeper had not graduated had no way to
   * learn that a call existed.
   *
   * THE ABSENCE IS ASSERTED TOGETHER WITH ITS CAUSE. "No graduate button" is
   * satisfied by a page that failed to render anything at all, so the test also
   * (a) reads the three chain facts itself and (b) simulates
   * `locker.graduate(curve)` read-only and requires the revert the interface is
   * refusing on behalf of. Without (b) this would only prove the screen and the
   * screen's own beliefs agree.
   */
  test('a completed curve names WHY it cannot graduate, and offers no action that can only revert', async ({
    page,
  }) => {
    const token = process.env.E2E_ARC_SMOKE_TOKEN ?? ''
    const curve = process.env.E2E_ARC_SMOKE_CURVE ?? ''
    const locker = process.env.E2E_ARC_LOCKER ?? ''
    expect(token, 'the address book must carry a smokeToken').toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(curve, 'the address book must carry a smokeCurve').toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(locker, 'the address book must carry an arcpadLocker').toMatch(/^0x[0-9a-fA-F]{40}$/)

    const client = arcClient()
    // THE PRECONDITIONS, MEASURED RATHER THAN ASSUMED. If any of them stops
    // holding this test must fail loudly instead of asserting about a state the
    // chain is no longer in.
    const [complete, graduated, curveFactory] = (await Promise.all(
      (['complete', 'graduated', 'factory'] as const).map((functionName) =>
        client.readContract({ address: curve as Address, abi: bondingCurveAbi, functionName }),
      ),
    )) as [boolean, boolean, Address]
    expect(complete, `${curve} must be COMPLETE for this test to mean anything`).toBe(true)
    expect(graduated, `${curve} has graduated; this test measures the ungraduated screen`).toBe(
      false,
    )

    const target = (await client.readContract({
      address: curveFactory,
      abi: launchFactoryAbi,
      functionName: 'graduationTarget',
    })) as Address
    expect(
      target,
      'the production factory keeps graduationTarget at 0x0 deliberately; if this ever ' +
        'changes, the ARMED branch of the panel becomes reachable and needs its own case here',
    ).toBe('0x0000000000000000000000000000000000000000')

    /*
     * AND THE CALL REALLY WOULD REVERT. Read-only: `simulateContract` is an
     * `eth_call`, nothing is signed and nothing is broadcast. `0xfe30fa5b` is
     * `GraduationTargetUnset()` -- the same four bytes the keeper measured off
     * this chain on 2026-08-09 and pinned in its own classifier.
     */
    const refusal = await client
      .simulateContract({
        address: locker as Address,
        abi: [
          {
            type: 'function',
            name: 'graduate',
            stateMutability: 'nonpayable',
            inputs: [{ name: 'curve', type: 'address' }],
            outputs: [],
          },
        ] as const,
        functionName: 'graduate',
        args: [curve as Address],
        account: (isAddress(WATCH) ? WATCH : privateKeyToAccount(KEY).address) as Address,
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(refusal, 'graduate() on an unarmed factory must revert').not.toBeNull()
    const decoded = decodeGraduationError(refusal)
    expect(
      decoded.code,
      'the page refuses to offer this call; the chain must agree about WHY',
    ).toBe('target-unset')
    expect(decoded.tone, 'an unarmed launchpad is "not yet", not a fault').not.toBe('error')

    await page.goto(`${BASE}/token/${token}`)

    const card = page.getByTestId('lifecycle-notice')
    await expect(card).toBeVisible()
    await expect(card).toContainText(/trading on the curve is closed/i)
    await expect(card).toContainText(/does not happen automatically/i)
    await expect(card).toContainText(/anyone may send it/i)
    // THE SENTENCE THAT WAS LIVE, and the release name it carried.
    await expect(card).not.toContainText(/phase 2/i)
    await expect(card).not.toContainText(/lands with/i)

    /*
     * THE LIVE HALF, AND IT MUST POLL. Those three reads leave the browser
     * after hydration and cross the public internet; a one-shot expect here
     * would race them exactly the way K1's balance assertion did on this leg's
     * first run, and would pass forever on a loopback devchain.
     */
    await expect(page.getByTestId('graduation-unarmed')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('graduation-unarmed')).toContainText(/waiting on the launchpad/i)
    await expect(page.getByTestId('graduation-unarmed')).toContainText(/nothing is at risk/i)

    /*
     * AND NO CONTROL, COUNTED ACROSS THE WHOLE PAGE rather than inside the card.
     * A `within(card)` query passes just as happily with a stray control
     * elsewhere on the screen -- that is precisely how two "Switch to Arc
     * Testnet" buttons survived on this page while both components' own tests
     * were green.
     */
    await expect(page.getByTestId('graduate-submit')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Graduate$/ })).toHaveCount(0)
    // The trade panel is still absent too: three entrypoints revert
    // CurveComplete(), so this state offers no trade and no graduation.
    await expect(page.getByTestId('trade-panel')).toHaveCount(0)
  })

  /**
   * THE CONTROL, ON AN OPEN CURVE. Without it, "no graduation surface" could be
   * satisfied by a build in which the panel never renders anywhere -- and the
   * assertions above would all still pass.
   */
  test('an OPEN curve shows progress and no graduation surface at all', async ({ page }) => {
    await requireOpenCurve()
    await page.goto(`${BASE}/token/${process.env.E2E_ARC_TOKEN ?? ''}`)
    await expect(page.getByTestId('lifecycle-notice')).toHaveCount(0)
    await expect(page.getByTestId('graduation-unarmed')).toHaveCount(0)
    await expect(page.getByTestId('graduate-submit')).toHaveCount(0)
    // ...and the thing it shows INSTEAD, so this is not a test about an empty
    // page: the progress bar the completed curve replaces.
    await expect(page.getByText(/to graduation/i).first()).toBeVisible()
  })

  /**
   * WRONG NETWORK.
   */
  test('a wallet on another chain gets the switch button, and pressing it asks the wallet', async ({
    page,
  }) => {
    const wallet = await injectedWallet(page, {
      privateKey: KEY,
      rpcUrl: RPC,
      chain: getArcChain(ARC_TESTNET_CHAIN_ID),
      // Ethereum mainnet. Any id but Arc's would do; a REAL one is used so the
      // wallet's own chain registry cannot be the reason the screen appears.
      reportedChainId: 1,
    })
    await page.goto(`${BASE}/token/${process.env.E2E_ARC_TOKEN ?? ''}`)

    /*
     * THE CONNECT IS DONE HERE INSTEAD OF THROUGH `connectWallet`, AND THE
     * REASON IS THE BUG THIS TEST EXISTS TO CATCH.
     *
     * `connectWallet` finishes by waiting for the address chip
     * (`getByRole('button', { name: /Your wallet/ })`) -- and on a WRONG
     * NETWORK the shell deliberately renders the switch button INSTEAD of that
     * chip (`components/layout/WalletButton.tsx`: `if (wrongNetwork) return
     * <Button>Switch to …</Button>`). So the helper waited for a control this
     * very scenario is defined by the absence of. MEASURED on the first run this
     * leg ever had: 120 s of `waiting for getByRole('button', { name: /Your
     * wallet/ }) to be visible`, then a timeout. The test could not have passed
     * as written, on any chain.
     *
     * `connectWallet` itself is NOT changed: `e2e/local/` drives it and the
     * connected-chip wait is the right assertion everywhere the wallet is on the
     * right network. The wrong-network case is the exception, so it lives here.
     */
    await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click()
    await page.getByRole('button', { name: 'Arcpad E2E Wallet' }).click()

    /*
     * TWO BUTTONS ONCE SAID "SWITCH TO ARC TESTNET", AND THE FIRST RUN OF THIS
     * LEG IS WHAT FOUND THAT OUT. An unscoped locator here was a strict-mode
     * violation resolving to `getByTestId('network-banner')`'s button AND the
     * header's. `NetworkBanner` and `WalletButton` each rendered one; each was
     * unit-tested ALONE and each was correct alone. Nothing had ever rendered
     * the two together -- the repository's most repeated defect class.
     *
     * The header's is gone (see `components/layout/WalletButton.tsx`), and it
     * had a second cost: it replaced the address chip, so a wrong-network
     * visitor lost the account dialog and with it DISCONNECT.
     *
     * THE COUNT IS ASSERTED UNSCOPED, ON PURPOSE. A `within(banner)` query --
     * which is what the unit test did -- passes just as happily with three of
     * them on screen. Counting across the whole page is the assertion that
     * would have caught this, so it is the assertion that stays.
     *
     * AND THE EXPECTED TOTAL IS DERIVED, NOT HARDCODED. On a COMPLETE curve the
     * trade panel is not rendered at all, so the page carries one control; on an
     * OPEN curve the panel renders and turns its OWN submit into the switch, so
     * it carries two. The first run of this leg saw only two of the three
     * because the fixture curve was complete -- the count was MASKED BY CHAIN
     * STATE, which is exactly the kind that comes back. So the total is computed
     * from an observed structural fact (is the panel there?) and every control
     * is then named individually. A bare number would either be wrong on one of
     * the two curves or would have to be loosened until it measured nothing.
     */
    const banner = page.getByTestId('network-banner')
    await expect(banner).toBeVisible()

    const panels = await page.getByTestId('trade-panel').count()
    if (panels === 1) {
      await expect(
        page.getByTestId('trade-submit'),
        'on an open curve the panel makes its OWN submit the switch -- that is the ' +
          'strongest placement there is and it is NOT the duplicate that was removed',
      ).toHaveAccessibleName(/Switch to Arc Testnet/)
    }
    await expect(
      page.getByRole('button', { name: /Switch to Arc Testnet/ }),
      `the shell offers the switch ONCE, plus the form's own submit when a trade ` +
        `panel is on screen (panels=${panels}). Two controls in the SHELL with one ` +
        'accessible name is the defect this leg found on its first run.',
    ).toHaveCount(1 + panels)
    await expect(
      page.getByRole('banner').getByRole('button', { name: /Switch to Arc Testnet/ }),
      'the header must not carry a second one',
    ).toHaveCount(0)
    // And the wrong network must not cost the user their account menu: the chip
    // is what opens the dialog that holds the full address and Disconnect.
    await expect(
      page.getByRole('button', { name: /Your wallet/ }),
      'a wrong-network wallet keeps its address chip, and therefore Disconnect',
    ).toHaveCount(1)
    const button = banner.getByRole('button', { name: /Switch to Arc Testnet/ })
    await expect(button).toBeVisible()
    await button.click()
    await expect
      .poll(() => wallet.methods().includes('wallet_switchEthereumChain'), { timeout: 15_000 })
      .toBe(true)
  })
})
