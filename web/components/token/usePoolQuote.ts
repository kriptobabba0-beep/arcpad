'use client'

import { useSimulateContract } from 'wagmi'
import type { HexAddress } from '@/components/read/types'
import { decodePoolSwapError, type PoolFailure } from '@/lib/poolOutcome'
import { ARCPAD_ROUTER_ABI, decodeQuoteResult } from '@/lib/routerAbi'
import type { PoolQuoteRequest } from './poolPlan'

/**
 * ==========================================================================
 *  A QUOTE IS AN `eth_call` THAT REVERTS ON PURPOSE.
 * ==========================================================================
 *
 * `ArcpadRouter.quote*` is `nonpayable`, not `view`, and that is load-bearing:
 * a v4 price is only knowable by running the swap. The pool fee is ZERO and
 * `ArcpadHook` takes its cut through `beforeSwap`/`afterSwap` return deltas, so
 * any off-chain re-derivation of the AMM curve cannot see the fee. The router
 * therefore runs the REAL swap through the REAL hook inside `unlock` and
 * reverts with `QuoteResult(amountIn, amountOut)` before settling; the outer
 * frame catches it, checks the selector, and re-bubbles anything else. Its own
 * suite asserts `quote == realized` for four shapes x two currency orderings.
 *
 * SO A SUCCESSFUL QUOTE ARRIVES AS AN ERROR, and this hook is the only place
 * that inversion is handled. Two consequences that are easy to get wrong:
 *
 *   1. `data` is ALWAYS undefined. A hook that read `simulate.data` would show
 *      nothing, forever, and look like a loading state.
 *   2. `error` is USUALLY not a failure. Reporting `simulate.error` to the user
 *      would paint every working quote red.
 *
 * NO ACCOUNT IS NEEDED. `_quote` builds its `Call` with `payer: address(0)` and
 * never settles, so the quote works before a wallet is connected -- which is
 * what lets the panel show a price to a visitor.
 *
 * TWO SECONDS, THE SAME AS `useCurveState`. The freshness contract must not
 * differ between the two venues; and what actually protects the user from a
 * stale quote is the `minOut`/`maxIn` argument that goes on chain, not the
 * polling interval.
 */
export const POOL_QUOTE_POLL_MS = 2000

export type PoolQuoteState =
  /** No request to make -- empty field, or no router configured. */
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  /** `amountIn`/`amountOut` in the router's own units. See `PoolPlan`. */
  | { readonly kind: 'ok'; readonly amountIn: bigint; readonly amountOut: bigint }
  /** The quote reverted for a real reason -- including "there is no pool". */
  | { readonly kind: 'failed'; readonly failure: PoolFailure }

export type PoolQuoteHandle = {
  readonly state: PoolQuoteState
  readonly refetch: () => void
}

export function usePoolQuote(
  router: HexAddress | null,
  request: PoolQuoteRequest | null,
): PoolQuoteHandle {
  const enabled = router !== null && request !== null

  const simulate = useSimulateContract(
    enabled
      ? {
          address: router as `0x${string}`,
          abi: ARCPAD_ROUTER_ABI,
          functionName: request.fn,
          args: request.args as never,
          query: {
            enabled: true,
            refetchInterval: POOL_QUOTE_POLL_MS,
            refetchIntervalInBackground: false,
            refetchOnWindowFocus: true,
            // A revert is the SUCCESS path here, so retrying it is pure cost
            // against a rate-limited RPC.
            retry: false,
          },
        }
      : { query: { enabled: false } },
  )

  return {
    state: poolQuoteStateFrom({
      enabled,
      isPending: simulate.isPending,
      error: simulate.error,
    }),
    refetch: () => {
      void simulate.refetch()
    },
  }
}

/**
 * Pure, so the inversion is testable without a chain or a renderer.
 *
 * ORDER MATTERS. `decodeQuoteResult` runs FIRST: a `QuoteResult` is on the
 * router's own error ABI, so `decodePoolSwapError` would happily name it and
 * the panel would render the successful quote as a fault. (`poolOutcome` keeps
 * a row for exactly that mistake so it is loud rather than silent.)
 */
export function poolQuoteStateFrom(input: {
  readonly enabled: boolean
  readonly isPending: boolean
  readonly error: unknown
}): PoolQuoteState {
  if (!input.enabled) return { kind: 'idle' }

  if (input.error !== null && input.error !== undefined) {
    const quote = decodeQuoteResult(input.error)
    if (quote !== null) return { kind: 'ok', amountIn: quote.amountIn, amountOut: quote.amountOut }
    return { kind: 'failed', failure: decodePoolSwapError(input.error) }
  }

  if (input.isPending) return { kind: 'loading' }

  /*
   * NO ERROR AND NOT PENDING MEANS THE CALL RETURNED NORMALLY -- WHICH THIS
   * ENTRYPOINT CANNOT DO.
   *
   * The router raises `QuoteDidNotRevert()` if its own `unlock` ever returns,
   * so a plain success can only mean the configured address is not an
   * `ArcpadRouter`. Falling back to `loading` here would spin forever and read
   * as a slow RPC; this names the configuration fault instead. It is the same
   * decision `useCurveState` makes when a read is the wrong shape: half a state
   * is more dangerous than none.
   */
  return {
    kind: 'failed',
    failure: decodePoolSwapError(
      new Error(
        'The quote returned instead of reverting. QuoteResult() is how ArcpadRouter answers, so ' +
          'the address configured as the router is not one.',
      ),
    ),
  }
}
