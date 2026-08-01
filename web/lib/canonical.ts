import { launchFactoryAbi } from '@arcpad/shared/browser'
import {
  type Address,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
} from 'viem'
import { getWebConfig } from './addresses'

/**
 * CANONICITY, AND WHY IT CANNOT COME FROM WHAT THE PAGE DISPLAYS.
 *
 * A forger can copy a real launch's creator, its curve, its metadata, its
 * salt, and even a realised trade price -- byte for byte. Faz 1c measured
 * exactly that. The ONLY thing that separates a real launch from a copy is
 * that the address re-derives from the launch's own raw data, and the chain is
 * the thing that knows.
 *
 * THE RULE, WITHOUT EXCEPTION: an address that is not `canonical` is never
 * rendered as a launch. `forged` and `unverifiable` go to the SAME screen --
 * "This address is not an arcpad launch." -- because a failure to verify and a
 * proven forgery are equally unsafe to draw.
 */

export type Canonicity = 'canonical' | 'forged' | 'unverifiable'

/**
 * The gas ceiling on the verification call.
 *
 * NOT a round number chosen for looks. The token being verified is HOSTILE: it
 * returns its own fields, so a megabyte-long `name()` makes the call
 * arbitrarily expensive. Faz 1c measured it: a direct call burned 2,958,151 of
 * a 3,000,000 budget, and a caller that merely wrapped it in `try/catch` burned
 * 7,757,318 of 8,000,000. `try/catch` hands back CONTROL, never GAS -- so both
 * are required, and this ceiling is the half that actually bounds the cost.
 */
export const VERIFY_GAS_CAP = 2_000_000n

/**
 * Asks the factory. One `eth_call`.
 *
 * THE FACTORY ADDRESS IS READ FROM THE ADDRESS BOOK, never inlined. Phase 2
 * redeploys `LaunchFactory` -- its constructor gains a `feeSchedule` argument
 * -- so today's address is superseded on a date nobody here controls. This is
 * the case the book exists for, and a hardcoded literal would keep verifying
 * against a factory that no longer launches anything, answering `forged` for
 * every real launch.
 */
export async function verifyCanonical(token: Address): Promise<Canonicity> {
  const config = getWebConfig()
  const client = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
  try {
    // `client.call`, NOT `readContract`: viem's `readContract` parameters do
    // not include `gas`, so the ceiling below is UNEXPRESSIBLE through it. That
    // is not a style choice -- without the ceiling the node runs the hostile
    // token's code to whatever the default budget allows, and `try/catch` hands
    // back control without handing back gas.
    const { data } = await client.call({
      to: config.addresses.launchFactory,
      data: encodeFunctionData({
        abi: launchFactoryAbi,
        functionName: 'isCanonical',
        args: [token],
      }),
      gas: VERIFY_GAS_CAP,
    })
    if (data === undefined) return 'unverifiable'
    const canonical = decodeFunctionResult({
      abi: launchFactoryAbi,
      functionName: 'isCanonical',
      data,
    })
    return canonical === true ? 'canonical' : 'forged'
  } catch {
    // A contract with no `launchSalt()` selector makes the call REVERT rather
    // than return false -- fail-closed. A revert means "not canonical", but it
    // is indistinguishable from running out of gas or from the RPC being
    // unreachable, so it is reported as `unverifiable` and the UI never draws
    // it as a launch.
    return 'unverifiable'
  }
}

/** The only verdict that may be rendered as a launch. */
export function mayRenderAsLaunch(verdict: Canonicity): verdict is 'canonical' {
  return verdict === 'canonical'
}

/**
 * CANONICITY COMES FROM THE HEX, NEVER FROM THE DISPLAY TEXT -- and this
 * module deliberately exposes NO address-derivation helper at all.
 *
 * The indexer derives the address for admission, and it takes `nameHex` /
 * `symbolHex` (see `launches.name_hex`, `launches.symbol_hex`, which exist for
 * this reason). A helper here that took `name: string` could not work: the
 * salt is `keccak256(abi.encode(sender, name, symbol, uri, count))` over the
 * RAW BYTES, and a decoded string has already lost them. `LaunchToken` checks
 * only byte LENGTHS and Solidity never validates UTF-8, so a launch whose name
 * is the bytes `0x41ff42` is perfectly legal on chain -- and `0xff` is not
 * valid UTF-8, so decoding and re-encoding it yields different bytes and a
 * different address.
 *
 * MEASURED, and pinned in `web/test/canonical.test.ts`: for a name of
 * `0x41ff42` the byte path gives `0x2a569089…` and the string path gives
 * `0x02ec13d6…`. They are not the same address, the mismatch is a
 * `NonCanonicalLaunch` halt, and it is REACHABLE.
 *
 * So the frontend does not derive at all: it asks `isCanonical`, which is the
 * chain's own answer over the chain's own bytes. If a derivation helper is
 * ever wanted here, it must take `Hex`, and the test named above is the record
 * of why.
 */
export const DERIVATION_LIVES_IN_THE_INDEXER =
  'Address derivation takes nameHex/symbolHex, never a decoded string. See web/test/canonical.test.ts.'
