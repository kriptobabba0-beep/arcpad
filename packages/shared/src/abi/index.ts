import { toFunctionSelector } from 'viem'
import { bondingCurveAbi } from './bondingCurve'
import { curveMathErrorsAbi } from './curveMath'
import { feeEscrowAbi } from './feeEscrow'
import { launchFactoryAbi } from './launchFactory'
import { launchTokenAbi } from './launchToken'

export { bondingCurveAbi } from './bondingCurve'
export { curveMathErrorsAbi } from './curveMath'
export { feeEscrowAbi } from './feeEscrow'
export { launchFactoryAbi } from './launchFactory'
export { launchTokenAbi } from './launchToken'

/**
 * The order the four contracts and the library are searched. It is FIXED, so
 * `ARCPAD_ERROR_ABI` is byte-identical between runs and a diff of the decoded
 * dictionary means a real change.
 */
const SOURCES = [
  bondingCurveAbi,
  launchFactoryAbi,
  launchTokenAbi,
  feeEscrowAbi,
  curveMathErrorsAbi,
] as const

/**
 * The shape of an ABI `error` entry.
 *
 * Declared here rather than imported: viem re-exports `AbiFunction` and
 * `AbiEvent` from abitype but NOT the error variant, and reaching past viem
 * into abitype would add an undeclared dependency to this package.
 */
export type ArcpadAbiError = {
  readonly type: 'error'
  readonly name: string
  readonly inputs: readonly { readonly type: string; readonly name?: string }[]
}

function errorSignature(entry: ArcpadAbiError): string {
  return `${entry.name}(${entry.inputs.map((input: { type: string }) => input.type).join(',')})`
}

/**
 * EVERY custom error this frontend can be handed, deduplicated BY SELECTOR.
 *
 * Deduplication is by selector and not by name because the selector is what
 * arrives on the wire: four bytes of `keccak(signature)`, with no room for
 * which contract declared it. MEASURED on this deployment:
 * `CurveMath.ZeroAmount()` and `FeeEscrow.ZeroAmount()` share `0x1f2a2005`,
 * and `BondingCurve` re-declares five of `CurveMath`'s errors on top of that.
 * 63 distinct selectors survive across the five sources.
 *
 * THE CONSEQUENCE, and it is the shape of the whole decoder: A SELECTOR DOES
 * NOT TELL YOU WHICH LAYER FAILED. Faz 1c split the curve's own `ZeroAmount`
 * into `ZeroTokensOut`/`ZeroQuoteIn`/`ZeroTokensIn` so that the curve's three
 * entrypoints are distinguishable, but the library-versus-escrow collision
 * REMAINS and cannot be resolved from the data. That is why the failure
 * dictionary is keyed on `(action, errorName)` rather than on the error alone:
 * the layer comes from what the user was doing, which the caller knows and the
 * revert data does not.
 */
export const ARCPAD_ERROR_ABI: readonly ArcpadAbiError[] = (() => {
  const bySelector = new Map<string, ArcpadAbiError>()
  for (const abi of SOURCES) {
    for (const entry of abi) {
      if (entry.type !== 'error') continue
      const error = entry as ArcpadAbiError
      const selector = toFunctionSelector(errorSignature(error))
      if (!bySelector.has(selector)) bySelector.set(selector, error)
    }
  }
  return [...bySelector.values()]
})()

/** The four-byte selector of an ABI error entry. Same rule as a function. */
export function errorSelector(entry: ArcpadAbiError): string {
  return toFunctionSelector(errorSignature(entry))
}

/** Every error NAME the decoder can produce, for the completeness gate. */
export const ARCPAD_ERROR_NAMES: readonly string[] = ARCPAD_ERROR_ABI.map((e) => e.name)
