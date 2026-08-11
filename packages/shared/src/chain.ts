import { defineChain } from 'viem'

export const ARC_TESTNET_CHAIN_ID = 5042002 as const

/**
 * Canonical Multicall3. Same address on every chain that has it, because it is
 * deployed from a fixed presigned transaction. Lives here rather than in the
 * chain literal so `buildArcChain` can hand it to every future Arc profile
 * without a second copy.
 */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

/**
 * The 6-decimal ERC-20 view of USDC. It represents the SAME fund as the native
 * balance -- it is not a second token. See `balance.ts`: the two views are
 * never summed, and `unifyUsdcViews` is the executable form of that rule.
 */
export const USDC_ERC20_ADDRESS = '0x3600000000000000000000000000000000000000' as const

export interface ArcChainConfig<TId extends number = number> {
  id: TId
  name: string
  rpcHttp: string
  rpcWebSocket?: string
  explorerUrl: string
  testnet: boolean
}

/**
 * Everything that belongs to an Arc network, in one place.
 *
 * On Arc the native asset IS USDC and the native view is 18 decimals. That is
 * a property of the chain family, not of one deployment, so it is written once
 * here instead of once per chain literal: a future profile that forgot
 * `decimals: 18` would quote the curve in the wrong view, and no runtime check
 * downstream can see a 1e12 error.
 *
 * The generic `TId` is not decoration. Without it `arcTestnet.id` widens to
 * `number`, and wagmi's `transports` key type -- which is `chains[number]['id']`
 * -- widens with it, so a transport registered for the wrong chain would still
 * typecheck.
 */
export function buildArcChain<const TId extends number>(cfg: ArcChainConfig<TId>) {
  return defineChain({
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
    rpcUrls: {
      default: {
        http: [cfg.rpcHttp],
        ...(cfg.rpcWebSocket === undefined ? {} : { webSocket: [cfg.rpcWebSocket] }),
      },
    },
    blockExplorers: { default: { name: 'ArcScan', url: cfg.explorerUrl } },
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    testnet: cfg.testnet,
  })
}

export const arcTestnet = buildArcChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: 'Arc Testnet',
  rpcHttp: 'https://rpc.testnet.arc.io',
  rpcWebSocket: 'wss://rpc.testnet.arc.io',
  explorerUrl: 'https://testnet.arcscan.app',
  testnet: true,
})

export type ArcChain = ReturnType<typeof buildArcChain>

/**
 * The registry. ONE ENTRY TODAY, AND THAT IS DELIBERATE.
 *
 * Arc mainnet does not exist yet and Circle has not published a mainnet chain
 * id, so inventing one would be a guess wearing configuration's clothes. When
 * it is announced, one `buildArcChain({...})` call is added here and nothing
 * else in the repo changes -- `chain-registry.test.ts` measures that claim
 * rather than restating it: it scans the tracked source for a second copy of
 * the chain id or an Arc host.
 *
 * `CHAIN_KEYS` in `profiles.ts` is the other half of the same registry (chain
 * -> governance key, pinned to `Profiles.sol`). A chain may appear there and
 * not here -- `local-rehearsal` (31337) is an anvil chain with no RPC profile
 * of its own -- but never the reverse, and that direction is a test.
 */
export const ARC_CHAINS = { [ARC_TESTNET_CHAIN_ID]: arcTestnet } as const

/**
 * Registry lookup that FAILS CLOSED. Callers that index `ARC_CHAINS` directly
 * get `undefined` and, with `noUncheckedIndexedAccess` off in a consumer,
 * would sail on with an undefined chain; this names the mistake instead.
 */
export function getArcChain(chainId: number): ArcChain {
  const chain = (ARC_CHAINS as Record<number, ArcChain | undefined>)[chainId]
  if (chain === undefined) {
    const known = Object.keys(ARC_CHAINS).join(', ')
    throw new Error(
      `chain ${chainId} is not in ARC_CHAINS (known: ${known}). ` +
        'Add it to the registry in packages/shared/src/chain.ts -- and to CHAIN_KEYS ' +
        'in profiles.ts together with Profiles.sol -- in a reviewed commit.',
    )
  }
  return chain
}

/**
 * ===========================================================================
 *  ARC PUBLISHES FOUR ENDPOINTS, ONE PER PROVIDER, AND THEIR BUDGETS ARE
 *  INDEPENDENT.
 * ===========================================================================
 *
 * VERIFIED 2026-08-11 from the deployment, all four answering `eth_chainId`
 * with `0x4cef52`:
 *
 *   rpc.testnet.arc.network              (the one everything used)
 *   rpc.blockdaemon.testnet.arc.network
 *   rpc.drpc.testnet.arc.network
 *   rpc.quicknode.testnet.arc.network
 *
 * And in the same second, on a range holding a launch WE indexed:
 *
 *   rpc.testnet.arc.network         eth_getLogs -> `rate limit exceeded`
 *   the other three                 20 logs each, identical
 *
 * WHY THIS MATTERS MORE THAN A RETRY LOOP. What Arc limits is not how OFTEN
 * we ask; it is a per-IP cost budget specific to `eth_getLogs`. When it is
 * empty, a ONE-BLOCK query is refused exactly like a ten-thousand-block one,
 * while `eth_call` and `eth_blockNumber` sail through on their own budget --
 * which is precisely the confusing shape measured here before the cause was
 * understood. Backing off and retrying against an empty bucket cannot help;
 * four budgets can.
 *
 * These are DEFAULTS, not a policy: `ARC_RPC_FALLBACK_URLS` overrides them,
 * and an operator on a private endpoint will want it to.
 */
export const ARC_TESTNET_FALLBACK_RPCS = [
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
] as const
