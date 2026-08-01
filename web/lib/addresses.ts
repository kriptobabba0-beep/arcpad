import { type ArcChain, getArcChain } from '@arcpad/shared/browser'
import { type Address, getAddress, isAddress } from 'viem'

/**
 * THE ADDRESS BOOK, AS THE BROWSER SEES IT.
 *
 * The source of truth is `contracts/deploy/addresses.<chainId>.json`. Nothing
 * here is hand-copied from it: `pnpm addressbook --chain <id>` prints this env
 * block from the book, and `preflight` re-checks the two against each other
 * with `assertEnvMatchesBook` before anyone deploys.
 *
 * Why env at all, when the book is committed? Because Next inlines
 * `NEXT_PUBLIC_*` at BUILD time, and a JSON file read at request time never
 * reaches the client bundle. The book loader also opens files with `node:fs`,
 * which cannot exist in a browser chunk at all. So the env indirection is
 * forced, not chosen -- and the staleness it creates is exactly what the
 * preflight closes.
 */

export type WebEnvKey =
  | 'NEXT_PUBLIC_ARC_CHAIN_ID'
  | 'NEXT_PUBLIC_ARC_RPC_URL'
  | 'NEXT_PUBLIC_ARCPAD_FACTORY'
  | 'NEXT_PUBLIC_ARCPAD_ESCROW'

// `| undefined` is explicit because the repo compiles with
// `exactOptionalPropertyTypes`: `process.env.FOO` is `string | undefined`, and
// a merely-optional property would not accept it.
export type WebEnv = { [K in WebEnvKey]?: string | undefined }

/**
 * `unset` means nobody has configured this yet; `invalid` means somebody has,
 * and got it wrong. The preflight turns the first into exit code 2 and the
 * second into exit code 1, because "not configured" and "misconfigured" call
 * for different actions and a skipped check must never read as a passed one.
 */
export type WebConfigErrorKind = 'unset' | 'invalid'

export class WebConfigError extends Error {
  readonly key: WebEnvKey
  readonly kind: WebConfigErrorKind
  constructor(key: WebEnvKey, kind: WebConfigErrorKind, message: string) {
    super(`${key}: ${message}`)
    this.name = 'WebConfigError'
    this.key = key
    this.kind = kind
  }
}

export type ArcpadAddresses = {
  readonly launchFactory: Address
  readonly feeEscrow: Address
}

export type WebConfig = {
  readonly chain: ArcChain
  readonly rpcUrl: string
  readonly addresses: ArcpadAddresses
}

/** An empty string is UNSET, not a wrong value -- `.env.example` ships blanks. */
function requireValue(env: WebEnv, key: WebEnvKey): string {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') {
    throw new WebConfigError(key, 'unset', 'is not set (see .env.example)')
  }
  return raw.trim()
}

function requireAddress(env: WebEnv, key: WebEnvKey): Address {
  const value = requireValue(env, key)
  if (!isAddress(value, { strict: false })) {
    throw new WebConfigError(key, 'invalid', `is "${value}", which is not an address`)
  }
  // Normalised to EIP-55 on the way in so that every comparison downstream is
  // between checksummed values and none of them has to remember to lowercase.
  return getAddress(value)
}

export function readWebConfig(env: WebEnv): WebConfig {
  const rawChainId = requireValue(env, 'NEXT_PUBLIC_ARC_CHAIN_ID')
  if (!/^\d+$/.test(rawChainId)) {
    throw new WebConfigError(
      'NEXT_PUBLIC_ARC_CHAIN_ID',
      'invalid',
      `is "${rawChainId}", which is not a decimal chain id`,
    )
  }
  let chain: ArcChain
  try {
    chain = getArcChain(Number(rawChainId))
  } catch (error) {
    throw new WebConfigError(
      'NEXT_PUBLIC_ARC_CHAIN_ID',
      'invalid',
      error instanceof Error ? error.message : String(error),
    )
  }

  // The RPC URL is OPTIONAL and defaults to the registry's own entry. Making
  // it mandatory would force every operator to write an Arc host into their
  // env -- a second copy of a value the registry already holds, and the exact
  // thing `chain-registry.test.ts` exists to prevent in source.
  const rawRpc = env['NEXT_PUBLIC_ARC_RPC_URL']
  let rpcUrl = chain.rpcUrls.default.http[0] as string
  if (rawRpc !== undefined && rawRpc.trim() !== '') {
    const candidate = rawRpc.trim()
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      throw new WebConfigError('NEXT_PUBLIC_ARC_RPC_URL', 'invalid', `is "${candidate}", not a URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new WebConfigError(
        'NEXT_PUBLIC_ARC_RPC_URL',
        'invalid',
        `is "${candidate}"; the HTTP transport needs http: or https:, got ${parsed.protocol}`,
      )
    }
    rpcUrl = candidate
  }

  return {
    chain,
    rpcUrl,
    addresses: {
      launchFactory: requireAddress(env, 'NEXT_PUBLIC_ARCPAD_FACTORY'),
      feeEscrow: requireAddress(env, 'NEXT_PUBLIC_ARCPAD_ESCROW'),
    },
  }
}

/**
 * Reads `process.env` with LITERAL property access, one key at a time.
 *
 * This shape is required, not stylistic: Next's build-time substitution is a
 * textual replacement of `process.env.NEXT_PUBLIC_FOO`. A dynamic read --
 * `process.env[key]`, or handing `process.env` to a helper -- is not
 * substituted, so it evaluates to `undefined` in the browser and the app
 * fails at runtime with "not set" while the build was green.
 */
export function webEnvFromProcess(): WebEnv {
  return {
    NEXT_PUBLIC_ARC_CHAIN_ID: process.env.NEXT_PUBLIC_ARC_CHAIN_ID,
    NEXT_PUBLIC_ARC_RPC_URL: process.env.NEXT_PUBLIC_ARC_RPC_URL,
    NEXT_PUBLIC_ARCPAD_FACTORY: process.env.NEXT_PUBLIC_ARCPAD_FACTORY,
    NEXT_PUBLIC_ARCPAD_ESCROW: process.env.NEXT_PUBLIC_ARCPAD_ESCROW,
  }
}

let cached: WebConfig | undefined

/**
 * Memoised accessor. Deliberately a function rather than a module-level
 * `export const ADDRESSES = ...`: a top-level throw makes the module
 * unimportable, so every test that wants to exercise the FAILURE path -- and
 * every tool that only wants the types -- would have to fake an environment
 * first. Callers still fail closed; they just fail where they call.
 */
export function getWebConfig(): WebConfig {
  cached ??= readWebConfig(webEnvFromProcess())
  return cached
}

/** Test seam. Not used by application code. */
export function resetWebConfigCache(): void {
  cached = undefined
}
