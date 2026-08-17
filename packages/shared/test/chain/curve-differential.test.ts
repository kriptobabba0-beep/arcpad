import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Address, getAddress, parseEventLogs } from 'viem'
import { foundry } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bondingCurveAbi } from '../../src/abi/bondingCurve'
import { feeEscrowAbi } from '../../src/abi/feeEscrow'
import type { CurveProfile } from '../../src/curve'
import {
  type AnvilHandle,
  type ArcpadDeployment,
  devAccount,
  devClients,
  type DevClients,
  deployArcpad,
  deployZeroCreatorCurve,
  startAnvil,
  ZERO_ADDRESS,
  type ZeroCreatorDeployment,
} from '../../src/devchain'
import {
  asTok,
  asWei,
  type CurveState,
  type FeeBps,
  planBuyExactQuoteIn,
  planBuyExactTokensOut,
  planSellExactTokensIn,
  TRADE_ACTIONS,
  type TradePlan,
} from '../../src/trade'
import { parseUsdcAmount } from '../../src/usdc'

/**
 * THE QUOTE ENGINE, RUN AGAINST THE COMPILED CURVE.
 *
 * `curve.test.ts` and `trade.test.ts` prove the ARITHMETIC. This proves the
 * AGREEMENT: that the calldata the planner emits, executed by real
 * `BondingCurve` bytecode, produces exactly the numbers the planner promised --
 * every fee, every reserve, every refund.
 *
 * WHAT THIS FILE CANNOT SEE, stated where it can be read rather than in a
 * design doc: anvil has no contract at `0x3600...0000`, so the ERC-20 view of
 * USDC does not exist here. The two-views display is NOT tested by this file
 * and a UI that summed the two balances would not look wrong in it. That gap
 * belongs to Task 15's Arc leg.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

// The testnet profile, hand-copied from the deployed factory.
const T = 1_073_000_000n * 10n ** 18n
const V = 4_292_000_000_000_000_000n
const S = 793_100_000n * 10n ** 18n
const PROFILE: CurveProfile = {
  virtualTokenReserves: T,
  virtualQuoteReserves: V,
  saleSupply: S,
}
const FEES: FeeBps = { protocolFeeBps: 95n, creatorFeeBps: 30n }

let anvil: AnvilHandle
let clients: DevClients
let live: ArcpadDeployment
let zeroCreator: ZeroCreatorDeployment

/**
 * COVERAGE COUNTERS. Faz 1c's invariant review measured a suite passing green
 * with its counters at zero, at which point it constrained nothing. Every
 * counter here is asserted > 0 at the end, and the failure message prints all
 * of them.
 */
const counts = {
  happyBuyExactQuoteIn: 0,
  happyBuyExactTokensOut: 0,
  happySellExactTokensIn: 0,
  clampedFills: 0,
  exactOutAtBoundary: 0,
  exactOutBeyondBoundary: 0,
  completions: 0,
  refundsNonZero: 0,
  refundsZero: 0,
  zeroCreatorTrades: 0,
  netTooSmallFromCorrection: 0,
  netTooSmallFromCurveTerm: 0,
  proceedsTooSmallReverts: 0,
  slippageBuyExactQuoteIn: 0,
  slippageBuyExactTokensOut: 0,
  slippageSellExactTokensIn: 0,
}

/** Which (entrypoint, scenario) cells were actually walked. */
const walked: Record<string, Record<string, number>> = {
  buyExactQuoteIn: { happy: 0, slippage: 0, complete: 0, zeroCreator: 0 },
  buyExactTokensOut: { happy: 0, slippage: 0, complete: 0, zeroCreator: 0 },
  sellExactTokensIn: { happy: 0, slippage: 0, complete: 0, zeroCreator: 0 },
}

/** A seeded LCG. Deterministic: a failing case is reproducible from the seed alone. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

async function readState(curve: Address): Promise<CurveState> {
  // Sequential reads, not `multicall`: a bare anvil has no Multicall3 and viem
  // refuses the call. Against a local devchain the six round trips are free.
  const read = async <T>(functionName: string): Promise<T> =>
    (await clients.publicClient.readContract({
      address: curve,
      abi: bondingCurveAbi,
      functionName: functionName as never,
    })) as T
  const vT = await read<bigint>('virtualTokenReserves')
  const vQ = await read<bigint>('virtualQuoteReserves')
  const rT = await read<bigint>('realTokenReserves')
  const rQ = await read<bigint>('realQuoteReserves')
  const complete = await read<boolean>('complete')
  const creator = await read<Address>('creator')
  return {
    virtualTokenReserves: vT,
    virtualQuoteReserves: vQ,
    realTokenReserves: asTok(rT),
    realQuoteReserves: asWei(rQ),
    complete,
    creator,
  }
}

async function owed(escrow: Address, who: Address): Promise<bigint> {
  return (await clients.publicClient.readContract({
    address: escrow,
    abi: feeEscrowAbi,
    functionName: 'owed',
    args: [who],
  })) as bigint
}

type Executed = {
  readonly trade: {
    isBuy: boolean
    tokenAmount: bigint
    quoteAmount: bigint
    protocolFee: bigint
    creatorFee: bigint
    virtualTokenReserves: bigint
    virtualQuoteReserves: bigint
    realTokenReserves: bigint
    realQuoteReserves: bigint
  }
  readonly gasCost: bigint
  readonly balanceDelta: bigint
}

/** Sends the plan's calldata verbatim and returns what the chain did. */
async function execute(curve: Address, plan: TradePlan): Promise<Executed> {
  const before = await clients.publicClient.getBalance({ address: devAccount.address })
  // The params are cast as a whole: `plan.action` is a UNION of two payable
  // entrypoints and one nonpayable one, and viem narrows `value` to
  // `undefined` across that union. The runtime value is correct -- a sell
  // plans `value: 0n` -- and the differential below asserts the balance delta,
  // which is what would catch it if it were not.
  const hash = await clients.wallet.writeContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: plan.action,
    // The plan's args go in VERBATIM. Reshaping them here would test a
    // different transaction than the one the UI will send.
    args: plan.args,
    value: plan.value,
    account: devAccount,
    chain: foundry,
  } as never)
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${plan.action} reverted on chain`)
  const after = await clients.publicClient.getBalance({ address: devAccount.address })
  const logs = parseEventLogs({ abi: bondingCurveAbi, eventName: 'Trade', logs: receipt.logs })
  const event = logs[0]
  if (!event) throw new Error(`${plan.action} emitted no Trade event`)
  return {
    trade: event.args as Executed['trade'],
    gasCost: receipt.gasUsed * receipt.effectiveGasPrice,
    balanceDelta: after - before,
  }
}

/** Runs a plan and asserts EVERY field the plan promised against the chain. */
async function differential(
  deployment: { curve: Address; escrow: Address; treasury: Address; creator: Address },
  before: CurveState,
  plan: TradePlan,
  label: string,
): Promise<void> {
  const treasuryBefore = await owed(deployment.escrow, deployment.treasury)
  const creatorBefore =
    deployment.creator === ZERO_ADDRESS ? 0n : await owed(deployment.escrow, deployment.creator)

  const { trade, gasCost, balanceDelta } = await execute(deployment.curve, plan)

  expect(trade.quoteAmount, `${label}: curveAmount`).toBe(plan.curveAmount)
  expect(trade.protocolFee, `${label}: protocolFee`).toBe(plan.protocolFee)
  expect(trade.creatorFee, `${label}: creatorFee`).toBe(plan.creatorFee)
  expect(trade.tokenAmount, `${label}: tokens`).toBe(plan.tokens)
  expect(trade.isBuy, `${label}: direction`).toBe(plan.action !== 'sellExactTokensIn')

  // ALL FOUR RESERVES, computed from the PRE-TRADE state and the plan.
  //
  // The trade figures can agree while the ledger diverges, and the ledger is
  // what the NEXT quote is computed from -- so a curve that pays correctly
  // once and then books wrong is exactly the failure this catches. The
  // expected values are derived here rather than read back from the event,
  // which would compare the chain against itself.
  const isSell = plan.action === 'sellExactTokensIn'
  const signedQuote = isSell ? -plan.curveAmount : plan.curveAmount
  const signedTokens = isSell ? plan.tokens : -plan.tokens
  expect(trade.virtualQuoteReserves, `${label}: virtualQuoteReserves`).toBe(
    before.virtualQuoteReserves + signedQuote,
  )
  expect(trade.virtualTokenReserves, `${label}: virtualTokenReserves`).toBe(
    before.virtualTokenReserves + signedTokens,
  )
  expect(trade.realTokenReserves, `${label}: realTokenReserves`).toBe(
    before.realTokenReserves + signedTokens,
  )
  expect(trade.realQuoteReserves, `${label}: realQuoteReserves`).toBe(
    before.realQuoteReserves + signedQuote,
  )

  // ...and the two DISPLAY figures the plan promised about the state after.
  expect(trade.realTokenReserves === 0n, `${label}: completesCurve`).toBe(plan.completesCurve)

  // The escrow received exactly the two parts, deposited separately.
  const treasuryAfter = await owed(deployment.escrow, deployment.treasury)
  expect(treasuryAfter - treasuryBefore, `${label}: escrow protocol share`).toBe(plan.protocolFee)
  if (deployment.creator !== ZERO_ADDRESS) {
    const creatorAfter = await owed(deployment.escrow, deployment.creator)
    expect(creatorAfter - creatorBefore, `${label}: escrow creator share`).toBe(plan.creatorFee)
  } else {
    expect(plan.creatorFee, `${label}: zero creator charges nothing`).toBe(0n)
  }

  // THE REFUND PATH, measured through the trader's own balance.
  const expected =
    plan.action === 'sellExactTokensIn'
      ? plan.curveAmount - plan.protocolFee - plan.creatorFee - gasCost
      : -(plan.curveAmount + plan.protocolFee + plan.creatorFee) - gasCost
  expect(balanceDelta, `${label}: native balance delta`).toBe(expected)

  if (plan.action !== 'sellExactTokensIn') {
    if (plan.refund === 0n) counts.refundsZero += 1
    else counts.refundsNonZero += 1
  }
}

beforeAll(async () => {
  anvil = await startAnvil()
  clients = devClients(anvil.rpcUrl)
  live = await deployArcpad(anvil.rpcUrl, PROFILE)
  zeroCreator = await deployZeroCreatorCurve(anvil.rpcUrl, PROFILE)
}, 300_000)

afterAll(async () => {
  await anvil?.stop()
})

describe('the deployment is what it claims to be', () => {
  it('the factory reports the profile it was given, T before V', async () => {
    const state = await readState(live.curve)
    // A FRESH curve: vT - rT == T - S and vQ - rQ == V. This is the identity
    // that a swapped T/V would break, and it is checked against the CHAIN.
    expect(state.virtualTokenReserves - state.realTokenReserves).toBe(T - S)
    expect(state.virtualQuoteReserves - state.realQuoteReserves).toBe(V)
    expect(state.realTokenReserves).toBe(S)
    expect(state.realQuoteReserves).toBe(0n)
    expect(state.complete).toBe(false)
  })

  it('the zero-creator fixture really has no creator', async () => {
    const state = await readState(zeroCreator.curve)
    expect(getAddress(state.creator)).toBe(ZERO_ADDRESS)
    expect(state.realTokenReserves).toBe(S)
  })

  it('the live curve DOES have a creator, so the two fixtures differ', async () => {
    const state = await readState(live.curve)
    expect(getAddress(state.creator)).toBe(devAccount.address)
    expect(getAddress(state.creator)).not.toBe(ZERO_ADDRESS)
  })
})

describe('TRADE_ACTIONS is derived from the ABI, not counted by hand', () => {
  /**
   * "A property closed on one path looks closed on all of them" -- nine
   * instances in Faz 1c, six of them in code written to close an earlier one.
   * The defence is to stop counting the matrix by hand: take the entrypoint set
   * FROM THE COMPILED ABI and require exact equality.
   */
  it('the three planners cover exactly the curve trade entrypoints', () => {
    const EXCLUDED = {
      // The factory's internal step during `launch`, not a user path.
      bind: 'called only by the factory, inside launch',
      // The keeper's terminal call, not a trade. It moves no quote for a user
      // and takes no `msg.value`.
      graduate: 'the curve exit, called by the keeper and only when complete',
    } as const

    const fromAbi = bondingCurveAbi
      .filter((e): e is typeof e & { name: string } => {
        if (e.type !== 'function') return false
        // Widened deliberately: this ABI has no `pure` members today, so tsc
        // narrows the literal comparison away -- and the filter would then be
        // silently wrong the day one appears.
        const mutability: string = e.stateMutability
        if (mutability === 'view' || mutability === 'pure') return false
        return !(e.name in EXCLUDED)
      })
      .map((e) => e.name)
      .sort()

    // Anti-vacuity: the filter found something, and it found the exclusions too.
    expect(fromAbi.length).toBe(3)
    for (const excluded of Object.keys(EXCLUDED)) {
      expect(bondingCurveAbi.some((e) => e.type === 'function' && e.name === excluded)).toBe(true)
    }
    expect([...TRADE_ACTIONS].sort()).toEqual(fromAbi)
  })
})

describe('the differential: 300+ cases across three entrypoints', () => {
  it('every plan executes and every field agrees with the chain', async () => {
    const random = rng(0xa4cbad)
    let cases = 0

    // --- buyExactQuoteIn, ordinary budgets -------------------------------
    for (let i = 0; i < 110; i += 1) {
      const state = await readState(live.curve)
      if (state.complete) break
      // Quantised budgets, because that is all the UI can produce.
      const micro = BigInt(1 + Math.floor(random() * 40_000))
      const gross = micro * 10n ** 12n
      const plan = planBuyExactQuoteIn(state, PROFILE, FEES, gross, 0)
      if (plan.clamped) counts.clampedFills += 1
      await differential(live, state, plan, `buyExactQuoteIn#${i} gross=${gross}`)
      counts.happyBuyExactQuoteIn += 1
      walked.buyExactQuoteIn!.happy! += 1
      cases += 1
    }

    // --- buyExactTokensOut ------------------------------------------------
    for (let i = 0; i < 110; i += 1) {
      const state = await readState(live.curve)
      if (state.complete) break
      const tokens = BigInt(1 + Math.floor(random() * 2_000_000)) * 10n ** 18n
      if (tokens > state.realTokenReserves) continue
      const plan = planBuyExactTokensOut(state, PROFILE, FEES, tokens, 0)
      await differential(live, state, plan, `buyExactTokensOut#${i} tokens=${tokens}`)
      counts.happyBuyExactTokensOut += 1
      walked.buyExactTokensOut!.happy! += 1
      cases += 1
    }

    // --- sellExactTokensIn ------------------------------------------------
    for (let i = 0; i < 110; i += 1) {
      const state = await readState(live.curve)
      if (state.complete) break
      const held = (await clients.publicClient.readContract({
        address: live.token,
        abi: [
          {
            type: 'function',
            name: 'balanceOf',
            inputs: [{ type: 'address' }],
            outputs: [{ type: 'uint256' }],
            stateMutability: 'view',
          },
        ] as const,
        functionName: 'balanceOf',
        args: [devAccount.address],
      })) as bigint
      if (held < 10n ** 18n) break
      const tokensIn = (held * BigInt(1 + Math.floor(random() * 40))) / 10_000n
      if (tokensIn === 0n) continue
      await approve(live.token, live.curve, tokensIn)
      const state2 = await readState(live.curve)
      const plan = planSellExactTokensIn(state2, PROFILE, FEES, tokensIn, 0)
      await differential(live, state2, plan, `sellExactTokensIn#${i} tokensIn=${tokensIn}`)
      counts.happySellExactTokensIn += 1
      walked.sellExactTokensIn!.happy! += 1
      cases += 1
    }

    // AT ZERO SLIPPAGE NOTHING ABOVE MAY REVERT. This is the only real test of
    // the fee-inclusive/exclusive asymmetry: a `maxQuoteIn` computed without
    // fees would make `total > maxQuoteIn` and the chain would answer
    // `SlippageExceeded()` on every buyExactTokensOut above.
    expect(cases).toBeGreaterThanOrEqual(300)
  })
})

async function approve(token: Address, spender: Address, amount: bigint): Promise<void> {
  const hash = await clients.wallet.writeContract({
    address: token,
    abi: [
      {
        type: 'function',
        name: 'approve',
        inputs: [{ type: 'address' }, { type: 'uint256' }],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ] as const,
    functionName: 'approve',
    args: [spender, amount],
    account: devAccount,
    chain: foundry,
  })
  await clients.publicClient.waitForTransactionReceipt({ hash })
}

describe('the guards revert on chain exactly where the planner says they will', () => {
  it('SLIPPAGE: each of the three entrypoints reverts on its own guard', async () => {
    // THREE SEPARATE CASES. The guards are three different arguments on three
    // different entrypoints; a revert proved on one says nothing about the
    // other two.
    const state = await readState(live.curve)

    // buyExactQuoteIn: minTokensOut set ABOVE what the budget can buy.
    const buyIn = planBuyExactQuoteIn(state, PROFILE, FEES, 10n ** 15n, 0)
    await expect(
      sendRaw(live.curve, 'buyExactQuoteIn', [buyIn.tokens + 1n], buyIn.value),
    ).rejects.toThrow(/SlippageExceeded/)
    counts.slippageBuyExactQuoteIn += 1
    walked.buyExactQuoteIn!.slippage! += 1

    // buyExactTokensOut: maxQuoteIn set one wei BELOW the fee-inclusive total.
    const state2 = await readState(live.curve)
    const buyOut = planBuyExactTokensOut(state2, PROFILE, FEES, 10n ** 21n, 0)
    const total = buyOut.curveAmount + buyOut.protocolFee + buyOut.creatorFee
    await expect(
      sendRaw(live.curve, 'buyExactTokensOut', [buyOut.tokens, total - 1n], buyOut.value),
    ).rejects.toThrow(/SlippageExceeded/)
    counts.slippageBuyExactTokensOut += 1
    walked.buyExactTokensOut!.slippage! += 1

    // sellExactTokensIn: minQuoteOut set ABOVE the net the seller receives.
    const state3 = await readState(live.curve)
    const held = await balanceOf(live.token, devAccount.address)
    const tokensIn = held / 100n
    await approve(live.token, live.curve, tokensIn)
    const sell = planSellExactTokensIn(state3, PROFILE, FEES, tokensIn, 0)
    const net = sell.curveAmount - sell.protocolFee - sell.creatorFee
    await expect(
      sendRaw(live.curve, 'sellExactTokensIn', [tokensIn, net + 1n], 0n),
    ).rejects.toThrow(/SlippageExceeded/)
    counts.slippageSellExactTokensIn += 1
    walked.sellExactTokensIn!.slippage! += 1
  })

  /**
   * NetTooSmall HAS TWO THROW SITES AND THEY ARE WALKED SEPARATELY.
   *
   * Step 3 (`overshoot >= net`) and step 4 (`net <= 1`) are different lines in
   * different functions, and the inputs that reach them INTERLEAVE: 1 and 3 hit
   * step 4, 2 hits step 3. A test that only tried "a very small number" would
   * walk one site and report the property as covered.
   */
  it('NET TOO SMALL: both throw sites, and gross = 4 passes', async () => {
    const fresh = await deployArcpad(anvil.rpcUrl, PROFILE)

    // Step 4 -- the corrected net is 0 and 1 respectively.
    for (const gross of [1n, 3n]) {
      const state = await readState(fresh.curve)
      expect(() => planBuyExactQuoteIn(state, PROFILE, FEES, gross, 0)).toThrow('NetTooSmall')
      await expect(sendRaw(fresh.curve, 'buyExactQuoteIn', [0n], gross)).rejects.toThrow(
        /NetTooSmall/,
      )
      counts.netTooSmallFromCurveTerm += 1
    }

    // Step 3 -- both ceils together overshoot the whole budget.
    const state = await readState(fresh.curve)
    expect(() => planBuyExactQuoteIn(state, PROFILE, FEES, 2n, 0)).toThrow('NetTooSmall')
    await expect(sendRaw(fresh.curve, 'buyExactQuoteIn', [0n], 2n)).rejects.toThrow(/NetTooSmall/)
    counts.netTooSmallFromCorrection += 1

    // gross = 4 is the first that PASSES, and it buys 249_999_999 base units.
    // Derived by hand: net = 2, tokens = floor(1 * T / (V + 1)).
    const before = await readState(fresh.curve)
    const plan = planBuyExactQuoteIn(before, PROFILE, FEES, 4n, 0)
    expect(plan.tokens).toBe(249_999_999n)
    await differential(fresh, before, plan, 'gross=4 boundary')
  })

  /**
   * THE ProceedsTooSmall BOUNDARY, BOTH SIDES. Measured on the state after a
   * 1.000000 USDC buy on a fresh curve: the last rejected `tokensIn` is
   * 495_643_839 and the first accepted is 495_643_840.
   */
  it('PROCEEDS TOO SMALL: the exact boundary, refused and accepted', async () => {
    const fresh = await deployArcpad(anvil.rpcUrl, PROFILE)
    const start = await readState(fresh.curve)
    const buy = planBuyExactQuoteIn(start, PROFILE, FEES, 10n ** 18n, 0)
    await differential(fresh, start, buy, 'seed for the proceeds boundary')

    const state = await readState(fresh.curve)
    expect(() => planSellExactTokensIn(state, PROFILE, FEES, 495_643_839n, 0)).toThrow(
      'ProceedsTooSmall',
    )
    await approve(fresh.token, fresh.curve, 495_643_840n)
    await expect(sendRaw(fresh.curve, 'sellExactTokensIn', [495_643_839n, 0n], 0n)).rejects.toThrow(
      /ProceedsTooSmall/,
    )
    counts.proceedsTooSmallReverts += 1

    // ...and one base unit more is accepted, by BOTH the planner and the chain.
    const before = await readState(fresh.curve)
    const sell = planSellExactTokensIn(before, PROFILE, FEES, 495_643_840n, 0)
    await differential(fresh, before, sell, 'first accepted sale')
  })
})

describe('quantisation makes two revert classes structurally unreachable', () => {
  /**
   * TASK 2 MEETS TASK 4, ON REAL BYTECODE.
   *
   * The smallest input the UI can produce is 0.000001 USDC = 1e12 wei, twelve
   * orders of magnitude above NetTooSmall's 3-wei ceiling. This is a
   * MEASUREMENT, not a comment -- and it BREAKS if quantisation is ever
   * loosened, which is exactly the point.
   */
  it('the smallest input the UI can produce executes and buys real tokens', async () => {
    const fresh = await deployArcpad(anvil.rpcUrl, PROFILE)
    const min = parseUsdcAmount('0.000001')
    expect(min.ok).toBe(true)
    if (!min.ok) throw new Error('unreachable')
    expect(min.value).toBe(10n ** 12n)

    const before = await readState(fresh.curve)
    const plan = planBuyExactQuoteIn(before, PROFILE, FEES, min.value, 0)
    // Derived by hand from the four steps, not read back from the planner.
    expect(plan.tokens).toBe(246_913_523_427_951_928_356n)
    await differential(fresh, before, plan, 'quantised minimum')
  })
})

describe('the boundary, the clamp, and what a completed curve refuses', () => {
  it('exact-out AT the reserve passes and BEYOND it reverts', async () => {
    const fresh = await deployArcpad(anvil.rpcUrl, PROFILE)
    const state = await readState(fresh.curve)

    // One past the reserve: the planner refuses, and so does the chain.
    expect(() =>
      planBuyExactTokensOut(state, PROFILE, FEES, state.realTokenReserves + 1n, 0),
    ).toThrow('NotEnoughTokensToBuy')
    await expect(
      sendRaw(
        fresh.curve,
        'buyExactTokensOut',
        [state.realTokenReserves + 1n, 100n * 10n ** 18n],
        100n * 10n ** 18n,
      ),
    ).rejects.toThrow(/NotEnoughTokensToBuy/)
    counts.exactOutBeyondBoundary += 1

    // EXACTLY the reserve: passes, and completes the curve.
    const plan = planBuyExactTokensOut(state, PROFILE, FEES, state.realTokenReserves, 0)
    expect(plan.curveAmount).toBe(12_161_433_369_060_378_707n) // R + 1
    expect(plan.completesCurve).toBe(true)
    await differential(fresh, state, plan, 'exact-out at the boundary')
    counts.exactOutAtBoundary += 1
    walked.buyExactTokensOut!.complete! += 1

    const after = await readState(fresh.curve)
    expect(after.realTokenReserves).toBe(0n)
    expect(after.complete).toBe(true)
    counts.completions += 1

    // ALL THREE ENTRYPOINTS refuse a completed curve, and each is asserted.
    await expect(sendRaw(fresh.curve, 'buyExactQuoteIn', [0n], 10n ** 15n)).rejects.toThrow(
      /CurveComplete/,
    )
    walked.buyExactQuoteIn!.complete! += 1
    await expect(
      sendRaw(fresh.curve, 'buyExactTokensOut', [1n, 10n ** 15n], 10n ** 15n),
    ).rejects.toThrow(/CurveComplete/)
    await approve(fresh.token, fresh.curve, 10n ** 18n)
    await expect(sendRaw(fresh.curve, 'sellExactTokensIn', [10n ** 18n, 0n], 0n)).rejects.toThrow(
      /CurveComplete/,
    )
    walked.sellExactTokensIn!.complete! += 1

    // ...and the planner agrees, without a transaction.
    for (const check of [
      () => planBuyExactQuoteIn(after, PROFILE, FEES, 10n ** 15n, 0),
      () => planBuyExactTokensOut(after, PROFILE, FEES, 1n, 0),
      () => planSellExactTokensIn(after, PROFILE, FEES, 1n, 0),
    ]) {
      expect(check).toThrow('CurveComplete')
    }
  })

  /**
   * THE CLAMP -- the branch that exists on `buyExactQuoteIn` and nowhere else,
   * and that pump.fun does not offer at this entrypoint.
   */
  it('a budget beyond the reserve CLAMPS, refunds, and completes', async () => {
    const fresh = await deployArcpad(anvil.rpcUrl, PROFILE)
    const before = await readState(fresh.curve)
    const plan = planBuyExactQuoteIn(before, PROFILE, FEES, 20n * 10n ** 18n, 0)
    expect(plan.clamped).toBe(true)
    expect(plan.tokens).toBe(S)
    expect(plan.curveAmount).toBe(12_161_433_369_060_378_707n)
    expect(plan.refund).toBe(7_686_548_713_826_366_558n)
    await differential(fresh, before, plan, 'clamped fill')
    counts.clampedFills += 1
    counts.completions += 1
    walked.buyExactQuoteIn!.complete! += 1

    const after = await readState(fresh.curve)
    expect(after.realTokenReserves).toBe(0n)
    expect(after.complete).toBe(true)
  })
})

describe('a curve with NO creator, on all three entrypoints', () => {
  /**
   * Faz 1c measured the `buyExactQuoteIn` x `creator == 0` cell as NEVER WALKED
   * on the contract, and dropping the ternary broke that entrypoint
   * permanently. Three separate executions here, because one does not cover
   * another.
   */
  it('charges no creator fee and leaves the protocol share intact', async () => {
    // buyExactQuoteIn
    const s1 = await readState(zeroCreator.curve)
    const p1 = planBuyExactQuoteIn(s1, PROFILE, FEES, 10n ** 18n, 0)
    expect(p1.creatorFee).toBe(0n)
    // The net is computed at 95 bps rather than 125, so it is LARGER.
    expect(p1.curveAmount).toBe(990_589_400_693_412_580n)
    expect(p1.protocolFee).toBe(9_410_599_306_587_420n)
    const e1 = await execute(zeroCreator.curve, p1)
    expect(e1.trade.creatorFee).toBe(0n)
    expect(e1.trade.quoteAmount).toBe(p1.curveAmount)
    expect(e1.trade.protocolFee).toBe(p1.protocolFee)
    expect(e1.trade.tokenAmount).toBe(p1.tokens)
    counts.zeroCreatorTrades += 1
    walked.buyExactQuoteIn!.zeroCreator! += 1

    // buyExactTokensOut
    const s2 = await readState(zeroCreator.curve)
    const p2 = planBuyExactTokensOut(s2, PROFILE, FEES, 10n ** 24n, 0)
    expect(p2.creatorFee).toBe(0n)
    const e2 = await execute(zeroCreator.curve, p2)
    expect(e2.trade.creatorFee).toBe(0n)
    expect(e2.trade.quoteAmount).toBe(p2.curveAmount)
    expect(e2.trade.protocolFee).toBe(p2.protocolFee)
    counts.zeroCreatorTrades += 1
    walked.buyExactTokensOut!.zeroCreator! += 1

    // sellExactTokensIn
    const held = await balanceOf(zeroCreator.token, devAccount.address)
    const tokensIn = held / 4n
    await approve(zeroCreator.token, zeroCreator.curve, tokensIn)
    const s3 = await readState(zeroCreator.curve)
    const p3 = planSellExactTokensIn(s3, PROFILE, FEES, tokensIn, 0)
    expect(p3.creatorFee).toBe(0n)
    const e3 = await execute(zeroCreator.curve, p3)
    expect(e3.trade.creatorFee).toBe(0n)
    expect(e3.trade.quoteAmount).toBe(p3.curveAmount)
    expect(e3.trade.protocolFee).toBe(p3.protocolFee)
    counts.zeroCreatorTrades += 1
    walked.sellExactTokensIn!.zeroCreator! += 1
  })
})

describe('coverage', () => {
  /**
   * A ZERO COUNTER FAILS THE SUITE.
   *
   * Faz 1c's invariant review measured a suite passing green with its counters
   * at zero, at which point it constrained nothing at all. The message prints
   * EVERY counter, so a failure says which branch stopped being walked rather
   * than only that one did.
   */
  it('every branch this suite claims to cover was actually walked', () => {
    const report = JSON.stringify(counts, null, 2)
    for (const [name, value] of Object.entries(counts)) {
      expect(value, `${name} was never walked. All counters:\n${report}`).toBeGreaterThan(0)
    }
  })

  it('every (entrypoint, scenario) cell was walked', () => {
    const report = JSON.stringify(walked, null, 2)
    for (const action of TRADE_ACTIONS) {
      for (const cell of ['happy', 'slippage', 'complete', 'zeroCreator']) {
        expect(
          walked[action]?.[cell],
          `${action} x ${cell} was never walked. All cells:\n${report}`,
        ).toBeGreaterThan(0)
      }
    }
  })
})

describe('this file is actually run somewhere', () => {
  it('a CI job runs test:chain after building the contracts', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/node.yml'), 'utf8')
    const commands = workflow
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .map((line) => /^\s*(?:-\s+)?run:\s*(\S.*?)\s*$/.exec(line)?.[1])
      .filter((command): command is string => command !== undefined)
    expect(commands.length).toBeGreaterThan(5)
    expect(commands).toContain('pnpm --filter @arcpad/shared test:chain')
    expect(commands).toContain('forge build --root contracts')
  })

  it('...and it is NOT in the default vitest include, in either direction', () => {
    // Two-way: it must not run without anvil, and it must not run NOWHERE.
    const config = readFileSync(join(REPO_ROOT, 'packages/shared/vitest.config.ts'), 'utf8')
    expect(config).toContain("'test/chain/**'")
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/shared/package.json'), 'utf8'),
    ) as { scripts: Record<string, string>; exports: Record<string, string> }
    expect(pkg.scripts['test:chain']).toBeDefined()
    expect(pkg.scripts.test).not.toContain('chain')
    expect(pkg.exports['./devchain']).toBe('./src/devchain.ts')
  })
})

/** Sends raw calldata WITHOUT a plan, for the cases that must revert. */
async function sendRaw(
  curve: Address,
  fn: 'buyExactQuoteIn' | 'buyExactTokensOut' | 'sellExactTokensIn',
  args: readonly bigint[],
  value: bigint,
): Promise<void> {
  // `simulateContract`, so the revert DATA comes back decoded. Sending and
  // reading the receipt would only say "reverted", and the whole point of these
  // cases is WHICH guard fired.
  await clients.publicClient.simulateContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: fn,
    args,
    value,
    account: devAccount,
  } as never)
}

async function balanceOf(token: Address, who: Address): Promise<bigint> {
  return (await clients.publicClient.readContract({
    address: token,
    abi: [
      {
        type: 'function',
        name: 'balanceOf',
        inputs: [{ type: 'address' }],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
      },
    ] as const,
    functionName: 'balanceOf',
    args: [who],
  })) as bigint
}
