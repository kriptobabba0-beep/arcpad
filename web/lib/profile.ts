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
  /**
   * `LaunchFactory.graduationTarget()` — the zero address until governance
   * arms it, and `BondingCurve.graduate()` reverts `GraduationTargetUnset()`
   * for every curve while it is.
   *
   * IT IS READ HERE RATHER THAN ASSUMED because the create page states the
   * liquidity guarantee, and that is the single most consequential sentence a
   * creator reads. It shipped as a fixed line -- "the pool and its permanent
   * lock ship in a later phase" -- which was true when written and becomes
   * false the moment a target lands, with nothing on the page or in CI able
   * to notice. The triple beside it is `immutable`; this is not, which is
   * exactly why it cannot be a constant in a component.
   */
  readonly graduationTarget: Address
}

export class CurveProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CurveProfileError'
  }
}

/** What one round trip to the factory brings back. */
export type FactoryState = {
  readonly triple: readonly [bigint, bigint, bigint]
  readonly graduationTarget: Address
}

/** Narrow seam so the identification logic is testable without an RPC. */
export interface CurveProfileReader {
  readFactoryState(factory: Address): Promise<FactoryState>
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
  const {
    triple: [virtualTokenReserves, virtualQuoteReserves, saleSupply],
    graduationTarget,
  } = await reader.readFactoryState(factory)
  const profile: CurveProfile = { virtualTokenReserves, virtualQuoteReserves, saleSupply }
  return { name: identifyProfile(profile), profile, graduationTarget }
}

/**
 * One multicall, four values. Arc rate-limits concurrent AND sequential
 * `eth_call`s, so four separate reads is four chances to be throttled.
 *
 * Three of them cannot change -- the factory stores them as `immutable`. The
 * fourth, `graduationTarget`, can, so it rides along rather than earning a
 * second round trip: `getCurveProfile` is wrapped in React's per-request
 * `cache()`, which is exactly the lifetime a mutable read may safely share
 * with immutable ones.
 *
 * `allowFailure: false` COVERS ALL FOUR ON PURPOSE. A factory that cannot
 * answer must leave the preview card showing "—" on every line it drives,
 * including the liquidity line. Letting the target fail softly to a default
 * would print a claim about locked liquidity that nothing verified.
 */
export function multicallCurveProfileReader(client: {
  multicall: (args: {
    contracts: readonly unknown[]
    allowFailure: false
  }) => Promise<readonly unknown[]>
}): CurveProfileReader {
  return {
    async readFactoryState(factory: Address) {
      const results = (await client.multicall({
        contracts: [
          { address: factory, abi: LAUNCH_FACTORY_ABI, functionName: 'VIRTUAL_TOKEN_RESERVES' },
          { address: factory, abi: LAUNCH_FACTORY_ABI, functionName: 'VIRTUAL_QUOTE_RESERVES' },
          { address: factory, abi: LAUNCH_FACTORY_ABI, functionName: 'SALE_SUPPLY' },
          { address: factory, abi: LAUNCH_FACTORY_ABI, functionName: 'graduationTarget' },
        ],
        allowFailure: false,
      })) as readonly unknown[]
      const [t, v, s, target] = results
      if (typeof t !== 'bigint' || typeof v !== 'bigint' || typeof s !== 'bigint') {
        throw new CurveProfileError(
          `the factory's immutables did not decode as three uint256 values: ${JSON.stringify(results.map(String))}`,
        )
      }
      // A target that is not an address is not "unset" -- it is an answer
      // nobody can act on, and defaulting it to zero here would print
      // "graduation is not armed" for a factory that never said so.
      if (typeof target !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(target)) {
        throw new CurveProfileError(
          `the factory's graduationTarget did not decode as an address: ${JSON.stringify(String(target))}`,
        )
      }
      return { triple: [t, v, s] as const, graduationTarget: target as Address }
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
