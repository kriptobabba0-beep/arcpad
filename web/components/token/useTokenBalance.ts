'use client'

import { launchTokenAbi } from '@arcpad/shared/browser'
import { useReadContract } from 'wagmi'
import type { HexAddress } from '@/components/read/types'

/**
 * A LAUNCH TOKEN BALANCE, 18-DECIMAL, FROM THE CHAIN.
 *
 * Extracted from `TradePanel` so the pool panel reads it the same way rather
 * than growing a second `useReadContract` with its own `enabled` rule -- two
 * readings of one balance is how the two panels end up disagreeing about
 * whether a user can sell.
 *
 * NOT `useBalance`: that hook returns the NATIVE asset, which on Arc is USDC.
 * `web/lib/balance.ts` owns that seam and eslint enforces it; this is an ERC-20
 * `balanceOf` on the launch token and is a different fund entirely.
 */
export function useTokenBalance(
  token: HexAddress | undefined,
  owner: HexAddress | undefined,
): bigint | null {
  const read = useReadContract({
    address: token as `0x${string}`,
    abi: launchTokenAbi,
    functionName: 'balanceOf',
    args: [owner as `0x${string}`],
    query: { enabled: token !== undefined && owner !== undefined },
  })
  const value = read.data
  return typeof value === 'bigint' ? value : null
}
