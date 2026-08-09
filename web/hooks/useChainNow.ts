'use client'

import { useBlock } from 'wagmi'

/**
 * THE CHAIN'S CLOCK, BECAUSE THE BROWSER'S IS NOT THE ONE BEING COMPARED.
 *
 * `ArcpadRouter._swap` refuses a swap when `block.timestamp > deadline`. If a
 * deadline is computed from `Date.now()` on a machine whose clock runs ten
 * minutes fast, every swap that machine sends reverts `DeadlinePassed`
 * instantly and forever -- and NO local test can see it, because on a devchain
 * the chain's clock and the browser's clock are the same clock. That is failure
 * mode 3 with a whole machine as the unstated precondition.
 *
 * MEASURED 2026-08-09 against `rpc.testnet.arc.io`: the head block's timestamp
 * and this machine's `Date.now()` differed by 1 second. So the skew is not a
 * theory about a broken clock -- it is a quantity, it is normally tiny, and the
 * only way to know is to read the head.
 *
 * ONE READ EVERY 30 SECONDS, AND THAT IS THE WHOLE COST. Arc rate-limits
 * sequential `eth_call`s and this page already spends its budget on quotes at
 * 2 s. A deadline five minutes out does not need a fresher anchor than half a
 * minute, and 30 s is ~85 Arc blocks.
 *
 * `>` NOT `>=` IS THE ROUTER'S BUSINESS, and it made the Arc-specific choice
 * already: block timestamps here may REPEAT (49.0% of consecutive finalized
 * pairs share one), so a `>=` deadline would reject a valid transaction whose
 * deadline is "this block" on roughly half of all blocks.
 */
export const CHAIN_CLOCK_POLL_MS = 30_000

export type ChainNow = {
  /** Head block timestamp in seconds. `null` until the first read lands. */
  readonly seconds: bigint | null
  readonly isPending: boolean
}

export function useChainNow(enabled = true): ChainNow {
  const { data, isPending } = useBlock({
    // NOT `watch: true`. Watching subscribes per block (~350 ms on Arc), which
    // is three reads a second for a value used to add 300 to.
    query: {
      enabled,
      refetchInterval: CHAIN_CLOCK_POLL_MS,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    },
  })
  const timestamp = (data as { timestamp?: unknown } | undefined)?.timestamp
  return {
    seconds: typeof timestamp === 'bigint' ? timestamp : null,
    isPending: enabled && isPending,
  }
}
