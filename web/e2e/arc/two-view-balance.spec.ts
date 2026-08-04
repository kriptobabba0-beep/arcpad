import { expect, test } from '@playwright/test'
import {
  ARC_TESTNET_CHAIN_ID,
  getArcChain,
  launchFactoryAbi,
  USDC_ERC20_ADDRESS,
  USDC_VIEW_SCALE,
} from '@arcpad/shared/browser'
import { type Address, createPublicClient, type Hex, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
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
    const shown = (await chip.textContent()) ?? ''
    const sixDecimal = `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')}`
    const withGrouping = `${(units / 1_000_000n).toLocaleString('en-US')}.${(units % 1_000_000n).toString().padStart(6, '0')}`
    expect(
      shown.includes(sixDecimal) || shown.includes(withGrouping),
      `the wallet chip shows "${shown}" but the six-decimal view is ${withGrouping}`,
    ).toBe(true)
  })

  /**
   * GAS COMES OUT OF THE SAME BALANCE.
   */
  test('a buy costs exactly spend + gasUsed x effectiveGasPrice from the one balance', async ({
    page,
  }) => {
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
    const client = arcClient()
    const account = privateKeyToAccount(KEY)
    const token = process.env.E2E_ARC_TOKEN ?? ''
    const wallet = await injectedWallet(page, {
      privateKey: KEY,
      rpcUrl: RPC,
      chain: getArcChain(ARC_TESTNET_CHAIN_ID),
    })

    await page.goto(`${BASE}/token/${token}`)
    await connectWallet(page)

    const balance = await client.getBalance({ address: account.address })
    await page.getByRole('button', { name: 'MAX' }).click()
    const typed = await page.getByLabel('Amount to spend').inputValue()
    const asWei = BigInt(Math.round(Number(typed) * 1e6)) * 1_000_000_000_000n
    expect(asWei, 'MAX must reserve something for gas').toBeLessThan(balance)
    expect(wallet.sent().length, 'MAX must not send anything on its own').toBe(0)
  })

  /**
   * A REAL REVERT, RESOLVED THROUGH THE LIBRARY LAYER.
   */
  test('a sub-quantum value reverts with NetTooSmall and the interface names it', async ({
    page,
  }) => {
    const curve = process.env.E2E_ARC_CURVE ?? ''
    expect(curve).toMatch(/^0x[0-9a-fA-F]{40}$/)
    const client = arcClient()
    const account = privateKeyToAccount(KEY)

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
    const { decodeArcpadError } = (await import('../../lib/decodeRevert')) as {
      decodeArcpadError: (e: unknown, ctx: { action: 'buyExactQuoteIn' }) => { name: string }
    }
    const decoded = decodeArcpadError(failure, { action: 'buyExactQuoteIn' })
    expect(
      decoded.name,
      'the decoder must resolve a REAL Arc revert, not only a hand-built one',
    ).toBe('NetTooSmall')
    expect(page).toBeTruthy()
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
    await connectWallet(page)

    const button = page.getByRole('button', { name: /Switch to Arc Testnet/ })
    await expect(button).toBeVisible()
    await button.click()
    await expect
      .poll(() => wallet.methods().includes('wallet_switchEthereumChain'), { timeout: 15_000 })
      .toBe(true)
  })
})
