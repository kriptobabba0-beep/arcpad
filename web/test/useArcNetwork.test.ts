import { ARC_TESTNET_CHAIN_ID } from '@arcpad/shared/browser'
import { describe, expect, it } from 'vitest'
import { type ConnectionStatus, evaluateArcNetwork } from '../hooks/useArcNetwork'

const EXPECTED = ARC_TESTNET_CHAIN_ID
const OTHER = 1

describe('wrong-network detection', () => {
  it('flags a connected wallet on another chain', () => {
    expect(
      evaluateArcNetwork({ status: 'connected', chainId: OTHER, expectedChainId: EXPECTED })
        .wrongNetwork,
    ).toBe(true)
  })

  it('does not flag a connected wallet already on Arc', () => {
    expect(
      evaluateArcNetwork({ status: 'connected', chainId: EXPECTED, expectedChainId: EXPECTED })
        .wrongNetwork,
    ).toBe(false)
  })

  /**
   * THE CASE THE GUARD EXISTS FOR.
   *
   * While disconnected, wagmi reports `chainId: undefined` -- NOT the config
   * default -- so `chainId !== expected` is true for every first-time visitor.
   * Without the `status === 'connected'` guard, everyone lands on a "wrong
   * network" banner before touching a wallet, and the warning that matters
   * becomes the one people have learned to dismiss.
   */
  it('never flags a visitor who has not connected, in any non-connected status', () => {
    for (const status of ['disconnected', 'connecting', 'reconnecting'] as ConnectionStatus[]) {
      for (const chainId of [undefined, OTHER, EXPECTED]) {
        expect(
          evaluateArcNetwork({ status, chainId, expectedChainId: EXPECTED }).wrongNetwork,
          `${status} / chainId=${String(chainId)}`,
        ).toBe(false)
      }
    }
  })

  // Anti-vacuity: the sweep above asserts `false` everywhere, which a function
  // that always returned false would also satisfy. This is the pair that
  // proves the sweep measured the guard and not a constant.
  it('the only difference between the flagged and unflagged case is the status', () => {
    const input = { chainId: OTHER, expectedChainId: EXPECTED } as const
    expect(evaluateArcNetwork({ ...input, status: 'connected' }).wrongNetwork).toBe(true)
    expect(evaluateArcNetwork({ ...input, status: 'disconnected' }).wrongNetwork).toBe(false)
  })
})
