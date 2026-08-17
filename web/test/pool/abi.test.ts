import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARCPAD_ERROR_ABI } from '@arcpad/shared/browser'
import { encodeErrorResult, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  decodePoolSwapError,
  isUsdcAllowanceString,
  poolCoveredNames,
  poolErrorAbiNames,
} from '@/lib/poolOutcome'
import {
  ARCPAD_ROUTER_ABI,
  decodeQuoteResult,
  MEASURED_ROUTER_SELECTORS,
  MEASURED_USDC_ALLOWANCE_REVERT,
  POOL_BUBBLED_ERROR_ABI,
  POOL_SWAP_ERROR_ABI,
  poolRevertName,
  ROUTER_ERROR_ABI,
  ROUTER_QUOTE_FUNCTIONS,
  ROUTER_SWAP_FUNCTIONS,
  SWAP_ERC20_ERROR_NAMES,
} from '@/lib/routerAbi'

/**
 * ============ THE POOL SURFACE'S OWN COMPLETENESS GATE ============
 *
 * `test/errors/reconcile.test.ts` guards the six `ArcpadAction`s and
 * `test/token/graduation.test.ts` guards graduation. The pool is a THIRD
 * surface, and adding one without extending the gate to it is precisely how
 * this repository accumulated eleven instances of "covered on one entrypoint
 * reads as covered on all". This file is that gate.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const ARTIFACT = join(REPO_ROOT, 'contracts', 'out', 'ArcpadRouter.sol', 'ArcpadRouter.json')
const ARTIFACT_V4 = join(
  REPO_ROOT,
  'contracts',
  'out',
  'ArcpadRouter.sol',
  'ArcpadRouter.v4core.json',
)

type AbiEntry = { type: string; name?: string; inputs?: { type: string }[]; outputs?: unknown[] }

function compiled(path: string): AbiEntry[] {
  return JSON.parse(readFileSync(path, 'utf8')).abi as AbiEntry[]
}

describe('the hand-written router ABI agrees with a second source', () => {
  /**
   * PIN vs DERIVATION, WITH THE PINS MEASURED ON THE LIVE CHAIN.
   *
   * A misspelled name derives a WRONG selector, throws nothing, and silently
   * turns a real revert into "we have no text for this". Every value in
   * `MEASURED_ROUTER_SELECTORS` was read off `rpc.testnet.arc.io` on 2026-08-09
   * by `eth_call` against the deployed router `0x6D9f4270…`.
   */
  it('the selectors measured on chain are the ones this ABI derives', () => {
    const signatures: Record<keyof typeof MEASURED_ROUTER_SELECTORS, string> = {
      PoolNotInitialized: 'PoolNotInitialized()',
      BaseIsQuote: 'BaseIsQuote()',
      QuoteResult: 'QuoteResult(uint256,uint256)',
      DeadlinePassed: 'DeadlinePassed(uint256,uint256)',
      TooLittleReceived: 'TooLittleReceived(uint256,uint256)',
      TooMuchRequested: 'TooMuchRequested(uint256,uint256)',
    }
    for (const [name, measured] of Object.entries(MEASURED_ROUTER_SELECTORS)) {
      const signature = signatures[name as keyof typeof MEASURED_ROUTER_SELECTORS]
      expect(toFunctionSelector(signature), `${name} derives a different selector`).toBe(measured)
      expect(
        POOL_SWAP_ERROR_ABI.some((entry) => entry.name === name),
        `${name} is pinned but is not on the pool error surface`,
      ).toBe(true)
    }
  })

  /**
   * FULL PARITY, WHEN FOUNDRY OUTPUT IS ON DISK -- and BOTH DIRECTIONS.
   *
   * A missing name means an undecodable revert; an invented one means dead copy
   * that reads as coverage. The suite must still run on a machine without
   * Foundry, so a missing artifact prints an OPEN CELL rather than passing
   * quietly, exactly as the graduation gate does.
   */
  it('every error the compiled ArcpadRouter declares is on ROUTER_ERROR_ABI', () => {
    if (!existsSync(ARTIFACT)) {
      console.warn(
        '\n[web] OPEN CELL — contracts/out/ArcpadRouter.sol/ArcpadRouter.json is absent, so the ' +
          'hand-written router ABI was compared only against the pinned selectors. Run ' +
          '`forge build --root contracts` to close this cell.\n',
      )
      expect(ROUTER_ERROR_ABI.length).toBeGreaterThan(0)
      return
    }
    const declared = compiled(ARTIFACT)
      .filter((entry) => entry.type === 'error')
      .map((entry) => entry.name as string)
      .sort()
    expect(ROUTER_ERROR_ABI.map((entry) => entry.name).sort()).toEqual(declared)
  })

  /**
   * ARGUMENT TYPES TOO, NOT JUST NAMES.
   *
   * `DeadlinePassed()` and `DeadlinePassed(uint256,uint256)` are DIFFERENT
   * selectors. A name-only comparison would pass with every input list wrong
   * and every decode would then fail at run time, on the day it mattered.
   */
  it('the argument types agree, so the selectors do', () => {
    if (!existsSync(ARTIFACT)) return
    const byName = new Map(
      compiled(ARTIFACT)
        .filter((entry) => entry.type === 'error')
        .map((entry) => [entry.name as string, (entry.inputs ?? []).map((i) => i.type).join(',')]),
    )
    for (const entry of ROUTER_ERROR_ABI) {
      const ours = entry.inputs.map((input) => input.type).join(',')
      expect(byName.get(entry.name), `${entry.name} missing from the artifact`).toBe(ours)
    }
  })

  /**
   * THE FUNCTION SURFACE, AND ITS DELIBERATE SUBSET.
   *
   * The router exposes FOUR swap shapes; the panel surfaces three. That is a
   * product decision, not a missing capability, so the ABI is asserted to carry
   * all four -- otherwise "we chose not to show it" and "we forgot to add it"
   * would look the same from here.
   */
  it('all four swap shapes and all four quote shapes are callable', () => {
    if (!existsSync(ARTIFACT)) return
    const declared = new Set(
      compiled(ARTIFACT)
        .filter((entry) => entry.type === 'function')
        .map((entry) => entry.name as string),
    )
    for (const name of [...ROUTER_SWAP_FUNCTIONS, ...ROUTER_QUOTE_FUNCTIONS]) {
      expect(declared.has(name), `${name} is not on the compiled router`).toBe(true)
      expect(
        ARCPAD_ROUTER_ABI.some((entry) => entry.type === 'function' && entry.name === name),
        `${name} is not on our ABI`,
      ).toBe(true)
    }
    expect(ROUTER_SWAP_FUNCTIONS).toHaveLength(4)
    expect(ROUTER_QUOTE_FUNCTIONS).toHaveLength(4)
  })

  /**
   * THE ARGUMENT ORDER, BECAUSE GETTING IT WRONG IS SILENT AND EXPENSIVE.
   *
   * `buyExactIn(token, quoteIn, minTokensOut, to, deadline)` and
   * `buyExactOut(token, tokensOut, maxQuoteIn, to, deadline)` have the SAME
   * signature (`address,uint256,uint256,address,uint256`), so swapping the two
   * middle arguments produces a perfectly encodable call that means something
   * else: a slippage floor read as a budget. Only a positional comparison
   * against the artifact catches it.
   */
  it('every swap entrypoint takes (token, amount, bound, to, deadline) in that order', () => {
    if (!existsSync(ARTIFACT)) return
    const names = new Map(
      compiled(ARTIFACT)
        .filter((entry) => entry.type === 'function')
        .map((entry) => [
          entry.name as string,
          (entry.inputs ?? []).map((i) => (i as { name?: string }).name ?? ''),
        ]),
    )
    const expected: Record<string, string[]> = {
      buyExactIn: ['token', 'quoteIn', 'minTokensOut', 'to', 'deadline'],
      buyExactOut: ['token', 'tokensOut', 'maxQuoteIn', 'to', 'deadline'],
      sellExactIn: ['token', 'tokensIn', 'minQuoteOut', 'to', 'deadline'],
      sellExactOut: ['token', 'quoteOut', 'maxTokensIn', 'to', 'deadline'],
    }
    for (const [fn, order] of Object.entries(expected)) {
      expect(names.get(fn), `${fn} parameter order moved`).toEqual(order)
      const ours = ARCPAD_ROUTER_ABI.find(
        (entry) => entry.type === 'function' && entry.name === fn,
      ) as { inputs: { name: string }[] } | undefined
      expect(
        ours?.inputs.map((i) => i.name),
        `${fn} in OUR abi`,
      ).toEqual(order)
    }
  })

  /**
   * THE TWO COMPILATION UNITS AGREE.
   *
   * `out/` carries `ArcpadRouter.json` (800 optimizer runs) AND
   * `ArcpadRouter.v4core.json` (44444444) -- the router report records that the
   * deploy library imports `PoolDeployLib` precisely so the SHIPPED bytecode is
   * the 44444444 variant. The bytecode differs; the ABI must not, and if it
   * ever did, this file would be pinned to whichever one it happened to read.
   */
  it('both compilations of the router declare the same ABI', () => {
    if (!existsSync(ARTIFACT) || !existsSync(ARTIFACT_V4)) return
    const shape = (path: string) =>
      compiled(path)
        .map(
          (entry) =>
            `${entry.type} ${entry.name ?? ''}(${(entry.inputs ?? []).map((i) => i.type).join(',')})`,
        )
        .sort()
    expect(shape(ARTIFACT)).toEqual(shape(ARTIFACT_V4))
  })

  it('the ERC-20 half is TAKEN from the distributed ABI, not retyped', () => {
    for (const name of SWAP_ERC20_ERROR_NAMES) {
      const fromShared = ARCPAD_ERROR_ABI.find((entry) => entry.name === name)
      expect(fromShared, `${name} is not in ARCPAD_ERROR_ABI`).toBeDefined()
      expect(POOL_BUBBLED_ERROR_ABI).toContain(fromShared)
    }
  })

  /**
   * THE BUBBLED SET IS REAL, AND ITS MEMBERS COME FROM THE RIGHT CONTRACTS.
   *
   * `PoolNotInitialized` is not declared by the router, so a wallet decoding
   * with the router's own ABI alone would hand back undecodable data on the one
   * revert every arcpad token produces today.
   */
  it('the v4 and hook errors are ABSENT from the router artifact and PRESENT on our surface', () => {
    if (!existsSync(ARTIFACT)) return
    const declared = new Set(
      compiled(ARTIFACT)
        .filter((entry) => entry.type === 'error')
        .map((entry) => entry.name as string),
    )
    for (const name of ['PoolNotInitialized', 'SwapAmountCannotBeZero', 'ManagerLocked']) {
      expect(declared.has(name), `${name} is on the router artifact after all`).toBe(false)
      expect(POOL_SWAP_ERROR_ABI.some((entry) => entry.name === name)).toBe(true)
    }
  })
})

describe('every name the surface can carry has text', () => {
  it('no error on POOL_SWAP_ERROR_ABI falls through to "no text for this"', () => {
    let covered = 0
    for (const name of poolErrorAbiNames()) {
      const failure = decodePoolSwapError(revertedWith(name))
      expect(failure.name, `${name} did not decode`).toBe(name)
      expect(failure.title.length, `${name} has no title`).toBeGreaterThan(0)
      expect(failure.body.length, `${name} has no body`).toBeGreaterThan(0)
      expect(failure.remedy, `${name} has no remedy`).not.toBe('')
      expect(failure.code, `${name} has no text`).not.toBe('unknown')
      covered += 1
    }
    // ANTI-VACUITY: an empty ABI would satisfy the loop trivially.
    expect(covered).toBe(POOL_SWAP_ERROR_ABI.length)
    expect(covered).toBeGreaterThan(20)
  })

  it('the dictionary claims nothing the ABI cannot produce', () => {
    const onAbi = new Set(poolErrorAbiNames())
    const invented = poolCoveredNames().filter((name) => !onAbi.has(name))
    expect(invented, 'dead rows read as coverage').toEqual([])
  })

  it('an unmodelled selector is LOUD, never silent', () => {
    const failure = decodePoolSwapError({ cause: { data: '0xdeadbeef' } })
    expect(failure.code).toBe('unknown')
    expect(failure.showRaw).toBe(true)
  })
})

describe('PoolNotInitialized is the state of every token today, and must not read as a fault', () => {
  /**
   * MEASURED 2026-08-09 by `eth_call` against the live router with both
   * production tokens: `quoteBuyExactIn(token, 1_000_000)` -> `0x486aa307`.
   * Nothing has graduated on any chain, so this is the ONLY pool state a user
   * can reach today. Painting it red would report a healthy system as broken.
   */
  it('it is a NOT-YET, with no blame and no action', () => {
    const failure = decodePoolSwapError(revertedWith('PoolNotInitialized'))
    expect(failure.code).toBe('no-pool')
    expect(failure.tone).not.toBe('error')
    expect(`${failure.title} ${failure.body}`).toMatch(/not graduated|no pool/i)
    expect(failure.body).toMatch(/nothing is wrong|nothing is stuck/i)
  })

  it('CONTROL: a genuine wiring fault IS an error', () => {
    // Without this the assertion above could be satisfied by making every
    // failure neutral, which would lose the whole signal.
    const failure = decodePoolSwapError(revertedWith('NotPoolManager'))
    expect(failure.tone).toBe('error')
    expect(failure.code).toBe('operator')
  })
})

describe('THE TRAP: the two legs fail in two different wire shapes', () => {
  /**
   * MEASURED against the LIVE USDC at `0x3600…0000` with the live router as
   * `msg.sender` and no allowance:
   *
   *   transferFrom(0xe92c64C4…, router, 1)
   *     -> 0x08c379a0…  Error(string) "ERC20: transfer amount exceeds allowance"
   *
   * Arc's USDC is a Circle FiatToken, NOT an OpenZeppelin ERC-20. So the BUY
   * leg's allowance shortfall carries no selector at all while the SELL leg's
   * carries `ERC20InsufficientAllowance`. A surface that handled only the
   * custom error would tell a buyer "the chain refused this transaction" and
   * never mention the Approve button.
   */
  it('the SELL leg: a custom error names the approval', () => {
    const failure = decodePoolSwapError(revertedWith('ERC20InsufficientAllowance'))
    expect(failure.code).toBe('not-approved')
    expect(failure.remedy).toMatch(/approve/i)
  })

  it('the BUY leg: the live USDC STRING names the approval too', () => {
    const failure = decodePoolSwapError({
      shortMessage: `Execution reverted with reason: ${MEASURED_USDC_ALLOWANCE_REVERT}.`,
      cause: { message: `execution reverted: ${MEASURED_USDC_ALLOWANCE_REVERT}` },
    })
    expect(failure.code).toBe('not-approved')
    expect(failure.remedy).toMatch(/approve/i)
    // And it QUOTES the chain rather than paraphrasing it.
    expect(failure.body).toContain(MEASURED_USDC_ALLOWANCE_REVERT)
  })

  it('CONTROL: an unrelated string revert is NOT read as an allowance problem', () => {
    // Without this the matcher could be `() => true` and both assertions above
    // would still pass.
    expect(isUsdcAllowanceString(MEASURED_USDC_ALLOWANCE_REVERT)).toBe(true)
    expect(isUsdcAllowanceString('Zero address not allowed')).toBe(false)
    const failure = decodePoolSwapError({
      cause: { message: 'execution reverted: Zero address not allowed' },
    })
    expect(failure.code).not.toBe('not-approved')
    expect(failure.body).toBe('Zero address not allowed')
  })
})

describe('a quote arrives as a revert, and only the quote decoder may read it', () => {
  const QUOTE = encodeErrorResult({
    abi: ROUTER_ERROR_ABI,
    errorName: 'QuoteResult',
    args: [1_000_000n, 17_012_345_678_901_234_567n],
  } as Parameters<typeof encodeErrorResult>[0])

  it('raw revert bytes decode to the pair', () => {
    expect(QUOTE.slice(0, 10)).toBe(MEASURED_ROUTER_SELECTORS.QuoteResult)
    expect(decodeQuoteResult({ cause: { data: QUOTE } })).toEqual({
      amountIn: 1_000_000n,
      amountOut: 17_012_345_678_901_234_567n,
    })
  })

  it('a viem-decoded revert object decodes to the same pair', () => {
    expect(
      decodeQuoteResult({
        cause: {
          data: { errorName: 'QuoteResult', args: [1_000_000n, 17_012_345_678_901_234_567n] },
        },
      }),
    ).toEqual({ amountIn: 1_000_000n, amountOut: 17_012_345_678_901_234_567n })
  })

  /**
   * THE FAILURE THAT WOULD BE SILENT: a REAL revert read as a quote.
   *
   * `LegSignsUnexpected(int256,int256)` is the only other 68-byte revert on
   * this surface -- the same shape the contract's own mutation campaign found
   * to be the single thing separating `_decodeQuote`'s selector check from dead
   * weight. If `decodeQuoteResult` matched on LENGTH it would report a refused
   * dust sell as "you receive -1".
   */
  it('a 68-byte revert that is NOT a quote returns null', () => {
    const legs = encodeErrorResult({
      abi: ROUTER_ERROR_ABI,
      errorName: 'LegSignsUnexpected',
      args: [56n, -1_000_000_000_000_000_000_000n],
    } as Parameters<typeof encodeErrorResult>[0])
    expect(legs.length).toBe(QUOTE.length)
    expect(decodeQuoteResult({ cause: { data: legs } })).toBeNull()
    expect(poolRevertName({ cause: { data: legs } })).toBe('LegSignsUnexpected')
    expect(decodePoolSwapError({ cause: { data: legs } }).code).toBe('dust')
  })

  it('a 4-byte revert returns null too', () => {
    expect(
      decodeQuoteResult({ cause: { data: MEASURED_ROUTER_SELECTORS.PoolNotInitialized } }),
    ).toBeNull()
  })
})

function revertedWith(errorName: string): unknown {
  const entry = POOL_SWAP_ERROR_ABI.find((e) => e.name === errorName)
  const args = (entry?.inputs ?? []).map((input) =>
    input.type === 'address'
      ? '0x0000000000000000000000000000000000000001'
      : input.type.startsWith('int')
        ? -1n
        : 1n,
  )
  const data = encodeErrorResult({
    abi: POOL_SWAP_ERROR_ABI,
    errorName,
    ...(args.length > 0 ? { args } : {}),
  } as Parameters<typeof encodeErrorResult>[0])
  return { cause: { data } }
}
