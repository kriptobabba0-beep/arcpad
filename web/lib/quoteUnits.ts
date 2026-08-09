import { erc20ToNative, nativeToErc20, USDC_VIEW_SCALE } from '@arcpad/shared/browser'

/**
 * ==========================================================================
 *  THE 6-DECIMAL BOUNDARY OF THE POOL PATH. THIS FILE IS THE ONLY ONE.
 * ==========================================================================
 *
 * On Arc the native asset IS USDC and it has two views of ONE fund: an
 * 18-decimal native view (`eth_getBalance`, `msg.value`) and a 6-decimal ERC-20
 * view at `0x3600…0000`. They are never summed, and the exact relation is
 *
 *     units === floor(wei / 1e12)      NOT      units * 1e12 === wei
 *
 * RE-MEASURED 2026-08-09 against the live deployer, after this router shipped:
 *
 *     balanceOf(0xe92c64C4…) =                74_516_800
 *     eth_getBalance         =    74_516_800_457_331_780_981
 *     floor(wei / 1e12) === units   -> true
 *     units * 1e12      === wei     -> FALSE   (457_331_780_981 wei of dust)
 *
 * ============ WHY THE SEAM MOVED INTO THIS LAYER ============
 *
 * `ArcpadRouter` has NO `1e12` in it, deliberately: both pool legs are
 * ERC-20-denominated, so every delta `PoolManager` hands it is already in
 * 6-decimal units and it settles those numbers unchanged. The system's two
 * conversions stay where they were -- `GraduationMath.quoteUnits` in the locker
 * (once per graduation) and `GraduationMath.quoteWei` in the hook (once per fee
 * deposit). Neither is on a swap path.
 *
 * But the rest of this app is 18-decimal: `parseUsdcAmount` returns native wei,
 * `<Money native={…}>` draws native wei, `useUsdcBalance` reads native wei, and
 * `trades.quote_amount_wei` is native wei. So the boundary the contracts do not
 * have lands HERE, and it lands in exactly one file so that a `1e12` cannot be
 * written twice with different rounding -- which no runtime check on this chain
 * could ever see.
 *
 * ============ THE ASYMMETRY IS THE POINT ============
 *
 *   `quoteWeiFromUnits`  units -> wei   EXACT. Multiplication. Never lies.
 *   `quoteUnitsFromWei`  wei -> units   TRUNCATES. Can lose up to 1e12 - 1 wei.
 *
 * The truncating direction is reachable on exactly one kind of value: a
 * BALANCE, which carries sub-micro-USDC dust as soon as the account has paid
 * for a single transaction. It is NOT reachable on anything the user typed:
 * `parseUsdcAmount` quantises to six decimals first, so every parsed amount is
 * already an exact multiple of 1e12 and `quoteUnitsFromWei` is lossless on it.
 * `isQuantised` states that, and `test/pool/units.test.ts` runs it over the
 * parser rather than asserting it.
 */

/** `1e12`. The scale between the two views of one fund. */
export const QUOTE_UNIT_SCALE = USDC_VIEW_SCALE

/**
 * 18-decimal native wei -> the 6-decimal units the router takes.
 *
 * TRUNCATES, and that direction is correct for every caller it has: a spendable
 * budget rounded UP is a budget the wallet will refuse.
 */
export function quoteUnitsFromWei(wei: bigint): bigint {
  return nativeToErc20(wei)
}

/**
 * The 6-decimal units the router returns -> 18-decimal native wei, for display.
 *
 * EXACT. Every USDC figure the pool panel draws goes through here so that it
 * reaches `<Money native={…}>` in the same view the curve panel uses -- one
 * figure, one scale, one component, no second rendering of the same money.
 */
export function quoteWeiFromUnits(units: bigint): bigint {
  return erc20ToNative(units)
}

/**
 * Is this native amount exactly representable in the 6-decimal view?
 *
 * True for everything `parseUsdcAmount` produces. False for a real balance.
 * The pool panel uses it to decide whether a MAX shortcut needs to say that it
 * dropped dust -- and the answer, measured, is that it always does on a used
 * account and never does on a typed amount.
 */
export function isQuantised(wei: bigint): boolean {
  return wei >= 0n && wei % QUOTE_UNIT_SCALE === 0n
}

/** The dust a native amount would lose on its way into the 6-decimal view. */
export function quoteDustWei(wei: bigint): bigint {
  if (wei < 0n) return 0n
  return wei % QUOTE_UNIT_SCALE
}
