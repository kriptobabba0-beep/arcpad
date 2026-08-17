'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import type { HexAddress } from '@/components/read/types'
import { Button } from '@/components/ui/Button'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { getWebConfig } from '@/lib/addresses'
import type { GraduationOutcome } from '@/lib/graduationOutcome'
import type { ConnectionState, TradePhase } from './tradeModel'
import { type GraduationState, useGraduation } from './useGraduation'

/**
 * ============ THE FALLBACK, MADE REACHABLE ============
 *
 * A curve that crosses its threshold stops trading and then must be GRADUATED
 * by a separate call. There is no automatic path and there cannot be one:
 * `BondingCurve.graduate()` requires `msg.sender == graduationTarget` and the
 * curve's creation code is frozen at `8e2460ff…4982f`, so the curve can never
 * call the target itself. The keeper is the primary caller. The FALLBACK is
 * that `ArcpadLocker.graduate(address)` is `external` with no access control --
 * anyone may send it. This panel is the user-facing face of that fallback, and
 * until it existed the fallback was a property of a contract that no human had
 * a way to reach.
 *
 * ============ AND TODAY IT MUST NOT OFFER A BUTTON ============
 *
 * On the production factory `graduationTarget` is `0x0` DELIBERATELY. Measured
 * live by the keeper on 2026-08-09 at block 56034198, and again by this app's
 * own read: `locker.graduate(0xDdB9e739…f27b)` returns `0xfe30fa5b`,
 * `GraduationTargetUnset()`. A button in that state can do exactly one thing --
 * take the user's gas and revert -- so the panel renders an EXPLANATION and no
 * control. `useGraduation` makes that structural rather than cosmetic: the
 * `ready` state is the only one carrying a target, and `graduate()` returns
 * early without one, so there is no arrangement of props that sends a
 * transaction to the zero address.
 *
 * The wording follows `keeper/src/graduate/outcome.ts`, which had to make the
 * same distinction for the same reason: "nothing is wrong, nothing is stuck".
 * A screen that said "graduation failed" here would be describing a healthy
 * system as a broken one, every day, for as long as the platform chooses not to
 * arm its target.
 */

export type GraduationViewProps = {
  readonly state: GraduationState
  readonly connection: ConnectionState
  readonly chainName: string
  readonly phase: TradePhase
  readonly hash?: `0x${string}` | undefined
  readonly failure: GraduationOutcome | null
  readonly explorerUrl?: string | undefined
  readonly onGraduate?: (() => void) | undefined
  readonly onConnect?: (() => void) | undefined
  readonly onSwitch?: (() => void) | undefined
}

const TONE_CLASS = {
  neutral: 'text-muted',
  warn: 'text-muted',
  error: 'text-negative',
} as const

export function GraduationView({
  state,
  connection,
  chainName,
  phase,
  hash,
  failure,
  explorerUrl,
  onGraduate,
  onConnect,
  onSwitch,
}: GraduationViewProps) {
  if (state.kind === 'graduated') {
    return (
      <p className="text-[13px] leading-relaxed text-muted" data-testid="graduation-graduated">
        This curve has graduated: the proceeds and the pool&rsquo;s token supply were paid out and
        the pool is open. Trading happens there now.
      </p>
    )
  }

  if (state.kind === 'loading') {
    return (
      <p className="text-[12px] text-muted" data-testid="graduation-loading">
        Checking whether this curve has been graduated&hellip;
      </p>
    )
  }

  if (state.kind === 'unavailable') {
    return (
      <p className="text-[12px] text-muted" data-testid="graduation-unavailable">
        We could not read the graduation status from the chain, so we are not offering an action we
        cannot check first.
      </p>
    )
  }

  if (state.kind === 'unarmed') {
    /*
     * NO BUTTON, AND NO PROMISE OF A DATE. The two things a reader needs are
     * WHY nothing is happening and whether anything is at risk. The second is
     * the one people actually want: the answer is no, and it is a property of
     * the contract rather than of anyone's diligence.
     */
    return (
      <div className="flex flex-col gap-1.5" data-testid="graduation-unarmed">
        <p className="text-[13px] font-medium">Waiting on the launchpad.</p>
        <p className="text-[12px] leading-relaxed text-muted">
          Graduation is a call anyone may send, but this launchpad has not set a graduation target
          yet, so the call would be refused. Nothing is at risk while it waits: the sale proceeds
          and the pool&rsquo;s token supply stay in the curve, and no one can move them anywhere
          else.
        </p>
      </div>
    )
  }

  const label =
    connection === 'disconnected'
      ? 'Connect wallet'
      : connection === 'wrongNetwork'
        ? `Switch to ${chainName}`
        : phase === 'awaitingSignature'
          ? 'Confirm in your wallet'
          : phase === 'pending'
            ? 'Graduating…'
            : 'Graduate'
  const press =
    connection === 'disconnected'
      ? onConnect
      : connection === 'wrongNetwork'
        ? onSwitch
        : onGraduate

  return (
    <div className="flex flex-col gap-2" data-testid="graduation-ready">
      <p className="text-[13px] font-medium">Ready to graduate.</p>
      <p className="text-[12px] leading-relaxed text-muted">
        The pool has not been opened yet. Anyone may open it and arcpad&rsquo;s keeper normally does
        within seconds; if it has not, you can. You pay the gas and receive nothing for it — the
        proceeds and the token supply go to the pool, not to the sender.
      </p>
      <Button
        variant="secondary"
        size="md"
        disabled={phase === 'awaitingSignature' || phase === 'pending'}
        onClick={press}
        data-testid="graduate-submit"
      >
        {label}
      </Button>

      {phase === 'pending' && hash !== undefined ? (
        <p role="status" className="text-[12px] text-muted" data-testid="graduation-pending">
          Submitted.{' '}
          {explorerUrl === undefined ? (
            <span className="tabular-nums">{hash}</span>
          ) : (
            <a className="underline" href={`${explorerUrl}/tx/${hash}`} rel="noreferrer">
              View on the explorer
            </a>
          )}
        </p>
      ) : null}

      {failure === null ? null : (
        <div
          role={failure.tone === 'error' ? 'alert' : 'status'}
          className={`text-[12px] leading-relaxed ${TONE_CLASS[failure.tone]}`}
          data-testid="graduation-failure"
        >
          <p className="font-medium">{failure.title}</p>
          <p>{failure.body}</p>
          <p>{failure.remedy}</p>
          {failure.showRaw ? (
            <p className="mt-1 break-all font-mono text-[11px]" data-testid="graduation-raw">
              {String(failure.name)}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function GraduationPanel({ curve }: { curve: HexAddress }) {
  const router = useRouter()
  const network = useArcNetwork()
  const graduation = useGraduation(curve)

  // A LANDED GRADUATION CHANGES THE SERVER-RENDERED PAGE, not just this panel:
  // the lifecycle comes from the indexer row or the chain read above, so the
  // notice, the stat row and the chart all move with it.
  const landed = graduation.phase === 'confirmed'
  useEffect(() => {
    if (!landed) return
    graduation.refetch()
    router.refresh()
    // Only on the transition to `confirmed`. The other dependencies change
    // identity every render and would spin this into a refresh loop.
  }, [landed])

  const connection: ConnectionState = network.wrongNetwork
    ? 'wrongNetwork'
    : network.status === 'connected'
      ? 'connected'
      : 'disconnected'

  return (
    <GraduationView
      state={graduation.state}
      connection={connection}
      chainName={getWebConfig().chain.name}
      phase={graduation.phase}
      hash={graduation.hash}
      failure={graduation.failure}
      explorerUrl={getWebConfig().chain.blockExplorers.default.url}
      onGraduate={graduation.graduate}
      onSwitch={network.switchToArc}
      onConnect={() => {
        // The shell owns connecting; this points at it rather than opening a
        // second connector list. Same rationale as `TradePanel`.
        document.querySelector<HTMLElement>('[data-wallet-connect]')?.click()
      }}
    />
  )
}
