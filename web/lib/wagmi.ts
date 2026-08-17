import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors/injected'
import { getWebConfig } from './addresses'

/**
 * The chain comes from the REGISTRY, resolved through the env-configured chain
 * id -- there is no chain literal in this file, and `chain-registry.test.ts`
 * scans the tracked source to keep it that way.
 *
 * `injected()` plus wagmi's default EIP-6963 discovery: every modern wallet
 * announces itself, so an explicit connector list would only shorten it.
 *
 * The transport is OURS, not the wallet's. That is what lets a visitor on the
 * wrong network read the entire site and be stopped only at signing.
 *
 * `@arcpad/shared/browser`, not `@arcpad/shared`: this module is reachable
 * from a `'use client'` component, and the main barrel drags `node:fs` into
 * the browser chunk. That is not a precaution -- it is the error that made
 * `next build` fail before the browser entry point existed.
 */
const config = getWebConfig()

export const wagmiConfig = createConfig({
  chains: [config.chain],
  connectors: [injected()],
  transports: { [config.chain.id]: http(config.rpcUrl) },
  ssr: true,
})
