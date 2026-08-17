'use client'

import { bondingCurveAbi, launchFactoryAbi } from '@arcpad/shared/browser'
import { useCallback } from 'react'
import {
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import type { HexAddress } from '@/components/read/types'
import { ARCPAD_LOCKER_ABI } from '@/lib/graduationAbi'
import { decodeGraduationError, type GraduationOutcome } from '@/lib/graduationOutcome'
import type { TradePhase } from './tradeModel'

/**
 * ============ THE GRADUATION STATE, READ LIVE, EVERY TIME ============
 *
 * THREE FACTS AND NOT ONE OF THEM IS A CONSTANT:
 *
 *   `curve.graduated()`      -- terminal, latches true, never reverts back.
 *   `curve.factory()`        -- the factory THIS curve was born from.
 *   `factory.graduationTarget()` -- WHO may graduate it, and where we send.
 *
 * THE TARGET IS NOT READ FROM THE ADDRESS BOOK, AND THAT IS THE POINT. The book
 * carries `arcpadLocker`, and baking it into the build would be the exact defect
 * AGENT-CONTEXT already records for `protocolTreasury()`: "anything caching it
 * pays the old treasury forever after a rotation". `graduationTarget` is
 * governable -- `proposeGraduationTarget` + a three-day delay +
 * `applyGraduationTarget`, and the apply is PERMISSIONLESS -- so it can move
 * with zero notice from this app's point of view. The transaction is therefore
 * addressed to whatever the factory says right now, and if the factory says
 * `0x0` there is no transaction to offer at all.
 *
 * AND THE FACTORY COMES FROM THE CURVE, NOT FROM `getWebConfig()`.
 * `BondingCurve.graduate()` resolves its target through ITS OWN immutable
 * `factory`; asking a different factory would answer a question the chain will
 * not ask. Two rounds rather than one, for the same reason `readChainToken`
 * takes two: the second read's address is the first read's answer.
 *
 * POLLING IS 12 s, NOT 2 s. `useCurveState` polls at 2 s because a quote goes
 * stale between blocks. Nothing here goes stale in that sense: `graduated`
 * latches once and the target changes on a three-day timelock. Arc rate-limits
 * `eth_call`s and this page already spends its share on reserves.
 */
export const GRADUATION_POLL_MS = 12_000

export type GraduationState =
  /** Reads still in flight. Render nothing actionable. */
  | { readonly kind: 'loading' }
  /** A read failed. Say so; never guess a target. */
  | { readonly kind: 'unavailable' }
  /** `graduationTarget == 0x0`. NO ACTION MAY BE OFFERED. */
  | { readonly kind: 'unarmed' }
  /** `complete && !graduated && target != 0x0`. */
  | { readonly kind: 'ready'; readonly target: HexAddress }
  /** `graduated()` is already true on chain. */
  | { readonly kind: 'graduated' }

export type GraduationHandle = {
  readonly state: GraduationState
  readonly phase: TradePhase
  readonly hash: `0x${string}` | undefined
  readonly failure: GraduationOutcome | null
  readonly graduate: () => void
  readonly refetch: () => void
}

const ZERO = '0x0000000000000000000000000000000000000000'

/** Pure, so the four-way decision is testable without a chain or a renderer. */
export function graduationStateFrom(input: {
  readonly graduated: boolean | undefined
  readonly target: string | undefined
  readonly failed: boolean
}): GraduationState {
  // GRADUATED WINS OVER EVERYTHING, including a failed target read: a curve that
  // has graduated needs no target and asking for one cannot un-graduate it.
  if (input.graduated === true) return { kind: 'graduated' }
  if (input.failed) return { kind: 'unavailable' }
  if (input.graduated === undefined || input.target === undefined) return { kind: 'loading' }
  if (input.target.toLowerCase() === ZERO) return { kind: 'unarmed' }
  return { kind: 'ready', target: input.target.toLowerCase() as HexAddress }
}

export function useGraduation(curve: HexAddress | undefined): GraduationHandle {
  const curveReads = useReadContracts({
    // ONE multicall. Arc rate-limits sequential calls, and a partial answer here
    // would be worse than none: `graduated` true with a stale factory would send
    // a transaction to the wrong contract.
    allowFailure: false,
    contracts: [
      { address: curve as `0x${string}`, abi: bondingCurveAbi, functionName: 'graduated' },
      { address: curve as `0x${string}`, abi: bondingCurveAbi, functionName: 'factory' },
    ],
    query: {
      enabled: curve !== undefined,
      refetchInterval: GRADUATION_POLL_MS,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    },
  })

  const values = curveReads.data as readonly unknown[] | undefined
  const graduated = typeof values?.[0] === 'boolean' ? (values[0] as boolean) : undefined
  const factory = typeof values?.[1] === 'string' ? (values[1] as `0x${string}`) : undefined

  const targetRead = useReadContract({
    address: factory,
    abi: launchFactoryAbi,
    functionName: 'graduationTarget',
    query: {
      enabled: factory !== undefined,
      refetchInterval: GRADUATION_POLL_MS,
      refetchIntervalInBackground: false,
    },
  })

  const state = graduationStateFrom({
    graduated,
    target: typeof targetRead.data === 'string' ? targetRead.data : undefined,
    failed: curveReads.isError || targetRead.isError,
  })

  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    query: { enabled: write.data !== undefined },
  })

  const target = state.kind === 'ready' ? state.target : undefined
  const graduate = useCallback(() => {
    // NO TRANSACTION WITHOUT A TARGET. Not a guard against a mis-click -- a
    // guard against ever addressing `0x0`, which is the one call that is
    // guaranteed to fail and to cost the user gas for the privilege.
    if (curve === undefined || target === undefined) return
    write.writeContract({
      address: target as `0x${string}`,
      abi: ARCPAD_LOCKER_ABI,
      functionName: 'graduate',
      args: [curve as `0x${string}`],
    })
  }, [curve, target, write])

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
    failure: rawError === null ? null : decodeGraduationError(rawError),
    graduate,
    /*
     * NOT memoised, on purpose. `useCallback` here would have to either depend
     * on the two query objects -- which change identity every render, so the
     * memo would buy nothing -- or capture them with an empty dependency list,
     * which is a stale closure wearing the costume of an optimisation. Nothing
     * downstream compares this by identity, so a fresh arrow is the honest
     * shape. (This repo has no `react-hooks` eslint plugin, so the reason is
     * written rather than disabled.)
     */
    refetch: () => {
      void curveReads.refetch()
      void targetRead.refetch()
    },
  }
}
