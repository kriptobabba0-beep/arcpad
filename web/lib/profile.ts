import {
  type CurveProfile,
  PROFILE_DIGESTS,
  PROFILE_NAMES,
  type ProfileName,
  profileDigest,
} from '@arcpad/shared'
import { cache } from 'react'
import { type Address, createPublicClient, http } from 'viem'
import { getWebConfig } from './addresses'
import { LAUNCH_FACTORY_ABI } from './factoryAbi'

/**
 * THE CURVE PROFILE IS READ FROM THE CHAIN, NOT FROM ENV.
 *
 * Testnet and production differ in exactly one number -- `V`, by a factor of
 * exactly 1000 -- and `V` is the denominator of every price the site prints.
 * A copied-and-stale `V` moves every market cap by 1000x, and NOTHING else
 * notices: the curve still balances, the reserves still satisfy
 * `vT-rT = T-S` and `vQ-rQ = V`, the totals still add up. The only way to be
 * wrong here is to disagree with the factory, so the factory is asked.
 *
 * The answer is then hashed and compared against the digests pinned in
 * `profiles.ts` (which are hand-written twins of the ones compiled into
 * `Profiles.sol`). Reading from the chain removes the copy; the digest check
 * removes "the chain answered with something nobody has ever reviewed".
 */

export type IdentifiedProfile = {
  readonly name: ProfileName
  readonly profile: CurveProfile
}

export class CurveProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CurveProfileError'
  }
}

/** Narrow seam so the identification logic is testable without an RPC. */
export interface CurveProfileReader {
  readCurveTriple(factory: Address): Promise<readonly [bigint, bigint, bigint]>
}

export function identifyProfile(profile: CurveProfile): ProfileName {
  const digest = profileDigest(profile)
  for (const name of PROFILE_NAMES) {
    if (PROFILE_DIGESTS[name] === digest) return name
  }
  throw new CurveProfileError(
    `the factory reports T=${profile.virtualTokenReserves}, V=${profile.virtualQuoteReserves}, ` +
      `S=${profile.saleSupply}, whose digest ${digest} matches no reviewed profile ` +
      `(${PROFILE_NAMES.join(', ')}). Refusing to price anything against it.`,
  )
}

export async function readCurveProfile(
  reader: CurveProfileReader,
  factory: Address,
): Promise<IdentifiedProfile> {
  const [virtualTokenReserves, virtualQuoteReserves, saleSupply] =
    await reader.readCurveTriple(factory)
  const profile: CurveProfile = { virtualTokenReserves, virtualQuoteReserves, saleSupply }
  return { name: identifyProfile(profile), profile }
}

/**
 * One multicall, three immutables. Arc rate-limits concurrent AND sequential
 * `eth_call`s, so three separate reads is three chances to be throttled for a
 * value that cannot change -- the factory stores these as `immutable`.
 */
export function multicallCurveProfileReader(client: {
  multicall: (args: {
    contracts: readonly unknown[]
    allowFailure: false
  }) => Promise<readonly unknown[]>
}): CurveProfileReader {
  return {
    async readCurveTriple(factory: Address) {
      const results = (await client.multicall({
        contracts: [
          { address: factory, abi: LAUNCH_FACTORY_ABI, functionName: 'VIRTUAL_TOKEN_RESERVES' },
          { address: factory, abi: LAUNCH_FACTORY_ABI, functionName: 'VIRTUAL_QUOTE_RESERVES' },
          { address: factory, abi: LAUNCH_FACTORY_ABI, functionName: 'SALE_SUPPLY' },
        ],
        allowFailure: false,
      })) as readonly bigint[]
      const [t, v, s] = results
      if (typeof t !== 'bigint' || typeof v !== 'bigint' || typeof s !== 'bigint') {
        throw new CurveProfileError(
          `the factory's immutables did not decode as three uint256 values: ${JSON.stringify(results.map(String))}`,
        )
      }
      return [t, v, s] as const
    },
  }
}

/**
 * SERVER ONLY. `cache()` is a React server primitive and this pulls the
 * address book's sibling modules, which read the filesystem. Client components
 * receive the profile as props.
 */
export const getCurveProfile = cache(async (): Promise<IdentifiedProfile> => {
  const config = getWebConfig()
  const client = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
  return readCurveProfile(multicallCurveProfileReader(client), config.addresses.launchFactory)
})
