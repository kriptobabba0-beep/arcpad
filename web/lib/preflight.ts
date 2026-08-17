import {
  type AddressBook,
  AddressBookError,
  assertEnvMatchesBook,
  loadAddressBook,
  readProfiles,
} from '@arcpad/shared'
import type { Address } from 'viem'
import { readWebConfig, type WebConfig, WebConfigError, type WebEnv } from './addresses'

/**
 * PREFLIGHT: CATCH A MISCONFIGURATION BEFORE A USER DOES.
 *
 * Every assertion here is one that no runtime check downstream can make. An
 * address with no code, a factory paired with someone else's escrow, a
 * production `V` published to testnet -- all of them leave a site that renders
 * perfectly and is wrong.
 *
 * EXIT CODES ARE PART OF THE CONTRACT:
 *   0  every assertion held
 *   1  everything needed was present and something DISAGREES
 *   2  NOT CONFIGURED -- a blank variable, or no address book on disk
 *   3  UNREACHABLE -- the checks could not be completed at all
 *
 * 2 exists because a skipped check looks exactly like a passed one in CI. A
 * preflight that shrugged at an empty env would go green on the one setup
 * guaranteed to be broken: whoever runs `cp .env.example .env` first.
 *
 * 3 exists because of a MEASURED failure, not a hypothetical one. The first
 * live run of this script against `rpc.testnet.arc.io` completed five
 * assertions and then died on the sixth with "request limit reached" -- Arc
 * rate-limits sequential `eth_call`s, not just concurrent ones. Reported as
 * exit 1 that reads "your deployment is misconfigured", which is a lie that
 * would block a correct deploy. A throttled RPC is not a disagreement.
 */

export const PREFLIGHT_OK = 0
export const PREFLIGHT_DISAGREES = 1
export const PREFLIGHT_NOT_CONFIGURED = 2
export const PREFLIGHT_UNREACHABLE = 3

export type PreflightCode =
  | typeof PREFLIGHT_OK
  | typeof PREFLIGHT_DISAGREES
  | typeof PREFLIGHT_NOT_CONFIGURED
  | typeof PREFLIGHT_UNREACHABLE

/**
 * Arc's throttle, recognised by message because the transport surfaces it as
 * a JSON-RPC error rather than an HTTP 429 that viem would retry on its own.
 * The observed string is `Details: request limit reached`.
 */
export function isRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}` : String(error)
  return /request limit|rate ?limit|too many requests|\b429\b/i.test(message)
}

/**
 * A revert is NOT unreachability. If `factory.escrow()` reverts or returns no
 * data at an address that demonstrably has code, the configured address is not
 * the contract we think it is -- which is exactly the disagreement this script
 * exists to catch. Folding that into "the RPC did not answer" would let a
 * wrong-contract deploy through on a non-blocking exit code.
 */
export function isContractDisagreement(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /execution reverted|returned no data|ContractFunctionZeroData|does not exist|is not a function/i.test(
    message,
  )
}

export type RetryOptions = {
  attempts?: number
  /** Base backoff. The default clears several Arc blocks (~350ms each). */
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Retries ONLY on the throttle, and never on a wrong answer.
 *
 * Retrying a disagreement would be catastrophic: the whole point of this
 * script is that a mismatch stops the deploy, and a retry loop around a
 * mismatch is a loop that eventually gives up and reports the same mismatch
 * much later, or -- worse, if the chain is mid-reorg -- a different one.
 */
export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 4
  const delayMs = options.delayMs ?? 500
  const sleep = options.sleep ?? defaultSleep
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isRateLimited(error)) throw error
      lastError = error
      await sleep(delayMs * 2 ** attempt)
    }
  }
  throw lastError
}

export interface PreflightReader {
  getChainId(): Promise<number>
  getCode(address: Address): Promise<string | undefined>
  readFactoryEscrow(factory: Address): Promise<Address>
  readFactoryVirtualQuoteReserves(factory: Address): Promise<bigint>
}

export type PreflightDeps = {
  /**
   * The WHOLE environment, not just the `NEXT_PUBLIC_*` four: assertion (2)
   * also checks the server-side `ARC_*` variables that the indexer and keeper
   * read, because a book that agrees with the browser and disagrees with the
   * indexer is still a split brain.
   */
  env: WebEnv & Record<string, string | undefined>
  reader: PreflightReader
  /** Fixture seam for the negative tests. Production uses the committed book. */
  bookDir?: string
  log?: (line: string) => void
  /** Throttle handling. Tests inject a no-op `sleep` so they stay fast. */
  retry?: RetryOptions
}

export type PreflightResult = {
  code: PreflightCode
  /** Human-readable lines, in the order they were produced. */
  lines: string[]
}

function fail(lines: string[], code: PreflightCode, message: string): PreflightResult {
  lines.push(`FAIL ${message}`)
  return { code, lines }
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const lines: string[] = []
  const note = (line: string) => {
    lines.push(line)
    deps.log?.(line)
  }
  const failWith = (code: PreflightCode, message: string): PreflightResult => {
    const result = fail(lines, code, message)
    deps.log?.(`FAIL ${message}`)
    return result
  }

  // (0) The env itself. A blank variable is NOT CONFIGURED; a present-but-bad
  //     one is a disagreement, and the two get different exit codes.
  let config: WebConfig
  try {
    config = readWebConfig(deps.env)
  } catch (error) {
    if (error instanceof WebConfigError) {
      return failWith(
        error.kind === 'unset' ? PREFLIGHT_NOT_CONFIGURED : PREFLIGHT_DISAGREES,
        error.message,
      )
    }
    throw error
  }
  note(`chain      ${config.chain.name} (${config.chain.id}) via ${config.rpcUrl}`)

  // (1) The address book. `loadAddressBook` also cross-checks the book against
  //     `expected-governance.json` through a MODULE-CONSTANT path -- not an
  //     env-redirectable one -- so a book whose governor disagrees with the
  //     reviewed Safe cannot load at all, and no flag here can wave it through.
  let book: AddressBook
  try {
    book = loadAddressBook(config.chain.id, deps.bookDir)
  } catch (error) {
    if (error instanceof AddressBookError) {
      // A missing file is "nobody has deployed this chain"; anything else is a
      // book that exists and is wrong.
      return failWith(
        error.field === 'file' ? PREFLIGHT_NOT_CONFIGURED : PREFLIGHT_DISAGREES,
        `address book: ${error.message}`,
      )
    }
    throw error
  }
  note(`book       ${book.chainKey} profile="${book.profile}" commit=${book.commit}`)

  // (2) Env vs book. Next inlines NEXT_PUBLIC_* at build time, so a build made
  //     against yesterday's book ships yesterday's addresses no matter what
  //     the book says today. This is the only place that gap is visible.
  try {
    assertEnvMatchesBook(deps.env, book)
  } catch (error) {
    if (error instanceof AddressBookError) {
      return failWith(
        error.message.includes('is not set') ? PREFLIGHT_NOT_CONFIGURED : PREFLIGHT_DISAGREES,
        `env vs address book: ${error.message}`,
      )
    }
    throw error
  }
  note('env        agrees with the address book')

  /**
   * Every chain read goes through here. An RPC that will not answer is exit 3,
   * NEVER exit 1: "we could not check" and "we checked and it is wrong" are
   * different facts, and CI must not treat a throttle as a bad deployment.
   */
  const chainRead = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    try {
      return await withRateLimitRetry(operation, deps.retry)
    } catch (error) {
      throw new PreflightReadError(
        label,
        error,
        isContractDisagreement(error) ? PREFLIGHT_DISAGREES : PREFLIGHT_UNREACHABLE,
      )
    }
  }

  try {
    return await runChainAssertions(deps, config, book, lines, note, failWith, chainRead)
  } catch (error) {
    if (error instanceof PreflightReadError) {
      return failWith(
        error.code,
        error.code === PREFLIGHT_UNREACHABLE
          ? `${error.label}: ${error.message}. The configuration was NOT contradicted; the RPC did not answer.`
          : `${error.label}: ${error.message}. The address has code but does not behave like a LaunchFactory.`,
      )
    }
    throw error
  }
}

export class PreflightReadError extends Error {
  readonly label: string
  readonly code: PreflightCode
  constructor(label: string, cause: unknown, code: PreflightCode) {
    super(cause instanceof Error ? (cause.message.split('\n')[0] as string) : String(cause))
    this.name = 'PreflightReadError'
    this.label = label
    this.code = code
  }
}

async function runChainAssertions(
  deps: PreflightDeps,
  config: WebConfig,
  book: AddressBook,
  lines: string[],
  note: (line: string) => void,
  failWith: (code: PreflightCode, message: string) => PreflightResult,
  chainRead: <T>(label: string, operation: () => Promise<T>) => Promise<T>,
): Promise<PreflightResult> {
  // (3) The RPC really is the chain we think it is.
  const observedChainId = await chainRead('eth_chainId', () => deps.reader.getChainId())
  if (observedChainId !== config.chain.id) {
    return failWith(
      PREFLIGHT_DISAGREES,
      `RPC ${config.rpcUrl} reports chain ${observedChainId}, but the configuration says ${config.chain.id}`,
    )
  }
  note(`eth_chainId ${observedChainId}`)

  // (4) A factory address with no code leaves the whole product silently dead:
  //     every read returns "0x", every write reverts, and nothing says why.
  const code = await chainRead('eth_getCode', () =>
    deps.reader.getCode(config.addresses.launchFactory),
  )
  if (code === undefined || code === '0x' || code.length <= 2) {
    return failWith(
      PREFLIGHT_DISAGREES,
      `there is no code at the configured factory ${config.addresses.launchFactory} on chain ${config.chain.id}`,
    )
  }
  note(`factory    ${config.addresses.launchFactory} has ${(code.length - 2) / 2} bytes of code`)

  // (5) The two addresses must vouch for EACH OTHER. Individually-valid but
  //     mismatched addresses are the realistic copy-paste error, and both of
  //     them pass every check that looks at one address at a time.
  const onChainEscrow = await chainRead('factory.escrow()', () =>
    deps.reader.readFactoryEscrow(config.addresses.launchFactory),
  )
  if (onChainEscrow.toLowerCase() !== config.addresses.feeEscrow.toLowerCase()) {
    return failWith(
      PREFLIGHT_DISAGREES,
      `factory ${config.addresses.launchFactory} points at escrow ${onChainEscrow}, ` +
        `but the configuration says ${config.addresses.feeEscrow}`,
    )
  }
  note(`escrow     ${onChainEscrow} confirmed by the factory itself`)

  // (6) Which economy is live. The candidate values are READ FROM
  //     profiles.toml, not written here: a second copy of V is the very
  //     mistake this assertion exists to catch.
  const profiles = readProfiles()
  const observedV = await chainRead('factory.VIRTUAL_QUOTE_RESERVES()', () =>
    deps.reader.readFactoryVirtualQuoteReserves(config.addresses.launchFactory),
  )
  const matched = Object.entries(profiles).find(
    ([, profile]) => profile.virtualQuoteReserves === observedV,
  )
  if (matched === undefined) {
    const known = Object.entries(profiles)
      .map(([name, profile]) => `${name}=${profile.virtualQuoteReserves}`)
      .join(', ')
    return failWith(
      PREFLIGHT_DISAGREES,
      `factory VIRTUAL_QUOTE_RESERVES is ${observedV}, which is no reviewed profile (${known})`,
    )
  }
  const [profileName] = matched
  if (profileName !== book.profile) {
    return failWith(
      PREFLIGHT_DISAGREES,
      `the chain is running the "${profileName}" profile but the address book says "${book.profile}"`,
    )
  }
  if (observedV !== book.virtualQuoteReserves) {
    return failWith(
      PREFLIGHT_DISAGREES,
      `factory VIRTUAL_QUOTE_RESERVES is ${observedV} but the address book says ${book.virtualQuoteReserves}`,
    )
  }
  note(`profile    ${profileName} profile (V=${observedV})`)

  note('OK preflight passed')
  return { code: PREFLIGHT_OK, lines }
}

export function preflightExitMeaning(code: PreflightCode): string {
  switch (code) {
    case PREFLIGHT_OK:
      return 'every assertion held'
    case PREFLIGHT_DISAGREES:
      return 'configured, and something disagrees'
    case PREFLIGHT_NOT_CONFIGURED:
      return 'not configured -- a blank variable or no address book'
    case PREFLIGHT_UNREACHABLE:
      return 'unreachable -- the RPC did not answer; nothing was contradicted'
  }
}

/**
 * Adapter from a viem public client to the narrow reader above.
 *
 * `gapMs` paces the calls. It is not superstition: Arc throttles SEQUENTIAL
 * `eth_call`s, and the very first live run of this script was cut off on its
 * fourth read. Backing off after being throttled is the safety net; not
 * getting throttled is cheaper. The default clears roughly one Arc block
 * (~350ms).
 */
export function viemPreflightReader(
  client: {
    getChainId: () => Promise<number>
    getBytecode?: (args: { address: Address }) => Promise<string | undefined>
    getCode?: (args: { address: Address }) => Promise<string | undefined>
    readContract: (args: {
      address: Address
      abi: readonly unknown[]
      functionName: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => Promise<any>
  },
  options: { gapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): PreflightReader {
  const gapMs = options.gapMs ?? 400
  const sleep = options.sleep ?? defaultSleep
  let first = true
  const paced = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (!first) await sleep(gapMs)
    first = false
    return operation()
  }
  return {
    getChainId: () => paced(() => client.getChainId()),
    getCode: (address) =>
      paced(() => {
        const read = client.getCode ?? client.getBytecode
        if (read === undefined) throw new Error('client exposes neither getCode nor getBytecode')
        return read.call(client, { address })
      }),
    readFactoryEscrow: (factory) =>
      paced(async () => {
        const { LAUNCH_FACTORY_ABI } = await import('./factoryAbi')
        return (await client.readContract({
          address: factory,
          abi: LAUNCH_FACTORY_ABI,
          functionName: 'escrow',
        })) as Address
      }),
    readFactoryVirtualQuoteReserves: (factory) =>
      paced(async () => {
        const { LAUNCH_FACTORY_ABI } = await import('./factoryAbi')
        return (await client.readContract({
          address: factory,
          abi: LAUNCH_FACTORY_ABI,
          functionName: 'VIRTUAL_QUOTE_RESERVES',
        })) as bigint
      }),
  }
}
