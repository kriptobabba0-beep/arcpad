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
  | 'NEXT_PUBLIC_ARCPAD_ROUTER'

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
  /**
   * ============ THE POOL ROUTER, AND WHY IT IS THE ONE NULLABLE ADDRESS ============
   *
   * `ArcpadRouter` is the ONLY way a wallet can trade a graduated pool: v4 gives
   * an EOA no swap entrypoint and Arc has no Universal Router. It is in the
   * address book as `arcpadRouter` (REQUIRED there, and re-derived offline from
   * `routerInitcodeHash`), so the value is not in doubt -- what is in doubt is
   * whether a given BUILD was handed it.
   *
   * IT IS NULLABLE HERE FOR A MEASURED REASON, NOT A STYLISTIC ONE.
   * `WEB_ENV_BINDINGS` in `packages/shared/src/addresses.ts` is the single table
   * that both `pnpm addressbook` (the generator) and `assertEnvMatchesBook` (the
   * auditor) read, and CI writes its build env from `webEnvBlock(book)`. That
   * table does not yet carry `NEXT_PUBLIC_ARCPAD_ROUTER`, and `packages/` is
   * another track's. Making this address REQUIRED today would therefore fail
   * every existing build -- CI's included -- at the `/_not-found` prerender,
   * which is the exact failure `webEnvBlock`'s own comment exists to describe.
   *
   * So the address is optional, every consumer must handle `null` VISIBLY (the
   * pool panel renders an explanation, never a dead button), and
   * `test/pool/config.test.ts` holds the exemption open in the AWAITING_FIXTURE
   * shape: it asserts the binding table is still missing the key, and goes RED
   * the day it is added -- which is the day this field must become required.
   */
  readonly arcpadRouter: Address | null
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
      arcpadRouter: optionalAddress(env, 'NEXT_PUBLIC_ARCPAD_ROUTER'),
    },
  }
}

/**
 * UNSET is `null`; SET-AND-WRONG still throws.
 *
 * The distinction is the whole value of the field: "this build was not given a
 * router" and "this build was given something that is not an address" call for
 * different actions, and collapsing the second into the first would ship a
 * silently router-less site whose only symptom is that graduated tokens cannot
 * be traded.
 */
function optionalAddress(env: WebEnv, key: WebEnvKey): Address | null {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return null
  const value = raw.trim()
  if (!isAddress(value, { strict: false })) {
    throw new WebConfigError(key, 'invalid', `is "${value}", which is not an address`)
  }
  return getAddress(value)
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
    // LITERAL, like the four above. `process.env[key]` is not substituted by
    // Next's build-time textual replacement, so a dynamic read evaluates to
    // `undefined` in the browser while the build stays green.
    NEXT_PUBLIC_ARCPAD_ROUTER: process.env.NEXT_PUBLIC_ARCPAD_ROUTER,
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
