'use client'

import {
  erc20Usdc,
  type Erc20Usdc,
  formatUsdcAmount,
  nativeToErc20,
  nativeUsdc,
  type NativeUsdc,
  unifyUsdcViews,
} from '@arcpad/shared/browser'
import type { Address } from 'viem'
// The one `useBalance` import in `web/`. `eslint.config.js` names THIS FILE in
// the rule's `ignores`, so no suppression comment is needed -- and adding one
// would report as an unused directive.
import { useBalance } from 'wagmi'

/**
 * THE ONLY MODULE IN `web/` ALLOWED TO IMPORT `useBalance`.
 *
 * On Arc the native asset IS USDC. wagmi's `useBalance` returns the NATIVE
 * view: `symbol: 'USDC'`, `decimals: 18`. Right asset, wrong scale for the
 * screen -- what a human reads is the six-decimal view, and it is obtained by
 * DIVIDING the number already in hand, not by reading a second balance.
 *
 * A second read from `USDC.balanceOf` is the SAME money in the other view. Two
 * reads become two rows, two rows become a sum, and the sum is wrong by a
 * factor of ~1e12 while looking entirely plausible. `eslint.config.js` blocks
 * the import everywhere else in `web/`; `web/test/balance.test.ts` RUNS the
 * linter to prove it.
 */

/**
 * ONE balance, carried as the TWO OBJECT VIEWS rather than two bigints.
 *
 * WHAT THIS SHAPE ACTUALLY CLOSES, stated exactly -- an earlier version of this
 * comment claimed more than the compiler delivers, and review caught it:
 *
 *   CLOSED   `view.native + view.erc20`            -> TS2365.
 *   CLOSED   `view.wei`, `view.units`              -> do not exist on this type.
 *   OPEN     `view.native.wei + view.erc20.units`  -> COMPILES.
 *   OPEN     `unifyUsdcViews(...)` returns `UsdcBalance = { wei, units }`,
 *            which is the flat shape the typegate compiles ON PURPOSE to show
 *            it is dangerous -- and both it and the type are exported from
 *            `@arcpad/shared/browser`, so `b.wei + b.units` compiles for anyone
 *            who calls it directly.
 *
 * So the object shape stops the ACCIDENTAL sum -- the one where two readings
 * sit in scope as two bigints and somebody adds them. It does not stop a
 * deliberate two-step unwrap, and nothing in the type system can: both fields
 * are `bigint`, and a brand does not stop `+` either (measured, same file).
 *
 * THE STRUCTURAL DEFENCE IS THEREFORE THE SINGLE IMPORT SEAM, not the type.
 * There is exactly one `useBalance` in `web/`, so there is never a second
 * reading in scope to add. `web/test/balance.test.ts` RUNS eslint to prove it,
 * with a control, and the runtime `unifyUsdcViews` check catches what it can --
 * which is measured, and is less than it looks: below one million USDC the
 * added units fall under the 1e12 truncation quantum and it sees nothing.
 *
 * A caller that genuinely needs the number writes `.native.wei` or
 * `.erc20.units`, which is at least a deliberate act rather than an accident.
 */
export type UsdcBalanceView = {
  /** The 18-decimal view. This is the view the curve is quoted in (`msg.value`). */
  readonly native: NativeUsdc
  /** The 6-decimal view. This is the view humans read. */
  readonly erc20: Erc20Usdc
  /** The six-decimal string, rounded DOWN: never shows money that is not there. */
  readonly display: string
}

/**
 * Builds ONE balance from a native reading, and DERIVES the ERC-20 view.
 *
 * `erc20Units` exists so a caller that already has the other reading can be
 * checked against it, not so it can be added: `unifyUsdcViews` refuses any
 * pair that does not satisfy `units == floor(wei / 1e12)`.
 */
export function composeUsdcBalance(nativeWei: bigint, erc20Units?: bigint): UsdcBalanceView {
  // Constructed FIRST so a negative reading fails as a named `UsdcViewError`
  // rather than as whatever the next arithmetic step happens to throw.
  const native = nativeUsdc(nativeWei)
  const erc20 = erc20Usdc(erc20Units ?? nativeToErc20(native.wei))
  const balance = unifyUsdcViews(native, erc20)
  return { native, erc20, display: formatUsdcAmount(balance.wei, { rounding: 'down' }) }
}

export type NativeBalanceRead = {
  readonly native: bigint
  readonly isPending: boolean
  readonly refetch: () => void
}

/**
 * The single wagmi seam. Deliberately returns a plain bigint and nothing else:
 * everything a component needs is derived from it, so no other file has a
 * reason to reach for the hook.
 *
 * `address` is optional because wagmi's `address` is UNDEFINED while
 * disconnected; the query is disabled rather than fired at `undefined`.
 */
export function useNativeUsdcBalance(address: Address | undefined): NativeBalanceRead {
  const { data, isPending, refetch } = useBalance(address ? { address } : {})
  return {
    native: data?.value ?? 0n,
    isPending: address !== undefined && isPending,
    refetch: () => {
      void refetch()
    },
  }
}
