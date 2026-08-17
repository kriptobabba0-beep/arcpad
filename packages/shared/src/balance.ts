import { type Address, getAddress, isAddress } from 'viem'
import { USDC_ERC20_ADDRESS } from './chain'
import { erc20ToNative, nativeToErc20 } from './usdc'

/**
 * THE TWO-VIEWS RULE, AS CODE.
 *
 * On Arc a wallet holding 100 USDC reads `100e18` from `eth_getBalance` and
 * `100e6` from `USDC.balanceOf`. That is ONE fund seen twice, not two funds.
 * Adding them yields `100000000100000000` -- a number that is wrong by a
 * factor of ~1e12 and that every downstream check accepts, because there is no
 * runtime signal distinguishing "a big balance" from "a small balance scaled
 * by 1e12". The backend closes this with a schema gate (`_wei` / `_tok`
 * column suffixes); this module is the TypeScript half.
 *
 * The views are OBJECTS, not branded bigints. That choice was measured, not
 * assumed: `bigint & {brand: 'a'}` plus `bigint & {brand: 'b'}` compiles clean
 * under `--strict` (tsc 5.9.3, exit 0), because an intersection with `bigint`
 * is still BigIntLike. Object views make the same expression `TS2365: Operator
 * '+' cannot be applied`. `test/two-views-typegate.test.ts` runs tsc on both
 * shapes and would go red if that ever stopped being true.
 */
export type NativeUsdc = {
  /** The 18-decimal view. This is the view the curve is quoted in (`msg.value`). */
  readonly view: 'native_wei'
  readonly wei: bigint
}

export type Erc20Usdc = {
  /** The 6-decimal view. This is the view humans read. */
  readonly view: 'erc20_units'
  readonly units: bigint
}

/**
 * ONE balance. Both numbers describe the same fund, and the type says so by
 * carrying them in one value rather than two.
 */
export type UsdcBalance = {
  readonly wei: bigint
  readonly units: bigint
}

export type UsdcViewErrorKind =
  'views_disagree' | 'native_sentinel' | 'same_asset_swap' | 'negative'

export class UsdcViewError extends Error {
  readonly kind: UsdcViewErrorKind
  constructor(kind: UsdcViewErrorKind, message: string) {
    super(message)
    this.name = 'UsdcViewError'
    this.kind = kind
  }
}

export function nativeUsdc(wei: bigint): NativeUsdc {
  if (wei < 0n) throw new UsdcViewError('negative', `native balance cannot be negative: ${wei}`)
  return { view: 'native_wei', wei }
}

export function erc20Usdc(units: bigint): Erc20Usdc {
  if (units < 0n) throw new UsdcViewError('negative', `ERC-20 balance cannot be negative: ${units}`)
  return { view: 'erc20_units', units }
}

/**
 * Collapses the two readings of one fund into ONE balance, and REFUSES if they
 * do not describe the same fund.
 *
 * The exact relation is `units == floor(wei / 1e12)`: the ERC-20 view cannot
 * represent sub-micro-USDC dust, so it truncates. Anything else means the two
 * reads came from different accounts, different blocks, or -- the case this
 * exists for -- somebody has already added them together somewhere upstream.
 *
 * The check is what makes the rule enforceable at runtime rather than a
 * comment: a caller that sums the views and feeds the total back in as `wei`
 * lands here with `units` short by a factor of ~1e12 and gets a named error.
 */
export function unifyUsdcViews(native: NativeUsdc, erc20: Erc20Usdc): UsdcBalance {
  const expectedUnits = nativeToErc20(native.wei)
  if (expectedUnits !== erc20.units) {
    throw new UsdcViewError(
      'views_disagree',
      `the two views of one USDC balance disagree: native ${native.wei} wei implies ` +
        `${expectedUnits} ERC-20 units, but the ERC-20 view reads ${erc20.units}. ` +
        'These are two views of ONE fund; they are never summed and never independent.',
    )
  }
  return { wei: native.wei, units: erc20.units }
}

/**
 * Reads BOTH views and returns ONE balance.
 *
 * Deliberately a narrow interface rather than a viem `PublicClient`: the
 * agreement check is the interesting behaviour, and it has to be testable
 * against stubs that disagree on purpose. Same pattern as `ChainIdSource`.
 *
 * The two reads are NOT simultaneous observations -- Arc's block time is
 * ~350ms and sequential RPC calls straddle blocks. They are issued in
 * native-then-ERC-20 order and, on disagreement, retried once in the REVERSED
 * order: a real 1e12 mistake is direction-independent, a block boundary is
 * not. Reversing rather than sleeping is the control that already caught two
 * false findings on this project.
 */
export interface UsdcBalanceSource {
  readNativeWei(account: Address): Promise<bigint>
  readErc20Units(account: Address): Promise<bigint>
}

export async function readUsdcBalance(
  source: UsdcBalanceSource,
  account: Address,
): Promise<UsdcBalance> {
  const nativeFirst = await source.readNativeWei(account)
  const erc20Second = await source.readErc20Units(account)
  try {
    return unifyUsdcViews(nativeUsdc(nativeFirst), erc20Usdc(erc20Second))
  } catch (error) {
    if (!(error instanceof UsdcViewError) || error.kind !== 'views_disagree') throw error
    // Reversed order. If the first disagreement was a block boundary the
    // second pair agrees; if it was a scaling mistake it disagrees again.
    const erc20First = await source.readErc20Units(account)
    const nativeSecond = await source.readNativeWei(account)
    return unifyUsdcViews(nativeUsdc(nativeSecond), erc20Usdc(erc20First))
  }
}

/**
 * Addresses that mean "the native asset" in routing and token-list code. They
 * are NOT contracts.
 *
 * Calling `decimals()` on either reverts -- there is no code at those
 * addresses -- and a reverted `decimals()` that a caller defaults to 18 is
 * exactly the 1e12 mistake with extra steps.
 */
export const NATIVE_SENTINELS = [
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '0x0000000000000000000000000000000000000000',
] as const

export function isNativeSentinel(candidate: string): boolean {
  if (!isAddress(candidate, { strict: false })) return false
  const lower = candidate.toLowerCase()
  return NATIVE_SENTINELS.some((sentinel) => sentinel === lower)
}

export function isUsdcErc20(candidate: string): boolean {
  if (!isAddress(candidate, { strict: false })) return false
  return candidate.toLowerCase() === USDC_ERC20_ADDRESS.toLowerCase()
}

/**
 * Gate in front of any ERC-20 metadata call (`decimals()`, `symbol()`).
 * Refuses native sentinels by name instead of letting the RPC revert with
 * something a `catch` can turn into a default.
 */
export function assertErc20Callable(candidate: string): Address {
  if (!isAddress(candidate, { strict: false })) {
    throw new UsdcViewError('native_sentinel', `not an address: ${candidate}`)
  }
  if (isNativeSentinel(candidate)) {
    throw new UsdcViewError(
      'native_sentinel',
      `${candidate} is a native sentinel, not a contract: decimals()/symbol() revert there. ` +
        `On Arc the native asset is USDC itself; its ERC-20 view is ${USDC_ERC20_ADDRESS}.`,
    )
  }
  return getAddress(candidate)
}

/**
 * USDC <-> native IS NOT A SWAP, and this refuses it BEFORE it reaches fee or
 * routing logic.
 *
 * A route that "swaps" the native asset for the ERC-20 view is asking to trade
 * a fund for itself. Left to a router it produces a price of exactly 1e12 (or
 * 1e-12), charges a fee on it, and every invariant downstream still balances.
 * Both sentinel-vs-ERC-20 directions are refused, and so is either side
 * against itself.
 */
export function assertNotUsdcNativeSwap(tokenIn: string, tokenOut: string): void {
  const inIsUsdc = isNativeSentinel(tokenIn) || isUsdcErc20(tokenIn)
  const outIsUsdc = isNativeSentinel(tokenOut) || isUsdcErc20(tokenOut)
  if (inIsUsdc && outIsUsdc) {
    throw new UsdcViewError(
      'same_asset_swap',
      `refusing to route ${tokenIn} -> ${tokenOut}: on Arc the native asset IS USDC, so both ` +
        'sides of this pair are the same fund. USDC <-> native is a change of view, not a swap; ' +
        'it has no price and must never reach fee or routing logic.',
    )
  }
}

/**
 * The only sanctioned conversion, and it is a VIEW CHANGE, not arithmetic on
 * two balances. Re-exported through this module so that call sites which mean
 * "show the 6-decimal figure" import it from the file that also refuses the
 * things they must not do.
 */
export { erc20ToNative, nativeToErc20 }
