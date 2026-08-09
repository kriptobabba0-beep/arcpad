import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARCPAD_ERROR_ABI } from '@arcpad/shared/browser'
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { graduationStateFrom } from '@/components/token/useGraduation'
import { decodeArcpadError } from '@/lib/decodeRevert'
import { REACHABLE_THROUGH_GRADUATION, UNREACHABLE_BY_CONSTRUCTION } from '@/lib/failureTable'
import {
  ARCPAD_LOCKER_ABI,
  CURVE_GRADUATION_ERROR_NAMES,
  GRADUATION_ERROR_ABI,
  LOCKER_ERROR_ABI,
  MEASURED_GRADUATION_SELECTORS,
} from '@/lib/graduationAbi'
import {
  decodeGraduationError,
  graduationCopyFor,
  graduationCoveredNames,
} from '@/lib/graduationOutcome'

/**
 * ============ THE GRADUATION SURFACE, AND ITS OWN COMPLETENESS GATE ============
 *
 * `test/errors/reconcile.test.ts` guards the SIX `ArcpadAction`s. Graduation is
 * a SEVENTH surface with its own dictionary (see `lib/graduationOutcome.ts` for
 * why it is not a seventh action), and adding a surface without extending the
 * gate to it is precisely how this repository accumulated eleven instances of
 * "covered on one entrypoint reads as covered on all". So this file is that
 * gate: every name the surface can carry has copy, the ABI is checked against a
 * second source, and the one benign outcome is asserted to READ as benign.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const WEB = join(HERE, '..', '..')
const ARTIFACT = join(REPO_ROOT, 'contracts', 'out', 'ArcpadLocker.sol', 'ArcpadLocker.json')

describe('the hand-written locker ABI agrees with a second source', () => {
  /**
   * PIN vs DERIVATION. A misspelled error name derives a WRONG selector, throws
   * nothing, and turns a real revert into "we have no text for this" -- silently.
   * The three pins were produced elsewhere: two by the keeper reading the LIVE
   * chain on 2026-08-09, one by its fork proof.
   */
  it('the selectors the keeper measured on chain are the ones this ABI derives', () => {
    for (const [name, measured] of Object.entries(MEASURED_GRADUATION_SELECTORS)) {
      expect(toFunctionSelector(`${name}()`), `${name} derives a different selector`).toBe(measured)
      expect(
        GRADUATION_ERROR_ABI.some((entry) => entry.name === name),
        `${name} is pinned but is not on the graduation ABI`,
      ).toBe(true)
    }
  })

  it('the call itself is graduate(address) and nothing else is callable', () => {
    const functions = ARCPAD_LOCKER_ABI.filter((entry) => entry.type === 'function')
    expect(functions).toHaveLength(1)
    expect(functions[0]?.name).toBe('graduate')
    expect(toFunctionSelector('graduate(address)')).toBe('0xff6d8d05')
  })

  /**
   * FULL PARITY, WHEN FOUNDRY OUTPUT IS ON DISK.
   *
   * `pnpm --filter @arcpad/web test` must run on a machine without Foundry, so
   * this cannot hard-fail on a missing artifact -- but a check that quietly
   * skips reads exactly like one that passed. It therefore prints an OPEN CELL,
   * the same shape the Arc e2e leg uses, and the selector pins above still run
   * unconditionally either way.
   */
  it('every error the compiled ArcpadLocker declares is on this ABI', () => {
    if (!existsSync(ARTIFACT)) {
      console.warn(
        '\n[web] OPEN CELL — contracts/out/ArcpadLocker.sol/ArcpadLocker.json is absent, so the ' +
          'hand-written locker ABI was compared only against the pinned selectors. Run ' +
          '`forge build --root contracts` to close this cell.\n',
      )
      expect(LOCKER_ERROR_ABI.length).toBeGreaterThan(0)
      return
    }
    const compiled = JSON.parse(readFileSync(ARTIFACT, 'utf8')).abi as {
      type: string
      name?: string
    }[]
    const declared = compiled
      .filter((entry) => entry.type === 'error')
      .map((entry) => entry.name as string)
      .sort()
    const ours = LOCKER_ERROR_ABI.map((entry) => entry.name).sort()
    // BOTH DIRECTIONS. A missing name means an undecodable revert; an invented
    // one means dead copy that looks like coverage.
    expect(ours).toEqual(declared)
  })

  it('the curve half is TAKEN from the distributed ABI, not retyped', () => {
    for (const name of CURVE_GRADUATION_ERROR_NAMES) {
      const fromShared = ARCPAD_ERROR_ABI.find((entry) => entry.name === name)
      expect(fromShared, `${name} is not in ARCPAD_ERROR_ABI`).toBeDefined()
      expect(GRADUATION_ERROR_ABI).toContain(fromShared)
    }
  })
})

describe('every name the surface can carry has text', () => {
  it('no error on GRADUATION_ERROR_ABI falls through to "no text for this"', () => {
    let covered = 0
    for (const entry of GRADUATION_ERROR_ABI) {
      const copy = graduationCopyFor(entry.name)
      expect(copy, `${entry.name} has no copy`).toBeDefined()
      expect(copy?.title.length).toBeGreaterThan(0)
      expect(copy?.body.length).toBeGreaterThan(0)
      expect(copy?.remedy ?? '', `${entry.name} has no remedy`).not.toBe('')
      covered += 1
    }
    // ANTI-VACUITY: an empty ABI would satisfy the loop above trivially.
    expect(covered).toBe(GRADUATION_ERROR_ABI.length)
    expect(covered).toBeGreaterThan(15)
  })

  it('the dictionary claims nothing the ABI cannot produce', () => {
    const onAbi = new Set(GRADUATION_ERROR_ABI.map((entry) => entry.name))
    const invented = graduationCoveredNames().filter((name) => !onAbi.has(name))
    expect(invented, 'dead rows read as coverage').toEqual([])
  })
})

describe('AlreadyGraduated is the design working, and must not read as a fault', () => {
  /**
   * THE ONE THAT WOULD HAVE BEEN WRONG. `ArcpadLocker.graduate` is
   * permissionless on purpose, so the keeper -- or anyone -- winning the race is
   * the mechanism succeeding. `keeper/src/graduate/outcome.ts` classifies it
   * `level: 'ok'`, `pageable: false`; the interface has to agree.
   */
  it('it is NEUTRAL, not an error, and says someone else got there first', () => {
    const copy = graduationCopyFor('AlreadyGraduated')
    expect(copy?.tone).toBe('neutral')
    expect(copy?.code).toBe('already-graduated')
    expect(`${copy?.title} ${copy?.body}`).toMatch(/someone else|already graduated/i)
    // And it is NOT the pool-step sentence, which is the red one.
    expect(copy?.body).not.toMatch(/could not be opened/i)
  })

  it('GraduationTargetUnset is "not yet", not "broken"', () => {
    const copy = graduationCopyFor('GraduationTargetUnset')
    expect(copy?.tone).not.toBe('error')
    expect(copy?.body).toMatch(/nothing is lost|nothing is at risk|stay in the curve/i)
  })

  it('the pool-step names all resolve, and the message NAMES the one that fired', () => {
    for (const name of ['ZeroLiquidity', 'SeedShortfall', 'PoolPriceMismatch', 'FailedInnerCall']) {
      const copy = graduationCopyFor(name)
      expect(copy?.code).toBe('pool-step-failed')
      expect(copy?.body, `${name} is not named in its own message`).toContain(`${name}()`)
      // Atomicity is the reassurance that matters: nothing moved.
      expect(copy?.body).toMatch(/nothing moved/i)
    }
  })
})

describe('THE TRAP: a graduation error must not be reported as impossible', () => {
  function revertedWith(errorName: string): unknown {
    const data = encodeErrorResult({ abi: ARCPAD_ERROR_ABI, errorName } as Parameters<
      typeof encodeErrorResult
    >[0])
    const inner = new ContractFunctionRevertedError({
      abi: ARCPAD_ERROR_ABI,
      data,
      functionName: 'graduate',
    })
    const outer = new BaseError('The contract function reverted.')
    ;(outer as { cause?: unknown }).cause = inner
    return outer
  }

  /**
   * BEFORE THIS CHANGE the five graduation errors sat in
   * `UNREACHABLE_BY_CONSTRUCTION` with the reason "this frontend never calls
   * graduate()". The button makes that false, and `decodeArcpadError` prints
   * "a path that was believed impossible" for everything on that list -- so the
   * BENIGN race outcome would have been shown as a deployment fault.
   */
  it('AlreadyGraduated through the TRADE decoder does not claim the impossible', () => {
    const failure = decodeArcpadError(revertedWith('AlreadyGraduated'), {
      action: 'buyExactQuoteIn',
    })
    expect(failure.title).not.toMatch(/believed impossible/i)
    expect(failure.title).toMatch(/graduation error/i)
    expect(failure.name).toBe('AlreadyGraduated')
  })

  it('CONTROL: a genuinely unreachable name STILL says "believed impossible"', () => {
    // Without this the assertion above could be satisfied by deleting the
    // sentence altogether, which would lose a real signal.
    expect(UNREACHABLE_BY_CONSTRUCTION).toContain('ZeroCreator')
    expect(REACHABLE_THROUGH_GRADUATION).not.toContain('ZeroCreator')
    const failure = decodeArcpadError(revertedWith('ZeroCreator'), { action: 'launch' })
    expect(failure.title).toMatch(/believed impossible/i)
  })

  it('the graduation list and the unreachable list cannot drift apart', () => {
    for (const name of REACHABLE_THROUGH_GRADUATION) {
      expect(UNREACHABLE_BY_CONSTRUCTION).toContain(name)
      expect(graduationCopyFor(name), `${name} has no graduation copy`).toBeDefined()
    }
    expect(REACHABLE_THROUGH_GRADUATION).toHaveLength(5)
  })

  it('the graduation decoder resolves a raw revert from the INNER contract', () => {
    // The wallet calls `ArcpadLocker`; the revert can come from `BondingCurve`.
    // A client that decoded with only the called contract's ABI would hand back
    // undecodable data, so this asserts the combined ABI does the job.
    const data = encodeErrorResult({
      abi: ARCPAD_ERROR_ABI,
      errorName: 'GraduationTargetUnset',
    } as Parameters<typeof encodeErrorResult>[0])
    expect(data).toBe(MEASURED_GRADUATION_SELECTORS.GraduationTargetUnset)
    const outcome = decodeGraduationError({ cause: { data } })
    expect(outcome.code).toBe('target-unset')
    expect(outcome.tone).not.toBe('error')
  })

  it('an unmodelled selector is LOUD, never silent', () => {
    const outcome = decodeGraduationError({ cause: { data: '0xdeadbeef' } })
    expect(outcome.code).toBe('unknown')
    expect(outcome.showRaw).toBe(true)
  })
})

describe('the four-way decision, and the one state that may not offer an action', () => {
  const TARGET = '0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8'
  const ZERO = '0x0000000000000000000000000000000000000000'

  it('target 0x0 -> unarmed, and unarmed carries NO target to send to', () => {
    const state = graduationStateFrom({ graduated: false, target: ZERO, failed: false })
    expect(state.kind).toBe('unarmed')
    // STRUCTURAL, not cosmetic: only `ready` has a `target` field, so there is
    // no arrangement of state that addresses a transaction to the zero address.
    expect(Object.hasOwn(state, 'target')).toBe(false)
  })

  it('a non-zero target with an ungraduated curve -> ready, lowercased', () => {
    const state = graduationStateFrom({ graduated: false, target: TARGET, failed: false })
    expect(state).toEqual({ kind: 'ready', target: TARGET.toLowerCase() })
  })

  it('graduated wins over everything, including a failed target read', () => {
    expect(graduationStateFrom({ graduated: true, target: undefined, failed: true }).kind).toBe(
      'graduated',
    )
  })

  it('a failed read is `unavailable`, never `unarmed`', () => {
    // The difference is the whole point: "we could not read the target" must
    // not be rendered as "the platform has not armed it".
    expect(graduationStateFrom({ graduated: false, target: undefined, failed: true }).kind).toBe(
      'unavailable',
    )
    expect(graduationStateFrom({ graduated: undefined, target: undefined, failed: false }).kind).toBe(
      'loading',
    )
  })
})

describe('the panel is reachable from BOTH page branches', () => {
  /**
   * A COMPONENT THAT NOTHING RENDERS IS NOT A FEATURE. This repository has
   * shipped that exact shape three times -- `TradePanel` written and drawn by no
   * page, `CurveChart`'s realised layer, the missing `loadMore*` props -- and
   * each time the component's own tests were green. The page has TWO branches
   * (indexer row, chain-drawn) and the graduation action must exist on both:
   * the chain-drawn branch is the one a user sees when the indexer is DOWN,
   * which is exactly when the keeper may be down too.
   */
  it('both LifecycleNotice call sites pass a curve', () => {
    const source = readFileSync(join(WEB, 'app', 'token', '[address]', 'page.tsx'), 'utf8')
    const uses = [...source.matchAll(/<LifecycleNotice\s[^>]*\/>/g)].map((m) => m[0])
    expect(uses.length, 'the page must resolve a lifecycle on both branches').toBe(2)
    for (const use of uses) {
      expect(use, `a LifecycleNotice is rendered without a curve: ${use}`).toMatch(/curve=\{/)
    }
  })
})
