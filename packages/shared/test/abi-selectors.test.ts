import { describe, expect, it } from 'vitest'
import { toFunctionSelector } from 'viem'
import {
  ARCPAD_ERROR_ABI,
  type ArcpadAbiError,
  bondingCurveAbi,
  curveMathErrorsAbi,
  errorSelector,
  feeEscrowAbi,
  launchFactoryAbi,
  launchTokenAbi,
} from '../src/abi/index'

/**
 * A SELECTOR IS FOUR BYTES OF A SIGNATURE HASH AND NOTHING ELSE.
 *
 * It does not carry the contract, the file, or the layer. Two errors declared
 * in two different places with the same signature are the SAME four bytes on
 * the wire, and no amount of decoding will separate them. This file enumerates
 * the collisions that exist on this deployment so that the decoder's design --
 * keyed on `(action, errorName)` rather than on the error alone -- rests on a
 * measurement instead of on a worry.
 */

function signature(entry: ArcpadAbiError): string {
  return `${entry.name}(${entry.inputs.map((i: { type: string }) => i.type).join(',')})`
}

function groupBySelector(entries: readonly ArcpadAbiError[]): Map<string, string[]> {
  const bySelector = new Map<string, string[]>()
  for (const entry of entries) {
    const selector = toFunctionSelector(signature(entry))
    bySelector.set(selector, [...(bySelector.get(selector) ?? []), entry.name])
  }
  return bySelector
}

const ALL_DECLARED: ArcpadAbiError[] = [
  bondingCurveAbi,
  launchFactoryAbi,
  launchTokenAbi,
  feeEscrowAbi,
  curveMathErrorsAbi,
]
  .flatMap((abi) => abi as readonly { type: string }[])
  .filter((e): e is ArcpadAbiError => e.type === 'error')

describe('error selectors', () => {
  /**
   * MEASURED: `CurveMath.ZeroAmount()` and `FeeEscrow.ZeroAmount()` are the
   * same four bytes, `0x1f2a2005`, because a selector is computed from the
   * signature alone. Faz 1c resolved the collision INSIDE the curve by
   * splitting it into `ZeroTokensOut` / `ZeroQuoteIn` / `ZeroTokensIn`; the
   * library-versus-escrow collision STANDS, and the decoder has to know it.
   */
  it('ZeroAmount() is declared in more than one place and is one selector', () => {
    const declarations = ALL_DECLARED.filter((e) => e.name === 'ZeroAmount')
    expect(declarations.length).toBeGreaterThan(1) // the collision is real
    expect(toFunctionSelector('ZeroAmount()')).toBe('0x1f2a2005')
    expect(new Set(declarations.map((e) => toFunctionSelector(signature(e))))).toEqual(
      new Set(['0x1f2a2005']),
    )
  })

  it('the three curve-side zero errors are NOT one selector', () => {
    // The split Faz 1c made is what lets the decoder say which entrypoint
    // rejected. If these ever collapse back to one name, that is lost.
    const selectors = ['ZeroTokensOut()', 'ZeroQuoteIn()', 'ZeroTokensIn()'].map(toFunctionSelector)
    expect(new Set(selectors).size).toBe(3)
    const names = (bondingCurveAbi as readonly { type: string; name?: string }[])
      .filter((e) => e.type === 'error')
      .map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['ZeroTokensOut', 'ZeroQuoteIn', 'ZeroTokensIn']))
  })

  it('collisions are ENUMERATED, not discovered: same selector never means two names', () => {
    const bySelector = groupBySelector(ARCPAD_ERROR_ABI)
    const collisions = [...bySelector].filter(([, names]) => new Set(names).size > 1)
    expect(collisions).toEqual([]) // same selector, DIFFERENT name: none
    // Same name, deduplicated to one entry:
    expect(bySelector.get(toFunctionSelector('ZeroAmount()'))).toEqual(['ZeroAmount'])
  })

  it('deduplication is by selector, and it removed something', () => {
    // Anti-vacuity: if the dictionary were the raw concatenation this would be
    // equal, and the "one entry per selector" claim would be untested.
    expect(ARCPAD_ERROR_ABI.length).toBeLessThan(ALL_DECLARED.length)
    expect(ARCPAD_ERROR_ABI).toHaveLength(63)
    expect(new Set(ARCPAD_ERROR_ABI.map(errorSelector)).size).toBe(ARCPAD_ERROR_ABI.length)
  })

  it('every declared error survives into the dictionary under its own name', () => {
    const kept = new Set(ARCPAD_ERROR_ABI.map((e) => e.name))
    for (const declared of ALL_DECLARED) {
      expect(kept, `${declared.name} was dropped by deduplication`).toContain(declared.name)
    }
  })

  it('errorSelector agrees with viem on a signature with arguments', () => {
    const insufficient = ARCPAD_ERROR_ABI.find((e) => e.name === 'ERC20InsufficientAllowance')
    expect(insufficient).toBeDefined()
    expect(errorSelector(insufficient as ArcpadAbiError)).toBe(
      toFunctionSelector('ERC20InsufficientAllowance(address,uint256,uint256)'),
    )
  })
})
