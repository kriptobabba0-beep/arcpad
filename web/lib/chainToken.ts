import {
  bondingCurveAbi,
  type CurveProfile,
  graduationRaise,
  launchTokenAbi,
  marketCap,
  priceWeiPerToken,
  progressPpm,
} from '@arcpad/shared/browser'
import { type Address, createPublicClient, http } from 'viem'
import { TOTAL_SUPPLY_TOK } from '@/components/create/facts'
import { getWebConfig } from './addresses'

/**
 * THE TOKEN PAGE'S SECOND DATA SOURCE: THE CHAIN.
 *
 * The page has one shape and two sources. When the indexer has the row, the
 * row is the source. When it does not -- because the launch is a minute old,
 * or because Postgres is unreachable, or because `DATABASE_URL` was never set
 * -- everything that lives on chain still exists, and the only honest thing to
 * do is read it. What CANNOT come from here is stated by its absence: volume,
 * holder count, all-time high and the trade list are indexer facts, and this
 * module does not invent them.
 *
 * THE CALLER MUST HAVE ESTABLISHED CANONICITY FIRST. Reading `name()` off an
 * unverified address is how a forgery gets a real launch's name onto our page;
 * `verifyCanonical` is a separate call, made by the page, and this module is
 * only reached after it answers `canonical`. That ordering is asserted in the
 * page and exercised end to end.
 */

export type ChainToken = {
  readonly token: Address
  readonly curve: Address
  readonly name: string
  readonly symbol: string
  readonly uri: string
  readonly creator: Address
  readonly complete: boolean
  readonly virtualTokenReserves: bigint
  readonly virtualQuoteReserves: bigint
  readonly realTokenReserves: bigint
  readonly realQuoteReserves: bigint
  /** Derived, with the same helpers the indexer uses. */
  readonly progressPpm: number
  readonly priceWeiPerTok: bigint
  readonly marketCapWei: bigint
  readonly graduationRaiseWei: bigint
}

function client() {
  const config = getWebConfig()
  return createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
}

/**
 * Two aggregated rounds, not nine calls.
 *
 * The curve address is not known until the token answers, so the rounds cannot
 * be collapsed into one. Arc rate-limits sequential `eth_call`s, so nine of
 * them is nine chances to be throttled on a page load.
 */
export async function readChainToken(
  token: Address,
  profile: CurveProfile,
): Promise<ChainToken | null> {
  const publicClient = client()
  try {
    const [name, symbol, uri, creator, curve] = (await publicClient.multicall({
      contracts: (['name', 'symbol', 'metadataURI', 'creator', 'curve'] as const).map(
        (functionName) => ({ address: token, abi: launchTokenAbi, functionName }),
      ),
      allowFailure: false,
    })) as [string, string, string, Address, Address]

    const [vT, vQ, rT, rQ, complete] = (await publicClient.multicall({
      contracts: (
        [
          'virtualTokenReserves',
          'virtualQuoteReserves',
          'realTokenReserves',
          'realQuoteReserves',
          'complete',
        ] as const
      ).map((functionName) => ({ address: curve, abi: bondingCurveAbi, functionName })),
      allowFailure: false,
    })) as [bigint, bigint, bigint, bigint, boolean]

    return {
      token,
      curve,
      name,
      symbol,
      uri,
      creator,
      complete,
      virtualTokenReserves: vT,
      virtualQuoteReserves: vQ,
      realTokenReserves: rT,
      realQuoteReserves: rQ,
      progressPpm: progressPpm(rT, profile.saleSupply),
      priceWeiPerTok: priceWeiPerToken(vQ, vT),
      // The supply constant is `LaunchToken.TOTAL_SUPPLY` (1e27), NOT the sale
      // supply and NOT the virtual token reserve. `web/components/create/facts.ts`
      // holds the single copy; importing it keeps this page and the launch
      // preview from disagreeing about what a market cap is.
      marketCapWei: marketCap(vQ, vT, TOTAL_SUPPLY_TOK),
      // `graduationRaise(S, V, T)` -- the argument order is (saleSupply,
      // quoteReserve, tokenReserve) and the two reserves are the PROFILE's
      // initial values, not the curve's current ones: the target does not move
      // as people trade.
      graduationRaiseWei: graduationRaise(
        profile.saleSupply,
        profile.virtualQuoteReserves,
        profile.virtualTokenReserves,
      ),
    }
  } catch (error) {
    // A FAILED CHAIN READ IS NOT A 500. The page above already knows how to
    // draw "we could not reach anything"; throwing here would take out the
    // notice that explains it.
    console.error('chain read for the token page failed', error)
    return null
  }
}
