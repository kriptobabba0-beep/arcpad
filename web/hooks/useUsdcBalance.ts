'use client'

import { composeUsdcBalance, useNativeUsdcBalance, type UsdcBalanceView } from '../lib/balance'
import { useArcNetwork } from './useArcNetwork'

export type UsdcBalanceState = UsdcBalanceView & {
  readonly isPending: boolean
  readonly refetch: () => void
}

/**
 * ONE USDC BALANCE.
 *
 * `useNativeUsdcBalance` returns the native (18-decimal) reading; the
 * six-decimal figure the screen shows is that same number divided by 1e12.
 * There is NO second read from the ERC-20 contract, and adding one would not
 * be "more accurate" -- it would be the same fund counted twice.
 *
 * The direction is `down`, from `composeUsdcBalance`: a balance is money that
 * exists, and rounding it up shows the user a figure their wallet will refuse
 * to spend.
 */
export function useUsdcBalance(): UsdcBalanceState {
  const { address } = useArcNetwork()
  const { native, isPending, refetch } = useNativeUsdcBalance(address)
  return { ...composeUsdcBalance(native), isPending, refetch }
}
