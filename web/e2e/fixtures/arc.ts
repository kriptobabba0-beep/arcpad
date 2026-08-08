import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ARC_TESTNET_CHAIN_ID,
  bondingCurveAbi,
  getArcChain,
  launchFactoryAbi,
  USDC_ERC20_ADDRESS,
  USDC_VIEW_SCALE,
} from '@arcpad/shared/browser'
import { type Address, createPublicClient, type Hex, http, parseAbi } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

/**
 * THE ARC LEG'S OWN SETUP, AND WHY IT IS A SEPARATE FILE FROM THE DEVCHAIN ONE.
 *
 * MEASURED FIRST, THEN BUILT. `pnpm --filter @arcpad/web e2e:arc` ran
 * `playwright test --project=arc` against `playwright.config.ts`, whose
 * `globalSetup` starts anvil, writes a DEVCHAIN env file, runs `next build` and
 * starts a server configured for that devchain. The Arc spec needs the
 * opposite: an app built against Arc testnet, whose URL it reads from
 * `E2E_ARC_BASE_URL`. Nothing ever set that, so all five Arc tests skipped on
 * every invocation while a devchain nobody used was started, built for and torn
 * down. Baseline, run 2026-08-09 before any change: `1 passed, 5 skipped`.
 *
 * THE FIX IS A SECOND CONFIG, NOT A BRANCH IN THE SHARED SETUP. `global-setup.ts`
 * is shared by `local-chain`, `local-db` and `audit`, and its own comments record
 * an incident where an unanchored `testMatch` made the Arc project silently
 * re-run the whole local suite and report 112 passing tests where there are 56.
 * A branch inside it would have to be keyed on which projects were selected --
 * and `FullConfig.projects` is NOT filtered by `--project`. MEASURED, with a
 * three-project throwaway config: `--project=beta` ran one test and still
 * reported `projects=["alpha","beta","gamma"]` to `globalSetup`. Any such branch
 * would therefore have keyed off a value that cannot tell the two cases apart.
 * A separate config file changes the other three legs by ZERO LINES, which is a
 * stronger guarantee than any argument about a branch that never fires.
 */

export type ArcConfig = {
  readonly rpcUrl: string
  readonly chainId: number
  readonly factory: Address
  readonly escrow: Address
  readonly watch: Address | null
  readonly token: Address | null
  readonly curve: Address | null
  readonly privateKey: Hex
  readonly keyIsThrowaway: boolean
  /** `NEXT_PUBLIC_*` only, exactly as `pnpm addressbook --env-only` printed it. */
  readonly webEnv: Record<string, string>
}

const IS_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const IS_KEY = /^0x[0-9a-fA-F]{64}$/

export function asAddress(value: string | undefined): Address | null {
  return value !== undefined && IS_ADDRESS.test(value) ? (value as Address) : null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `tsx`'s CLI entry, run under THIS Node.
 *
 * The same reasoning as `fixtures/server.ts`'s `nextBin`: `spawn('pnpm', ...)`
 * on Windows needs `shell: true`, and `shell: true` concatenates arguments
 * instead of escaping them (node DEP0190). Resolving the JS entry point and
 * running `process.execPath` sidesteps both.
 */
function tsxCli(repoRoot: string): string {
  const require = createRequire(pathToFileURL(join(repoRoot, 'noop.cjs')).href)
  return require.resolve('tsx/cli')
}

async function runNode(args: readonly string[], cwd: string): Promise<string> {
  const out: string[] = []
  const err: string[] = []
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (c: Buffer) => out.push(c.toString()))
    child.stderr?.on('data', (c: Buffer) => err.push(c.toString()))
    child.once('error', reject)
    child.once('exit', (exitCode) => resolve(exitCode ?? 1))
  })
  if (code !== 0) {
    throw new Error(`${args.join(' ')} failed (${code}):\n${out.join('')}${err.join('')}`)
  }
  return out.join('')
}

/**
 * `NEXT_PUBLIC_*`, FROM `pnpm addressbook --env-only` AND FROM NOWHERE ELSE.
 *
 * That script reads `contracts/deploy/addresses.<chainId>.json` through the
 * loader that re-derives every address from its initcode hash, so a book that
 * disagrees with itself fails here rather than producing a build pointed at a
 * plausible wrong factory. Hand-writing these four values would skip exactly
 * that check, and the resulting run would be green against nothing.
 */
export async function addressbookEnv(repoRoot: string): Promise<Record<string, string>> {
  const stdout = await runNode(
    [tsxCli(repoRoot), join(repoRoot, 'scripts', 'addressbook.ts'), '--env-only'],
    repoRoot,
  )
  const env: Record<string, string> = {}
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match === null) continue
    const [, key, value] = match as unknown as [string, string, string]
    if (key.startsWith('NEXT_PUBLIC_')) env[key] = value
  }
  if (env['NEXT_PUBLIC_ARCPAD_FACTORY'] === undefined) {
    throw new Error(`addressbook --env-only printed no NEXT_PUBLIC_ARCPAD_FACTORY:\n${stdout}`)
  }
  return env
}

/** `smokeToken` / `smokeCurve`, through the same loader. See `arc-book.ts`. */
export async function bookSmokePair(
  repoRoot: string,
  webDir: string,
  chainId: number,
): Promise<{ smokeToken: Address | null; smokeCurve: Address | null }> {
  const stdout = await runNode(
    [tsxCli(repoRoot), join(webDir, 'e2e', 'fixtures', 'arc-book.ts'), String(chainId)],
    webDir,
  )
  const parsed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '{}') as {
    smokeToken?: string | null
    smokeCurve?: string | null
  }
  return {
    smokeToken: asAddress(parsed.smokeToken ?? undefined),
    smokeCurve: asAddress(parsed.smokeCurve ?? undefined),
  }
}

export function arcClient(rpcUrl: string) {
  return createPublicClient({
    chain: getArcChain(ARC_TESTNET_CHAIN_ID),
    transport: rpcUrl === '' ? http() : http(rpcUrl),
  })
}

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

export type ArcProbe = {
  readonly chainId: number
  readonly factoryCodeSize: number
  readonly launchCount: bigint
  readonly watchUnits: bigint | null
  readonly watchWei: bigint | null
  readonly curveComplete: boolean | null
  readonly curveToken: Address | null
  readonly curveFactory: Address | null
  readonly tokenIsCanonical: boolean | null
}

/**
 * ONE PACED PASS OVER THE LIVE CHAIN, BEFORE A BROWSER IS OPENED.
 *
 * Every read here is a read. Nothing in this file can sign, and the account the
 * harness hands the page is a THROWAWAY with no balance, so a broadcast is not
 * merely avoided by policy -- it is unaffordable.
 *
 * PACED, NOT BATCHED. Arc rate-limits concurrent AND sequential `eth_call`s and
 * counts JSON-RPC OBJECTS, not HTTP requests: 20 calls in one request is refused
 * `-32005` and stays refused across retries, 15 goes through. A dozen paced
 * single calls is well inside that and needs no ladder.
 */
export async function probeArc(options: {
  readonly rpcUrl: string
  readonly factory: Address
  readonly watch: Address | null
  readonly token: Address | null
  readonly curve: Address | null
}): Promise<ArcProbe> {
  const client = arcClient(options.rpcUrl)
  const chainId = await client.getChainId()
  await sleep(150)
  const code = await client.getCode({ address: options.factory })
  await sleep(150)
  const launchCount = (await client.readContract({
    address: options.factory,
    abi: launchFactoryAbi,
    functionName: 'launchCount',
  })) as bigint

  let watchUnits: bigint | null = null
  let watchWei: bigint | null = null
  if (options.watch !== null) {
    await sleep(150)
    watchUnits = (await client.readContract({
      address: USDC_ERC20_ADDRESS,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [options.watch],
    })) as bigint
    await sleep(150)
    watchWei = await client.getBalance({ address: options.watch })
  }

  let curveComplete: boolean | null = null
  let curveToken: Address | null = null
  let curveFactory: Address | null = null
  if (options.curve !== null) {
    await sleep(150)
    curveComplete = (await client.readContract({
      address: options.curve,
      abi: bondingCurveAbi,
      functionName: 'complete',
    })) as boolean
    await sleep(150)
    curveToken = (await client.readContract({
      address: options.curve,
      abi: bondingCurveAbi,
      functionName: 'token',
    })) as Address
    await sleep(150)
    curveFactory = (await client.readContract({
      address: options.curve,
      abi: bondingCurveAbi,
      functionName: 'factory',
    })) as Address
  }

  let tokenIsCanonical: boolean | null = null
  if (options.token !== null) {
    await sleep(150)
    tokenIsCanonical = (await client.readContract({
      address: options.factory,
      abi: launchFactoryAbi,
      functionName: 'isCanonical',
      args: [options.token],
    })) as boolean
  }

  return {
    chainId,
    factoryCodeSize: code === undefined ? 0 : (code.length - 2) / 2,
    launchCount,
    watchUnits,
    watchWei,
    curveComplete,
    curveToken,
    curveFactory,
    tokenIsCanonical,
  }
}

/**
 * A SIGNING KEY THAT CANNOT MOVE ANYBODY'S MONEY.
 *
 * `injectedWallet` calls `privateKeyToAccount` unconditionally, so EVERY test in
 * the Arc spec -- including the read-only K1 claim -- needs a syntactically
 * valid key or it throws before it measures anything. The spec's own comment
 * says what the key is for: "the provider signs with a throwaway key and REPORTS
 * the funded address", and `E2E_ARC_WATCH` supplies the address the page sees.
 *
 * So when no key is configured the harness GENERATES one, per run, and says so.
 * Its balance is zero, which makes every write path fail at gas estimation
 * BEFORE a transaction exists to broadcast. "Read-only" is then a property of
 * the account rather than a promise about the code.
 */
export function resolveSigningKey(): { privateKey: Hex; keyIsThrowaway: boolean } {
  const configured = process.env.E2E_ARC_PRIVATE_KEY ?? ''
  if (IS_KEY.test(configured)) return { privateKey: configured as Hex, keyIsThrowaway: false }
  return { privateKey: generatePrivateKey(), keyIsThrowaway: true }
}

export function throwawayAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address
}

export { USDC_VIEW_SCALE }
