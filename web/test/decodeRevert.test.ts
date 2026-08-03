import { ARCPAD_ERROR_ABI } from '@arcpad/shared/browser'
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  UserRejectedRequestError,
} from 'viem'
import { describe, expect, it } from 'vitest'
import {
  asTok,
  asWei,
  planBuyExactQuoteIn,
  planBuyExactTokensOut,
  planSellExactTokensIn,
} from '@arcpad/shared/browser'
import { type ArcpadAction, decodeArcpadError } from '../lib/decodeRevert'
import {
  ARCPAD_ACTIONS,
  errorNameOf,
  FAILURE_TABLE,
  UNREACHABLE_BY_CONSTRUCTION,
} from '../lib/failureTable'

/**
 * A revert selector is four bytes of a signature hash. It does not say which
 * contract, which layer, or what the user was doing. So the decoder is keyed on
 * `(action, errorName)`, and these tests are written per ACTION rather than
 * once for "a buy": the curve has THREE entrypoints and a property proved on
 * one of them is not proved on the others.
 */

/** Builds the error viem produces for a custom-error revert, with real data. */
function revertedWith(errorName: string, args: readonly unknown[] = []): unknown {
  const abiItem = ARCPAD_ERROR_ABI.find((e) => e.name === errorName)
  if (!abiItem) throw new Error(`${errorName} is not in ARCPAD_ERROR_ABI`)
  const data = encodeErrorResult({
    abi: ARCPAD_ERROR_ABI,
    errorName,
    ...(args.length > 0 ? { args } : {}),
  } as Parameters<typeof encodeErrorResult>[0])
  const inner = new ContractFunctionRevertedError({
    abi: ARCPAD_ERROR_ABI,
    data,
    functionName: 'buyExactQuoteIn',
  })
  const outer = new BaseError('The contract function reverted.')
  ;(outer as { cause?: unknown }).cause = inner
  return outer
}

describe('the dictionary is complete against the ABI', () => {
  /**
   * ABI-DERIVED COMPLETENESS. Every error in the ABI is either in the table or
   * explicitly listed as unreachable. Adding an error to a contract breaks
   * this, which is the point: the dictionary cannot fall behind the ABI.
   *
   * NOTE ON THE BRIEF: it wrote this gate as
   * `new Set([...Object.keys(FAILURE_TABLE), ...UNREACHABLE_BY_CONSTRUCTION])`,
   * which cannot work -- the table's keys are `action:ErrorName`, so no bare
   * error name is ever in that set and the gate would fail on all 63. The name
   * half is extracted here.
   */
  it('every error in ARCPAD_ERROR_ABI is classified', () => {
    const classified = new Set([
      ...Object.keys(FAILURE_TABLE).map(errorNameOf),
      ...UNREACHABLE_BY_CONSTRUCTION,
    ])
    expect(ARCPAD_ERROR_ABI.length).toBe(66) // anti-vacuity
    for (const entry of ARCPAD_ERROR_ABI) {
      expect(classified, `${entry.name} is unclassified`).toContain(entry.name)
    }
  })

  it('nothing is BOTH reachable and unreachable', () => {
    const reachable = new Set(Object.keys(FAILURE_TABLE).map(errorNameOf))
    const both = UNREACHABLE_BY_CONSTRUCTION.filter((name) => reachable.has(name))
    expect(both).toEqual([])
  })

  it('every table key names a real error and a real action', () => {
    const abiNames = new Set(ARCPAD_ERROR_ABI.map((e) => e.name))
    const actions = new Set<string>(ARCPAD_ACTIONS)
    for (const key of Object.keys(FAILURE_TABLE)) {
      const action = key.slice(0, key.indexOf(':'))
      expect(actions, `${key} names an unknown action`).toContain(action)
      expect(abiNames, `${key} names an error that is not in the ABI`).toContain(errorNameOf(key))
    }
  })

  it('every unreachable entry names a real error', () => {
    const abiNames = new Set(ARCPAD_ERROR_ABI.map((e) => e.name))
    for (const name of UNREACHABLE_BY_CONSTRUCTION) {
      expect(abiNames, `${name} is listed unreachable but is not in the ABI`).toContain(name)
    }
  })
})

/**
 * THE PLANNER AND THE TABLE SAY THE SAME WORDS.
 *
 * A user-facing failure table is only useful if the thing that produces the
 * failure produces the names it lists. Review found the two had drifted: the
 * table carried `ZeroQuoteIn` / `ZeroTokensOut` / `ZeroTokensIn` with user
 * copy, while the planner delegated its zero check to `CurveMath` and threw
 * `ZeroAmount` -- a name that is in NEITHER `TradePlanErrorName` nor any cell.
 * Three rows nobody could reach, and one reachable refusal with no row.
 *
 * This is the gate that would have caught it, so it cannot drift back.
 */
describe('every name the planner throws has a cell for that action', () => {
  const V = 4_292_000_000_000_000_000n
  const T = 1_073_000_000n * 10n ** 18n
  const S = 793_100_000n * 10n ** 18n
  const PROFILE = { virtualTokenReserves: T, virtualQuoteReserves: V, saleSupply: S }
  const FEES = { protocolFeeBps: 95n, creatorFeeBps: 30n }

  const fresh = (complete = false) => ({
    virtualTokenReserves: T,
    virtualQuoteReserves: V,
    realTokenReserves: asTok(S),
    realQuoteReserves: asWei(0n),
    complete,
    creator: '0x00000000000000000000000000000000000000c0',
  })

  /**
   * The names are COLLECTED BY RUNNING THE PLANNERS, not hand-listed.
   *
   * A hand-written list is the same assumption the drift came from: it would
   * keep agreeing with the table long after the planner stopped agreeing with
   * either. These calls throw, and what they throw is the input to the gate.
   */
  function thrownNamesFor(calls: readonly (() => unknown)[]): string[] {
    const names: string[] = []
    for (const call of calls) {
      let threw = false
      try {
        call()
      } catch (error) {
        threw = true
        const named = error as { errorName?: unknown }
        expect(typeof named.errorName, 'a planner refusal must carry errorName').toBe('string')
        names.push(String(named.errorName))
      }
      expect(threw, 'this call was supposed to be a refusal and returned a plan').toBe(true)
    }
    return names
  }

  const REFUSALS: Record<string, readonly (() => unknown)[]> = {
    buyExactQuoteIn: [
      () => planBuyExactQuoteIn(fresh(true), PROFILE, FEES, 10n ** 18n, 0),
      () => planBuyExactQuoteIn(fresh(), PROFILE, FEES, 0n, 0),
      () => planBuyExactQuoteIn(fresh(), PROFILE, FEES, 2n, 0),
    ],
    buyExactTokensOut: [
      () => planBuyExactTokensOut(fresh(true), PROFILE, FEES, 10n ** 24n, 0),
      () => planBuyExactTokensOut(fresh(), PROFILE, FEES, 0n, 0),
      () => planBuyExactTokensOut(fresh(), PROFILE, FEES, S + 1n, 0),
    ],
    sellExactTokensIn: [
      () => planSellExactTokensIn(fresh(true), PROFILE, FEES, 1n, 0),
      () => planSellExactTokensIn(fresh(), PROFILE, FEES, 0n, 0),
      () => planSellExactTokensIn(fresh(), PROFILE, FEES, 1n, 0),
    ],
  }

  it('each planner refuses with the CONTRACT name, per entrypoint', () => {
    // Pinned so the collection itself is checked, not just its consistency
    // with the table. `ZeroAmount` here would be the drift coming back.
    expect(thrownNamesFor(REFUSALS.buyExactQuoteIn!)).toEqual([
      'CurveComplete',
      'ZeroQuoteIn',
      'NetTooSmall',
    ])
    expect(thrownNamesFor(REFUSALS.buyExactTokensOut!)).toEqual([
      'CurveComplete',
      'ZeroTokensOut',
      'NotEnoughTokensToBuy',
    ])
    expect(thrownNamesFor(REFUSALS.sellExactTokensIn!)).toEqual([
      'CurveComplete',
      'ZeroTokensIn',
      'ProceedsTooSmall',
    ])
  })

  it('every name a planner throws has a FAILURE_TABLE cell for THAT action', () => {
    let checked = 0
    for (const [action, calls] of Object.entries(REFUSALS)) {
      for (const errorName of thrownNamesFor(calls)) {
        expect(
          Object.keys(FAILURE_TABLE),
          `${action} throws ${errorName} and the table has no cell for it`,
        ).toContain(`${action}:${errorName}`)
        checked += 1
      }
    }
    expect(checked).toBe(9) // anti-vacuity: three refusals on each of three
  })

  it('...and each of those cells decodes to real copy, not the fallback', () => {
    for (const [action, calls] of Object.entries(REFUSALS)) {
      for (const errorName of thrownNamesFor(calls)) {
        const failure = decodeArcpadError(revertedWith(errorName), {
          action: action as ArcpadAction,
        })
        expect(failure.name, `${action}:${errorName}`).toBe(errorName)
        expect(failure.kind, `${action}:${errorName}`).not.toBe('unknown')
      }
    }
  })

  it('SlippageExceeded is chain-only: it has cells but no planner throws it', () => {
    // The distinction the gate has to keep straight. A planner cannot know the
    // price moved between quote and mine, so it never throws this -- but the
    // chain does, and the table must still carry it on all three.
    for (const [action, calls] of Object.entries(REFUSALS)) {
      expect(thrownNamesFor(calls)).not.toContain('SlippageExceeded')
      expect(Object.keys(FAILURE_TABLE)).toContain(`${action}:SlippageExceeded`)
    }
  })

  it('no curve entrypoint reports the library-level ZeroAmount', () => {
    // The name the planner used to leak. It stays in the ABI because
    // `FeeEscrow` can still throw it; it must never come from the curve.
    for (const calls of Object.values(REFUSALS)) {
      expect(thrownNamesFor(calls)).not.toContain('ZeroAmount')
    }
    for (const action of Object.keys(REFUSALS)) {
      expect(Object.keys(FAILURE_TABLE)).not.toContain(`${action}:ZeroAmount_unreachable`)
    }
  })
})
describe('wallet rejection is decided first, and is not an error', () => {
  it('a UserRejectedRequestError never reaches the contract branch', () => {
    // Deliberately given revert data TOO: if the ordering were wrong this
    // would come back as a contract failure.
    const rejection = new UserRejectedRequestError(new Error('User rejected the request.'))
    ;(rejection as { data?: unknown }).data = '0x1f2a2005'
    const failure = decodeArcpadError(rejection, { action: 'buyExactQuoteIn' })
    expect(failure.kind).toBe('wallet')
    expect(failure.name).toBe('UserRejected')
    expect(failure.retryable).toBe(false)
    expect(failure.title).not.toMatch(/error|failed|refused/i) // not a red box
  })

  it('a bare EIP-1193 code 4001 counts too', () => {
    const failure = decodeArcpadError({ code: 4001, message: 'User denied' }, { action: 'launch' })
    expect(failure.kind).toBe('wallet')
    expect(failure.name).toBe('UserRejected')
  })

  it('a rejection nested under a cause chain is still found first', () => {
    const outer = new BaseError('Request failed')
    ;(outer as { cause?: unknown }).cause = new UserRejectedRequestError(new Error('denied'))
    expect(decodeArcpadError(outer, { action: 'sellExactTokensIn' }).name).toBe('UserRejected')
  })
})

/**
 * THE THREE ENTRYPOINTS, SEPARATELY. `CurveComplete` is the same four bytes on
 * all three and means three different sentences.
 */
describe('custom errors decode per entrypoint', () => {
  it.each<[ArcpadAction, string, string]>([
    ['buyExactQuoteIn', 'CurveComplete', 'contract'],
    ['buyExactQuoteIn', 'ZeroQuoteIn', 'contract'],
    ['buyExactQuoteIn', 'NetTooSmall', 'library'],
    ['buyExactQuoteIn', 'SlippageExceeded', 'contract'],
    ['buyExactTokensOut', 'CurveComplete', 'contract'],
    ['buyExactTokensOut', 'ZeroTokensOut', 'contract'],
    ['buyExactTokensOut', 'NotEnoughTokensToBuy', 'contract'],
    ['buyExactTokensOut', 'SlippageExceeded', 'contract'],
    ['sellExactTokensIn', 'CurveComplete', 'contract'],
    ['sellExactTokensIn', 'ZeroTokensIn', 'contract'],
    ['sellExactTokensIn', 'ProceedsTooSmall', 'contract'],
    ['sellExactTokensIn', 'SlippageExceeded', 'contract'],
    ['claim', 'NothingToClaim', 'contract'],
    ['launch', 'NameTooLong', 'contract'],
    ['launch', 'EscrowHasNoCode', 'operator'],
  ])('%s + %s decodes as %s', (action, errorName, kind) => {
    const failure = decodeArcpadError(revertedWith(errorName), { action })
    expect(failure.name).toBe(errorName)
    expect(failure.action).toBe(action)
    expect(failure.kind).toBe(kind)
    expect(failure.title.length).toBeGreaterThan(0)
    expect(failure.raw).toBeDefined()
  })

  /**
   * FAILURE MODE 1, DIRECTLY. Every error the curve can throw has to be
   * classified on EACH entrypoint that can throw it -- three separate cells,
   * not one shared row. A dictionary keyed on the error alone would look
   * complete while covering one third of the surface.
   */
  it('every shared curve error has its own cell on all three entrypoints', () => {
    const shared = ['CurveComplete', 'SlippageExceeded', 'NotBound', 'ZeroReserve', 'InvalidBps']
    for (const errorName of shared) {
      for (const action of ['buyExactQuoteIn', 'buyExactTokensOut', 'sellExactTokensIn'] as const) {
        expect(
          Object.keys(FAILURE_TABLE),
          `${action}:${errorName} is missing -- covered on one entrypoint is not covered on three`,
        ).toContain(`${action}:${errorName}`)
      }
    }
  })

  it('the per-entrypoint zero-amount errors are DISTINCT cells, not one', () => {
    // Faz 1c split the curve's `ZeroAmount` into three so the decoder can say
    // which entrypoint refused. Losing that split loses the distinction.
    expect(decodeArcpadError(revertedWith('ZeroQuoteIn'), { action: 'buyExactQuoteIn' }).name).toBe(
      'ZeroQuoteIn',
    )
    expect(
      decodeArcpadError(revertedWith('ZeroTokensOut'), { action: 'buyExactTokensOut' }).name,
    ).toBe('ZeroTokensOut')
    expect(
      decodeArcpadError(revertedWith('ZeroTokensIn'), { action: 'sellExactTokensIn' }).name,
    ).toBe('ZeroTokensIn')
    // ...and each is meaningless on the other two, so it lands in `operator`.
    expect(
      decodeArcpadError(revertedWith('ZeroQuoteIn'), { action: 'sellExactTokensIn' }).kind,
    ).toBe('operator')
    expect(
      decodeArcpadError(revertedWith('ZeroTokensIn'), { action: 'buyExactQuoteIn' }).kind,
    ).toBe('operator')
  })

  it('NetTooSmall is a LIBRARY failure, not a contract one', () => {
    // It is thrown by CurveMath, and it is the only reachable library-layer
    // failure. If the dictionary loses it, the small-buy path becomes
    // "unknown error" -- Task 14's small-buy test depends on this row.
    expect(decodeArcpadError(revertedWith('NetTooSmall'), { action: 'buyExactQuoteIn' }).kind).toBe(
      'library',
    )
  })

  it('carries the decoded arguments of an error that has them', () => {
    const spender = '0x00000000000000000000000000000000000000aa'
    const failure = decodeArcpadError(
      revertedWith('ERC20InsufficientAllowance', [spender, 1n, 2n]),
      { action: 'sellExactTokensIn' },
    )
    expect(failure.name).toBe('ERC20InsufficientAllowance')
    expect(failure.kind).toBe('token')
    expect(failure.args?.[1]).toBe(1n)
    expect(failure.args?.[2]).toBe(2n)
  })

  it('an error with no cell for THIS action is operator, never unknown', () => {
    // `NothingToClaim` is real, and it has no meaning while selling. Landing in
    // `unknown` would hide the day it actually happens.
    const failure = decodeArcpadError(revertedWith('NothingToClaim'), {
      action: 'sellExactTokensIn',
    })
    expect(failure.kind).toBe('operator')
    expect(failure.name).toBe('NothingToClaim')
  })

  it('an error listed unreachable says so by name if it ever arrives', () => {
    const failure = decodeArcpadError(revertedWith('TokenTransferFailed'), {
      action: 'sellExactTokensIn',
    })
    expect(failure.kind).toBe('operator')
    expect(failure.detail).toContain('unreachable by construction')
  })
})

describe('the non-custom-error branches', () => {
  it('a STRING revert is reported with its reason', () => {
    // Arc rejects at the client level with plain strings, not selectors.
    const inner = new ContractFunctionRevertedError({
      abi: ARCPAD_ERROR_ABI,
      functionName: 'launch',
      message: 'execution reverted: Zero address not allowed',
    })
    const failure = decodeArcpadError(inner, { action: 'launch' })
    expect(failure.detail).toContain('Zero address not allowed')
    expect(failure.name).not.toBe('Unknown')
  })

  it('an Arc client-level refusal arriving only as a message is still read', () => {
    const failure = decodeArcpadError(new Error('execution reverted: sender is blocked'), {
      action: 'buyExactQuoteIn',
    })
    expect(failure.detail).toContain('sender is blocked')
    expect(failure.kind).toBe('contract')
  })

  it('EMPTY revert data does NOT guess a cause', () => {
    const inner = new ContractFunctionRevertedError({
      abi: ARCPAD_ERROR_ABI,
      data: '0x',
      functionName: 'launch',
    })
    const failure = decodeArcpadError(inner, { action: 'launch' })
    expect(failure.name).toBe('EmptyRevert')
    expect(failure.detail).toContain('does not guess')
  })

  it('insufficient funds names gas and trade as two line items', () => {
    const failure = decodeArcpadError(
      new InsufficientFundsError({ cause: new BaseError('insufficient funds') }),
      { action: 'buyExactQuoteIn' },
    )
    expect(failure.kind).toBe('wallet')
    expect(failure.name).toBe('InsufficientFunds')
    expect(failure.detail).toMatch(/gas is paid in USDC/)
  })

  it.each([
    ['http', new HttpRequestError({ url: 'https://rpc.example', status: 503 })],
    ['timeout', new TimeoutError({ body: {}, url: 'https://rpc.example' })],
    ['rate limit', new Error('429 Too Many Requests')],
  ])('a %s failure is retryable', (_label, error) => {
    const failure = decodeArcpadError(error, { action: 'buyExactQuoteIn' })
    expect(failure.kind).toBe('network')
    expect(failure.retryable).toBe(true)
  })

  it('the unknown branch keeps the raw error and is never silent', () => {
    const weird = { some: 'shape', nobody: 'expected' }
    const failure = decodeArcpadError(weird, { action: 'approve' })
    expect(failure.kind).toBe('unknown')
    expect(failure.raw).toBe(weird)
    expect(failure.detail.length).toBeGreaterThan(0)
    expect(failure.remedy).toMatch(/copy/i)
  })

  it('every branch preserves `raw` -- diagnosis is never thrown away', () => {
    const inputs: unknown[] = [
      new UserRejectedRequestError(new Error('no')),
      revertedWith('CurveComplete'),
      new Error('execution reverted: nope'),
      new InsufficientFundsError({ cause: new BaseError('x') }),
      new HttpRequestError({ url: 'https://rpc.example', status: 503 }),
      { unrecognised: true },
    ]
    for (const input of inputs) {
      expect(decodeArcpadError(input, { action: 'buyExactQuoteIn' }).raw).toBe(input)
    }
  })
})
