'use client'

import { feeEscrowAbi } from '@arcpad/shared/browser'
import { useCallback } from 'react'
import { useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import type { HexAddress } from '@/components/read/types'
import type { TradePhase } from '@/components/token/tradeModel'
import { getWebConfig } from '@/lib/addresses'
import { type ArcpadFailure, decodeArcpadError } from '@/lib/decodeRevert'

/**
 * ==========================================================================
 *  `FeeEscrow.claim(recipient)` -- PERMISSIONLESS, AND THE UI SAYS SO.
 * ==========================================================================
 *
 * ```solidity
 * /// @dev IZINSIZDIR: cagiran kim olursa olsun fon alicisina gider. Creator'in
 * ///      gas'i olmasa bile ucreti kilitli kalmaz. Cagiran bundan kar edemez.
 * function claim(address recipient) external {
 *     uint256 amount = owed[recipient];
 *     if (amount == 0) revert NothingToClaim();
 *     ...
 *     (bool ok,) = recipient.call{value: amount}("");
 * ```
 *
 * THREE CONSEQUENCES, ALL OF THEM VISIBLE ON SCREEN:
 *
 *   1. THE BUTTON IS NOT GATED ON "IS THIS YOUR ADDRESS". Gating it would
 *      invent a restriction the contract does not have, and the contract's own
 *      NatSpec names the case it was written for -- a creator with no gas.
 *   2. THE PAYEE IS ALWAYS THE PROFILE'S ADDRESS. `claim` reads `owed[recipient]`
 *      and pays `recipient`; the sender cannot redirect it and cannot profit.
 *      The panel states this rather than leaving a visitor to wonder whose
 *      money they are about to move.
 *   3. THE CALLER PAYS THE GAS. That is the only thing a stranger spends, and
 *      it is a real cost, so the panel says that too.
 *
 * ONLY ONE ACTION IS OFFERED, AND ONLY WHEN THE CHAIN SAYS THERE IS SOMETHING
 * TO CLAIM. `owed()` is read LIVE rather than taken from the indexer row: the
 * indexed `claimable_wei` can be minutes old, and sending a `claim` against a
 * stale non-zero balance costs the user gas to be told `NothingToClaim()`.
 * The database figure is what the page DISPLAYS; the chain figure is what
 * decides whether a transaction is offered. Those are different jobs.
 */

export const CLAIM_POLL_MS = 12_000

export type ClaimState =
  /** The `owed()` read has not answered yet. */
  | { readonly kind: 'loading' }
  /** The read failed. Offer nothing; never guess a balance. */
  | { readonly kind: 'unavailable' }
  /** `owed(recipient) == 0`. There is no transaction to send. */
  | { readonly kind: 'empty' }
  /** `owed(recipient) > 0`. */
  | { readonly kind: 'ready'; readonly owedWei: bigint }

export type ClaimHandle = {
  readonly state: ClaimState
  readonly phase: TradePhase
  readonly hash: `0x${string}` | undefined
  readonly failure: ArcpadFailure | null
  readonly claim: () => void
  readonly refetch: () => void
}

/** Pure, so the four-way decision is testable without a chain or a renderer. */
export function claimStateFrom(input: {
  readonly owed: bigint | undefined
  readonly failed: boolean
}): ClaimState {
  // THE FAILURE BRANCH COMES FIRST. A failed read leaves `owed` undefined, and
  // reporting that as "loading" would spin forever on a dead RPC.
  if (input.failed) return { kind: 'unavailable' }
  if (input.owed === undefined) return { kind: 'loading' }
  return input.owed === 0n ? { kind: 'empty' } : { kind: 'ready', owedWei: input.owed }
}

export function useClaim(recipient: HexAddress | undefined): ClaimHandle {
  const escrow = getWebConfig().addresses.feeEscrow

  const owedRead = useReadContract({
    address: escrow,
    abi: feeEscrowAbi,
    functionName: 'owed',
    args: recipient === undefined ? undefined : [recipient],
    query: {
      enabled: recipient !== undefined,
      // 12s, not 2s. Nothing here goes stale between blocks the way a quote
      // does, and Arc rate-limits `eth_call`s.
      refetchInterval: CLAIM_POLL_MS,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    },
  })

  const state = claimStateFrom({
    owed: typeof owedRead.data === 'bigint' ? owedRead.data : undefined,
    failed: owedRead.isError,
  })

  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    query: { enabled: write.data !== undefined },
  })

  const claimable = state.kind === 'ready'
  const claim = useCallback(() => {
    // NO TRANSACTION WITHOUT A LIVE, NON-ZERO BALANCE. Not a guard against a
    // mis-click -- a guard against spending gas to be told `NothingToClaim()`.
    if (recipient === undefined || !claimable) return
    write.writeContract({
      address: escrow,
      abi: feeEscrowAbi,
      functionName: 'claim',
      args: [recipient],
    })
  }, [claimable, escrow, recipient, write])

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
    state,
    phase,
    hash: write.data,
    claim,
    // THE ACTION KEY IS `claim`, AND IT ALREADY HAS A DICTIONARY.
    // `web/lib/failureTable.ts` has carried `claim:NothingToClaim`,
    // `claim:TransferFailed` and `claim:ZeroRecipient` since Task 14 with ZERO
    // callers -- the action existed in the error surface and nowhere else.
    // This is its first caller.
    failure: rawError === null ? null : decodeArcpadError(rawError, { action: 'claim' }),
    refetch: () => {
      void owedRead.refetch()
    },
  }
}
