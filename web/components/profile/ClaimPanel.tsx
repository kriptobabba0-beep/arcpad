'use client'

import type { HexAddress } from '@/components/read/types'
import { Address, shortenAddress } from '@/components/ui/Address'
import { Button } from '@/components/ui/Button'
import { Money } from '@/components/ui/Money'
import { useArcNetwork } from '@/hooks/useArcNetwork'
import { type ClaimHandle, useClaim } from './useClaim'

/**
 * THE ONE ACTION A PROFILE PAGE CAN HONESTLY OFFER.
 *
 * `BondingCurve.creator` is IMMUTABLE and there is no reassignment path on
 * chain -- `creator_history` exists in the schema for a transfer that no
 * contract implements. So this page offers no "transfer creator", no "edit
 * metadata", no "renounce": those would be buttons for capabilities that do
 * not exist, and this repository has already shipped one screen that promised
 * something the chain could not do.
 *
 * WHAT DOES EXIST IS `FeeEscrow.claim(recipient)`, and it is PERMISSIONLESS.
 * The panel therefore renders the action for ANY visitor and states plainly
 * where the money goes and who pays for the transaction. See `useClaim.ts` for
 * the contract quote and the three consequences.
 */

export type ClaimPanelProps = {
  readonly recipient: HexAddress
  /** Test seam: lets the states be rendered without wagmi's provider tree. */
  readonly handle?: ClaimHandle
  readonly connected?: boolean
  readonly wrongNetwork?: boolean
  readonly onSwitch?: () => void
}

export function ClaimPanel(props: ClaimPanelProps) {
  const live = useClaimUnlessProvided(props)
  return <ClaimView {...props} {...live} />
}

/**
 * THE HOOK IS CALLED UNCONDITIONALLY.
 *
 * `useClaim` cannot sit behind `props.handle === undefined`: React's rules of
 * hooks are not a style guide, and a component that calls a different number
 * of hooks on two renders corrupts the hook list. The injected handle wins
 * AFTER the call, not instead of it -- `recipient: undefined` makes every read
 * inside `useClaim` disabled, so the test path costs nothing.
 */
function useClaimUnlessProvided(props: ClaimPanelProps): {
  handle: ClaimHandle
  connected: boolean
  wrongNetwork: boolean
  onSwitch: () => void
} {
  const injected = props.handle !== undefined
  const liveHandle = useClaim(injected ? undefined : props.recipient)
  const network = useArcNetwork()
  return {
    handle: props.handle ?? liveHandle,
    connected: props.connected ?? network.status === 'connected',
    wrongNetwork: props.wrongNetwork ?? network.wrongNetwork,
    onSwitch: props.onSwitch ?? network.switchToArc,
  }
}

export function ClaimView({
  recipient,
  handle,
  connected,
  wrongNetwork,
  onSwitch,
}: {
  recipient: HexAddress
  handle: ClaimHandle
  connected: boolean
  wrongNetwork: boolean
  onSwitch: () => void
}) {
  const { state, phase, failure } = handle
  const busy = phase === 'awaitingSignature' || phase === 'pending'

  return (
    <div className="flex flex-col gap-2 rounded-input border border-border bg-surface-2 p-3">
      {state.kind === 'loading' ? (
        <p className="text-[12px] text-muted" data-testid="claim-loading">
          Checking the escrow…
        </p>
      ) : state.kind === 'unavailable' ? (
        <p className="text-[12px] text-muted" data-testid="claim-unavailable">
          {/*
            "WE COULD NOT ASK" IS NOT "THERE IS NOTHING". Collapsing the two
            would tell a creator with a real balance that they have none.
          */}
          The fee escrow did not answer, so we cannot tell what is claimable right now. The figure
          above comes from the indexer.
        </p>
      ) : state.kind === 'empty' ? (
        <p className="text-[12px] text-muted" data-testid="claim-empty">
          Nothing to claim. The escrow reports a zero balance for this address, so{' '}
          <code className="text-[11px]">claim()</code> would revert.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-muted">
              On chain right now:{' '}
              <Money native={state.owedWei} rounding="down" unit className="text-text" />
            </span>
            {connected && wrongNetwork ? (
              <Button variant="secondary" size="sm" onClick={onSwitch} data-testid="claim-switch">
                Switch network
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handle.claim}
                disabled={busy || !connected}
                data-testid="claim-button"
              >
                {phase === 'awaitingSignature'
                  ? 'Confirm in your wallet'
                  : phase === 'pending'
                    ? 'Claiming…'
                    : `Claim to ${shortenAddress(recipient)}`}
              </Button>
            )}
          </div>

          {/*
            ============ THE SENTENCE THAT MAKES THE BUTTON HONEST ============

            `claim(address)` is permissionless and always pays `recipient`. A
            visitor who is not this creator can send it, and the only thing
            they spend is gas. Saying so is not a disclaimer -- without it, a
            button labelled "Claim" on someone else's profile reads like a way
            to take their money.
          */}
          <p className="text-[11px] text-muted" data-testid="claim-permissionless">
            Anyone can send this transaction; the escrow always pays{' '}
            <Address value={recipient} label="fee recipient" />. The sender pays the gas and
            receives nothing.
          </p>

          {connected ? null : (
            <p className="text-[11px] text-muted" data-testid="claim-connect">
              Connect a wallet to send it.
            </p>
          )}
        </>
      )}

      {phase === 'confirmed' ? (
        <p className="text-[12px] text-positive" data-testid="claim-confirmed">
          Claimed. The escrow paid {shortenAddress(recipient)}.
        </p>
      ) : null}

      {failure === null ? null : (
        <div className="rounded-input border border-negative/40 bg-negative/8 px-2.5 py-2 text-[12px]">
          <p className="font-medium" data-testid="claim-failure">
            {failure.title}
          </p>
          <p className="text-muted">{failure.detail}</p>
          {failure.remedy === undefined ? null : (
            <p className="text-muted">{failure.remedy}</p>
          )}
        </div>
      )}
    </div>
  )
}
