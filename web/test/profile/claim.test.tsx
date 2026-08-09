import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { HexAddress } from '@/components/read/types'
import { ClaimView } from '@/components/profile/ClaimPanel'
import { type ClaimHandle, claimStateFrom } from '@/components/profile/useClaim'
import { renderWithProviders } from '../ui/harness'
import { CREATOR } from './fixtures'

/**
 * ==========================================================================
 *  `FeeEscrow.claim(recipient)` -- THE FIRST CALLER OF AN ACTION THAT HAD NONE.
 * ==========================================================================
 *
 * `claim` has been an `ArcpadAction` in `web/lib/failureTable.ts` since Task
 * 14, with all three of the escrow's errors mapped (`NothingToClaim`,
 * `TransferFailed`, `ZeroRecipient`) and covered by `decodeRevert.test.ts` and
 * `errors/copy.test.ts`. It had ZERO callers -- the error surface existed and
 * the button did not, which is this repository's failure mode 1 in its purest
 * form: a property covered on one entrypoint (the decoder) while the entrypoint
 * that would produce it (a transaction) was never written.
 *
 * `profile-page.test.tsx` asserts the panel is MOUNTED by the page. This file
 * asserts what it says in each state, with the handle injected so the states
 * are reachable without a chain.
 */

const ACCOUNT = CREATOR as HexAddress

function handle(over: Partial<ClaimHandle> = {}): ClaimHandle {
  return {
    state: { kind: 'ready', owedWei: 5_036_496_595_214_216_153n },
    phase: 'idle',
    hash: undefined,
    failure: null,
    claim: vi.fn(),
    refetch: vi.fn(),
    ...over,
  }
}

function renderClaim(over: Partial<ClaimHandle> = {}, connected = true, wrongNetwork = false) {
  const h = handle(over)
  renderWithProviders(
    <ClaimView
      recipient={ACCOUNT}
      handle={h}
      connected={connected}
      wrongNetwork={wrongNetwork}
      onSwitch={vi.fn()}
    />,
  )
  return h
}

describe('claimStateFrom -- four states, and the order matters', () => {
  it('a failed read is UNAVAILABLE, not loading', () => {
    // `owed` stays undefined when the read fails. Reporting that as "loading"
    // would spin forever against a dead RPC.
    expect(claimStateFrom({ owed: undefined, failed: true })).toEqual({ kind: 'unavailable' })
  })

  it('no answer yet is loading', () => {
    expect(claimStateFrom({ owed: undefined, failed: false })).toEqual({ kind: 'loading' })
  })

  it('zero owed is EMPTY -- there is no transaction to offer', () => {
    expect(claimStateFrom({ owed: 0n, failed: false })).toEqual({ kind: 'empty' })
  })

  it('a positive balance is ready and carries the amount', () => {
    expect(claimStateFrom({ owed: 7n, failed: false })).toEqual({ kind: 'ready', owedWei: 7n })
  })
})

describe('the claim panel', () => {
  /**
   * =====================================================================
   *  THE SENTENCE THAT MAKES THE BUTTON HONEST.
   * =====================================================================
   *
   * `claim(address)` is PERMISSIONLESS -- `FeeEscrow.sol`'s NatSpec says so in
   * as many words, and names the case it exists for: a creator with no gas.
   * The payee is always `recipient`; the sender cannot redirect it and cannot
   * profit, and the only thing they spend is gas.
   *
   * Without that sentence, a "Claim" button on a stranger's profile reads like
   * a way to take their money. With it, it reads like what it is.
   */
  it('states that anyone may send it and that the escrow pays the profile address', async () => {
    renderClaim()
    const note = screen.getByTestId('claim-permissionless')
    expect(note).toHaveTextContent(/anyone can send/i)
    expect(note).toHaveTextContent(/pays/i)
    expect(note).toHaveTextContent(/sender pays the gas/i)
    expect(note).toHaveTextContent(/receives nothing/i)
  })

  it('the button names the payee, so it cannot be read as "claim to me"', async () => {
    renderClaim()
    expect(screen.getByTestId('claim-button')).toHaveTextContent(/Claim to 0xe92c…2fD2/i)
  })

  it('sends the transaction when pressed', async () => {
    const h = renderClaim()
    await userEvent.click(screen.getByTestId('claim-button'))
    expect(h.claim).toHaveBeenCalledTimes(1)
  })

  /**
   * A ZERO BALANCE OFFERS NOTHING, AND SAYS WHY.
   *
   * `claim` reverts `NothingToClaim()` on a zero balance, so a button here
   * would cost the user gas to be told no. This is the LIVE state of the
   * funded deployer address today -- its escrow slots were claimed to zero on
   * 2026-08-09 -- so it is the state a visitor is most likely to see.
   */
  it('offers no button when the escrow owes nothing', async () => {
    renderClaim({ state: { kind: 'empty' } })
    expect(screen.queryByTestId('claim-button')).toBeNull()
    expect(screen.getByTestId('claim-empty')).toHaveTextContent(/Nothing to claim/i)
  })

  /**
   * "WE COULD NOT ASK" IS NOT "THERE IS NOTHING".
   *
   * Collapsing the two would tell a creator with a real balance that they have
   * none -- and they would believe it, because the sentence is identical.
   */
  it('a failed read says the escrow did not answer, not that the balance is zero', async () => {
    renderClaim({ state: { kind: 'unavailable' } })
    expect(screen.queryByTestId('claim-button')).toBeNull()
    const box = screen.getByTestId('claim-unavailable')
    expect(box).toHaveTextContent(/did not answer/i)
    expect(box).not.toHaveTextContent(/nothing to claim/i)
  })

  it('a disconnected visitor sees the amount and is told to connect', async () => {
    renderClaim({}, false)
    expect(screen.getByTestId('claim-button')).toBeDisabled()
    expect(screen.getByTestId('claim-connect')).toBeInTheDocument()
  })

  it('a wrong-network wallet is offered the switch INSTEAD of the claim', async () => {
    renderClaim({}, true, true)
    expect(screen.getByTestId('claim-switch')).toBeInTheDocument()
    // Not disabled-and-present: a button that cannot work should not be there
    // to be pressed.
    expect(screen.queryByTestId('claim-button')).toBeNull()
  })

  it('reports a revert through the claim dictionary', async () => {
    renderClaim({
      phase: 'failed',
      failure: {
        kind: 'contract',
        action: 'claim',
        name: 'NothingToClaim',
        title: 'There is nothing to claim',
        detail: 'The escrow holds no balance for this address.',
        retryable: false,
        raw: null,
      },
    })
    expect(screen.getByTestId('claim-failure')).toHaveTextContent('There is nothing to claim')
  })

  it('a confirmed claim says who was paid', async () => {
    renderClaim({ phase: 'confirmed' })
    expect(screen.getByTestId('claim-confirmed')).toHaveTextContent(/0xe92c…2fD2/i)
  })

  it('the button is busy-locked while a transaction is in flight', async () => {
    renderClaim({ phase: 'pending' })
    expect(screen.getByTestId('claim-button')).toBeDisabled()
    expect(screen.getByTestId('claim-button')).toHaveTextContent(/Claiming/i)
  })
})
