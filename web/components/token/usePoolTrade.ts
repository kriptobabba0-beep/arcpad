'use client'

import { useCallback, useRef } from 'react'
import { parseEventLogs, type Log, type TransactionReceipt } from 'viem'
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import type { HexAddress } from '@/components/read/types'
import { decodePoolSwapError, type PoolFailure } from '@/lib/poolOutcome'
import { quoteWeiFromUnits } from '@/lib/quoteUnits'
import { ARCPAD_ROUTER_ABI } from '@/lib/routerAbi'
import type { PoolPlan } from './poolPlan'
import type { TradePhase } from './tradeModel'

/**
 * ==========================================================================
 *  REALISED AMOUNTS COME FROM `RouterSwap`, NOT FROM THE QUOTE.
 * ==========================================================================
 *
 * The same rule the curve receipt follows, for the same reason: a quote is what
 * was asked for and the event is what happened. Here the two can differ because
 * the pool moves between the `eth_call` and the mine -- within the slippage
 * bound, by construction, but not identically.
 *
 * ============ WHY `RouterSwap` AND NOT `PoolManager.Swap` ============
 *
 * `PoolManager.Swap`'s `sender` is the ROUTER; the end user is not in that log
 * and cannot be recovered from it. `RouterSwap` carries `payer` and `recipient`
 * as indexed fields precisely because the pool layer loses the identity. It is
 * also the only log in the receipt that states the two amounts in the user's
 * own terms, net of the hook fee.
 *
 * `buy` IS NOT INDEXED -- the same choice `BondingCurve.Trade` made for `isBuy`.
 * A filter written against `args: { buy: true }` returns SILENTLY EMPTY, which
 * is why the filter below is on the event NAME and the ROUTER ADDRESS only.
 *
 * ============ NO OPTIMISTIC ROW ============
 *
 * The curve receipt builds a `TradeRow` so it can be de-duplicated against the
 * indexer by `eventSeq`. A pool row is written by the indexer from
 * `PoolManager.Swap` + `ArcpadHook.SwapFeeCollected`, whose `event_seq` belongs
 * to logs this receipt does not identify -- `RouterSwap`'s own log index is a
 * third one. Inventing a row keyed on the wrong sequence would produce a
 * DUPLICATE in the list rather than a de-duplicated one, so this hook reports
 * amounts and lets the list come from the indexer.
 */

export type RealisedPoolSwap = {
  readonly buy: boolean
  /** Buy: 6-decimal USDC units. Sell: 18-decimal token wei. */
  readonly amountIn: bigint
  /** Buy: 18-decimal token wei. Sell: 6-decimal USDC units. */
  readonly amountOut: bigint
  /** The USDC leg in the 18-decimal view every `<Money>` on this site draws. */
  readonly quoteWei: bigint
  /** The token leg, 18-decimal. */
  readonly tokensTok: bigint
  readonly txHash: `0x${string}`
}

/**
 * Reads the router's own log out of a receipt.
 *
 * `null` when the receipt carries no `RouterSwap` from THIS router -- which is
 * what a wallet that broadcast something else would produce, and is a state
 * worth showing as "we cannot read this receipt" rather than as a zero trade.
 */
export function realisedFromRouterReceipt(
  receipt: Pick<TransactionReceipt, 'logs' | 'transactionHash'>,
  router: HexAddress,
): RealisedPoolSwap | null {
  const events = parseEventLogs({
    abi: ARCPAD_ROUTER_ABI,
    eventName: 'RouterSwap',
    logs: receipt.logs as Log[],
  })
  const mine = events.find((event) => event.address.toLowerCase() === router.toLowerCase())
  if (mine === undefined) return null

  const { buy, amountIn, amountOut } = mine.args
  // THE SEAM, ONCE. On a buy the INPUT leg is USDC; on a sell it is the OUTPUT
  // leg. Reading the same leg on both would report a token count as a price.
  const quoteUnits = buy ? amountIn : amountOut
  const tokens = buy ? amountOut : amountIn
  return {
    buy,
    amountIn,
    amountOut,
    quoteWei: quoteWeiFromUnits(quoteUnits),
    tokensTok: tokens,
    txHash: receipt.transactionHash,
  }
}

export type PoolTradeHandle = {
  readonly submit: (plan: PoolPlan) => void
  readonly phase: TradePhase
  readonly hash: `0x${string}` | undefined
  readonly failure: PoolFailure | null
  readonly realised: RealisedPoolSwap | null
  readonly reset: () => void
}

export function usePoolTrade(router: HexAddress | null): PoolTradeHandle {
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    query: { enabled: write.data !== undefined },
  })
  const submitted = useRef<PoolPlan | null>(null)

  const submit = useCallback(
    (plan: PoolPlan) => {
      // NO TRANSACTION WITHOUT A ROUTER. Not a guard against a mis-click -- a
      // guard against ever addressing `undefined`, which viem would turn into a
      // contract creation.
      if (router === null) return
      submitted.current = plan
      write.writeContract({
        address: router as `0x${string}`,
        abi: ARCPAD_ROUTER_ABI,
        // The plan carries its own entrypoint. There is no second mapping from
        // tab to function: `POOL_TAB_ACTION` does it once and the plan carries
        // the result.
        functionName: plan.action,
        args: plan.args as never,
      })
    },
    [router, write],
  )

  const phase: TradePhase = write.isPending
    ? 'awaitingSignature'
    : write.error
      ? 'failed'
      : write.data === undefined
        ? 'idle'
        : receipt.isSuccess
          ? 'confirmed'
          : receipt.isError
            ? 'failed'
            : 'pending'

  const rawError = write.error ?? receipt.error ?? null

  return {
    submit,
    phase,
    hash: write.data,
    failure: rawError === null ? null : decodePoolSwapError(rawError),
    realised:
      receipt.isSuccess && receipt.data !== undefined && router !== null
        ? realisedFromRouterReceipt(receipt.data, router)
        : null,
    reset: useCallback(() => {
      submitted.current = null
      write.reset()
    }, [write]),
  }
}
