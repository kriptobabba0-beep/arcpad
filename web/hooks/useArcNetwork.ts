'use client'

import { useConnection, useSwitchChain } from 'wagmi'
import { getWebConfig } from '../lib/addresses'

/**
 * `useAccount` is a DEPRECATED alias of `useConnection` in the installed
 * wagmi (3.7.4 -- its export barrel says so in as many words), so new code
 * uses `useConnection`.
 */

export type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected'

export type ArcNetworkVerdict = {
  /** True ONLY when a wallet is connected AND it is on the wrong chain. */
  readonly wrongNetwork: boolean
}

/**
 * THE DECISION, SEPARATED FROM THE HOOK.
 *
 * Pulled out so it can be tested without a React renderer -- adding
 * `@testing-library/react` and a jsdom environment would touch the shared
 * `pnpm-lock.yaml`, and the interesting logic is three lines that have nothing
 * to do with React.
 *
 * The `status === 'connected'` guard is the whole point. While disconnected,
 * wagmi's `chainId` is UNDEFINED -- not the config's default -- so a naive
 * `chainId !== expected` shows a "wrong network" banner to every first-time
 * visitor before they have connected anything, which teaches people to
 * dismiss the one warning that matters.
 */
export function evaluateArcNetwork(input: {
  status: ConnectionStatus
  chainId: number | undefined
  expectedChainId: number
}): ArcNetworkVerdict {
  return { wrongNetwork: input.status === 'connected' && input.chainId !== input.expectedChainId }
}

export function useArcNetwork() {
  const { status, address, chainId } = useConnection()
  const { switchChain, isPending } = useSwitchChain()
  const expectedChainId = getWebConfig().chain.id
  const { wrongNetwork } = evaluateArcNetwork({
    status: status as ConnectionStatus,
    chainId,
    expectedChainId,
  })

  return {
    status,
    address,
    chainId,
    expectedChainId,
    wrongNetwork,
    /**
     * Reads are unaffected by the wallet's chain -- the RPC transport is ours,
     * not the wallet's -- so a visitor on the wrong network can browse the
     * whole site and is blocked only at signing.
     */
    switchToArc: () => switchChain({ chainId: expectedChainId }),
    isSwitching: isPending,
  }
}
