import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  parseEventLogs,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { bondingCurveAbi } from './abi/bondingCurve'
import { feeEscrowAbi } from './abi/feeEscrow'
import { launchFactoryAbi } from './abi/launchFactory'
import { launchTokenAbi } from './abi/launchToken'
import type { CurveProfile } from './curve'

/**
 * A REAL DEVCHAIN, RUNNING THE REAL COMPILED BYTECODE.
 *
 * Task 4 proves the arithmetic. This proves the AGREEMENT: that the calldata
 * the planner emits, executed by the compiled `BondingCurve`, produces the
 * numbers the planner promised. Every serious defect on this project was found
 * by running something.
 *
 * WHY ANVIL IS LEGITIMATE HERE, AND WHAT IT DOES NOT COVER. The quote path
 * touches NO Arc-specific behaviour: no native-coin precompile, no EIP-7708
 * log, no blocklist, no zero-address ban, and `msg.value` is 18 decimals on
 * both chains. So the arithmetic and the entrypoint contract are measurable
 * here EXACTLY.
 *
 * What is NOT measurable here is the ERC-20 view at `0x3600...0000` -- that
 * contract does not exist on anvil. THE TWO-VIEWS DISPLAY CANNOT BE TESTED BY
 * THIS FILE, and a UI that summed the two balances would NOT look wrong in it.
 * That gap belongs to Task 15's Arc leg and is named there. This paragraph is
 * this task's instance of "a test that passes because of the fixture's implicit
 * shape".
 *
 * LIVES IN `src/`, NOT `test/`: Task 15 needs the same two helpers, and a
 * relative import into another package's `test/` directory is a brittle bond.
 * The `@arcpad/shared/devchain` subpath makes it an explicit contract. The
 * price is that application code could import it; an eslint rule closes that
 * (`web/app/**` and `web/components/**` may not), because an `anvil` subprocess
 * and a deploy path have no business in a browser bundle.
 */

/**
 * `contracts/out`, FOUND BY WALKING UP FROM THE WORKING DIRECTORY.
 *
 * It used to be `dirname(fileURLToPath(import.meta.url))`, which is the more
 * obvious thing and is WRONG for one consumer: Playwright transpiles the files
 * it loads to CommonJS whenever the nearest `package.json` has no
 * `"type": "module"` -- which `web/` does not, a Phase 0 carry-over -- and
 * `import.meta` is a SYNTAX ERROR in CommonJS. So Task 15's browser leg could
 * not import this module at all.
 *
 * Walking up is equivalent for every caller here: every one of them runs with
 * a working directory inside this repository. It fails LOUDLY if that ever
 * stops being true, rather than resolving to a plausible-looking wrong path.
 */
function findContractsOut(): string {
  let dir = resolve(process.cwd())
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'contracts', 'out')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `no contracts/out above ${process.cwd()}. The devchain harness deploys the ` +
      'COMPILED bytecode; run `forge build --root contracts` first.',
  )
}

let cachedOut: string | undefined
function outDir(): string {
  cachedOut ??= findContractsOut()
  return cachedOut
}

/** anvil's first well-known account. A devchain key, and only ever a devchain key. */
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const

export const devAccount = privateKeyToAccount(DEV_KEY)

/** anvil's second and third accounts, for a treasury and a governor that are not the deployer. */
export const TREASURY: Address = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
export const GOVERNOR: Address = getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC')
export const ZERO_ADDRESS: Address = getAddress('0x0000000000000000000000000000000000000000')

export type AnvilHandle = {
  readonly rpcUrl: string
  readonly chainId: number
  stop(): Promise<void>
}

/** anvil's own default. Named so the two call sites cannot drift. */
export const ANVIL_DEFAULT_CHAIN_ID = 31337

export type AnvilOptions = {
  /**
   * The chain id anvil reports to `eth_chainId`.
   *
   * DEFAULTS TO ANVIL'S OWN 31337 so every existing caller is unchanged. Task
   * 15's browser leg needs 5042002 instead, and NOT for tidiness: `getArcChain`
   * is a fail-closed registry with one entry, so a web build pointed at a
   * 31337 node throws on the FIRST render and no page is reachable at all.
   * Adding a devchain entry to that registry would put a fake network into
   * production configuration; moving the id onto anvil keeps the fiction on the
   * side that is already fictional.
   */
  readonly chainId?: number
}

/**
 * Starts `anvil` on an EPHEMERAL PORT and reads the port back from its output.
 *
 * `--port 0` rather than a fixed port on purpose: two suites, or two agents in
 * this shared checkout, must not collide on 8545 -- and a collision would not
 * fail cleanly, it would silently run the differential against SOMEBODY ELSE'S
 * chain state. The port is parsed from `Listening on 127.0.0.1:<port>`, which
 * is why `--silent` is NOT passed.
 */
export function startAnvil(options: AnvilOptions = {}): Promise<AnvilHandle> {
  const chainId = options.chainId ?? ANVIL_DEFAULT_CHAIN_ID
  return new Promise((resolve, reject) => {
    // The EXECUTABLE NAME, not a shell. `shell: true` on Windows concatenates
    // arguments instead of escaping them (node DEP0190), and this harness has
    // no reason to involve a shell at all.
    const binary = process.platform === 'win32' ? 'anvil.exe' : 'anvil'
    const child: ChildProcess = spawn(binary, ['--port', '0', '--chain-id', String(chainId)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let settled = false
    let buffer = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`anvil did not report a port within 30s. Output so far:\n${buffer}`))
    }, 30_000)

    const stop = (): Promise<void> =>
      new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done()
          return
        }
        child.once('exit', () => done())
        child.kill()
        // A devchain that refuses to die must not hang the suite.
        setTimeout(() => done(), 5_000).unref?.()
      })

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      buffer += chunk.toString()
      const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(buffer)
      if (!match?.[1]) return
      settled = true
      clearTimeout(timer)
      resolve({ rpcUrl: `http://127.0.0.1:${match[1]}`, chainId, stop })
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
    })

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`anvil could not be started (is foundry on PATH?): ${String(error)}`))
    })
  })
}

type Artifact = { abi: unknown[]; bytecode: { object: Hex } }

function bytecodeOf(relative: string): Hex {
  const artifact = JSON.parse(readFileSync(join(outDir(), relative), 'utf8')) as Artifact
  const object = artifact.bytecode?.object
  if (typeof object !== 'string' || !object.startsWith('0x') || object.length < 4) {
    // A missing artifact FAILS. It does not skip: a skipped check reads exactly
    // like a passing one.
    throw new Error(
      `${relative} carries no deployable bytecode. Run first: forge build --root contracts`,
    )
  }
  return object
}

export type DevClients = {
  readonly wallet: WalletClient
  readonly publicClient: PublicClient
}

/**
 * The chain object handed to viem, with anvil's reported id.
 *
 * NOT COSMETIC. viem asserts the wallet client's chain id against
 * `eth_chainId` before every write, so a client pinned to `foundry` (31337)
 * talking to `anvil --chain-id 5042002` fails on the FIRST `deployContract`
 * with a chain-mismatch error, not on some later assertion.
 */
export function devChain(chainId: number = ANVIL_DEFAULT_CHAIN_ID) {
  return chainId === ANVIL_DEFAULT_CHAIN_ID ? foundry : { ...foundry, id: chainId }
}

export function devClients(rpcUrl: string, chainId: number = ANVIL_DEFAULT_CHAIN_ID): DevClients {
  const transport = http(rpcUrl)
  const chain = devChain(chainId)
  return {
    wallet: createWalletClient({ account: devAccount, chain, transport }),
    publicClient: createPublicClient({ chain, transport }),
  }
}

async function deploy(
  clients: DevClients,
  relative: string,
  abi: readonly unknown[],
  args: readonly unknown[],
): Promise<Address> {
  const hash = await clients.wallet.deployContract({
    abi: abi as never,
    bytecode: bytecodeOf(relative),
    args: args as never,
    account: devAccount,
    chain: clients.wallet.chain ?? null,
  })
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`deploying ${relative} failed: status=${receipt.status}`)
  }
  return getAddress(receipt.contractAddress)
}

/** The factory profile triple, read one call at a time. */
async function readTriple(
  clients: DevClients,
  factory: Address,
): Promise<readonly [bigint, bigint, bigint]> {
  const read = async (functionName: string): Promise<bigint> =>
    (await clients.publicClient.readContract({
      address: factory,
      abi: launchFactoryAbi,
      functionName: functionName as never,
    })) as bigint
  return [
    await read('VIRTUAL_TOKEN_RESERVES'),
    await read('VIRTUAL_QUOTE_RESERVES'),
    await read('SALE_SUPPLY'),
  ] as const
}
export type ArcpadDeployment = {
  readonly factory: Address
  readonly escrow: Address
  readonly feeSchedule: Address
  readonly treasury: Address
  readonly token: Address
  readonly curve: Address
  readonly creator: Address
}

/**
 * `FeeSchedule` TAKES NO CONSTRUCTOR ARGUMENTS, so an empty ABI is the whole
 * interface this harness needs -- it deploys the contract and hands the
 * address to `LaunchFactory`, which is the only consumer here.
 *
 * WHY THIS APPEARED. Phase 2 gave `LaunchFactory` a seventh constructor
 * parameter (`feeSchedule_`, rejected with `FeeScheduleHasNoCode` when it is
 * not a contract). `packages/shared/src/abi/launchFactory.ts` was updated with
 * it; THIS FILE WAS NOT, and its suite runs under a separate vitest config
 * (`test:chain`) that the default `pnpm --filter @arcpad/shared test` does not
 * sweep -- so every deploy here failed with an ABI length mismatch and nothing
 * in the routine gates said so. A property covered on one entrypoint reads as
 * covered on all of them.
 */
const FEE_SCHEDULE_ABI = [] as const

/**
 * Deploys the real thing and launches one token through it.
 *
 * THE DEPLOY ORDER IS THE CONTRACT'S OWN REQUIREMENT, and one argument order is
 * a trap this test could fall into as easily as production code:
 * `LaunchFactory` takes `virtualTokenReserves_` (T) BEFORE
 * `virtualQuoteReserves_` (V). Faz 1c recorded swapping them as "a mistake that
 * compiles". So the deployment ASSERTS the factory's own view of V afterwards
 * rather than trusting the call site.
 *
 * The token and curve addresses come from the `Launched` EVENT, never from the
 * call's return values: a transaction receipt carries no return data, and a
 * helper that pretends otherwise teaches the wrong pattern to Task 13.
 */
export async function deployArcpad(
  rpcUrl: string,
  profile: CurveProfile,
  chainId: number = ANVIL_DEFAULT_CHAIN_ID,
): Promise<ArcpadDeployment> {
  const clients = devClients(rpcUrl, chainId)

  const escrow = await deploy(clients, 'FeeEscrow.sol/FeeEscrow.json', feeEscrowAbi, [])
  const feeSchedule = await deploy(
    clients,
    'FeeSchedule.sol/FeeSchedule.json',
    FEE_SCHEDULE_ABI,
    [],
  )
  const factory = await deploy(clients, 'LaunchFactory.sol/LaunchFactory.json', launchFactoryAbi, [
    escrow,
    TREASURY,
    GOVERNOR,
    profile.virtualTokenReserves,
    profile.virtualQuoteReserves,
    profile.saleSupply,
    feeSchedule,
  ])

  // THE ANTI-TRAP. If T and V were swapped at the call site above, every quote
  // in this suite would be computed against a curve nobody reviewed, and the
  // differential would still agree with itself.
  // Read one at a time, NOT through `multicall`: a bare anvil has no
  // Multicall3 deployed and viem refuses the call outright. Three sequential
  // reads against a local devchain cost nothing; the rate-limit reason that
  // makes multicall worth it on Arc does not apply here.
  const [reportedT, reportedV, reportedS] = await readTriple(clients, factory)
  if (
    reportedT !== profile.virtualTokenReserves ||
    reportedV !== profile.virtualQuoteReserves ||
    reportedS !== profile.saleSupply
  ) {
    throw new Error(
      `the deployed factory disagrees with the profile it was given: ` +
        `T=${reportedT} V=${reportedV} S=${reportedS} vs ` +
        `T=${profile.virtualTokenReserves} V=${profile.virtualQuoteReserves} S=${profile.saleSupply}. ` +
        'The constructor takes T BEFORE V; a swap here compiles and poisons every quote below.',
    )
  }

  const hash = await clients.wallet.writeContract({
    address: factory,
    abi: launchFactoryAbi,
    functionName: 'launch',
    args: ['Diff', 'DIFF', 'ipfs://diff'],
    account: devAccount,
    chain: clients.wallet.chain ?? null,
  })
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('launch reverted')

  const launched = parseEventLogs({
    abi: launchFactoryAbi,
    eventName: 'Launched',
    logs: receipt.logs,
  })
  const event = launched[0]
  if (!event) throw new Error('launch emitted no Launched event')
  const { token, curve, creator } = event.args as {
    token: Address
    curve: Address
    creator: Address
  }

  // Proof that what follows is a launch THE FACTORY MADE. Without it, the
  // differential could be measuring a curve that is canonical in name only.
  const canonical = await clients.publicClient.readContract({
    address: factory,
    abi: launchFactoryAbi,
    functionName: 'isCanonical',
    args: [token],
  })
  if (canonical !== true) throw new Error(`the factory does not consider ${token} canonical`)

  return {
    factory,
    escrow,
    feeSchedule,
    treasury: TREASURY,
    token: getAddress(token),
    curve: getAddress(curve),
    creator: getAddress(creator),
  }
}

export type ZeroCreatorDeployment = {
  readonly token: Address
  readonly curve: Address
  readonly escrow: Address
  readonly factory: Address
  readonly treasury: Address
  readonly creator: Address
}

/**
 * A curve whose creator IS THE ZERO ADDRESS -- a state `launch` can never
 * produce, because it always passes `msg.sender`.
 *
 * THE OBVIOUS RECIPE DOES NOT WORK, AND THE CONTRACT SAYS SO ITSELF. Deploying
 * the curve straight from an EOA makes `factory` an EOA, and every trade calls
 * `protocolTreasury()`, which is `ILaunchFactory(factory).protocolTreasury()`.
 * Against an address with no code that staticcall reverts with EMPTY data, so
 * such a curve is fail-closed on all three entrypoints. Measured here first
 * (`buyExactQuoteIn` reverted with `data: '0x'`), then found already stated in
 * `BondingCurve.sol`'s NatSpec: a curve deployed with a codeless factory
 * reverts on EVERY trade, fail-closed, and is fake under `isCanonical` anyway.
 *
 * So the curve is deployed FROM A REAL `LaunchFactory` ADDRESS, impersonated on
 * the devchain. `factory` is then a genuine factory with a real treasury, the
 * constructor arguments are ours, and `creator` is zero -- which is exactly the
 * state under test and nothing else. `bind` is sent from the same impersonated
 * address, which is what satisfies its `msg.sender != factory` guard.
 */
export async function deployZeroCreatorCurve(
  rpcUrl: string,
  profile: CurveProfile,
): Promise<ZeroCreatorDeployment> {
  const clients = devClients(rpcUrl)

  const escrow = await deploy(clients, 'FeeEscrow.sol/FeeEscrow.json', feeEscrowAbi, [])
  const feeSchedule = await deploy(
    clients,
    'FeeSchedule.sol/FeeSchedule.json',
    FEE_SCHEDULE_ABI,
    [],
  )
  const factory = await deploy(clients, 'LaunchFactory.sol/LaunchFactory.json', launchFactoryAbi, [
    escrow,
    TREASURY,
    GOVERNOR,
    profile.virtualTokenReserves,
    profile.virtualQuoteReserves,
    profile.saleSupply,
    feeSchedule,
  ])

  // Impersonate the factory so the curve it deploys records IT as `factory`.
  await rpc(rpcUrl, 'anvil_impersonateAccount', [factory])
  await rpc(rpcUrl, 'anvil_setBalance', [factory, '0x21e19e0c9bab2400000'])

  const curveInit = encodeDeployData({
    abi: bondingCurveAbi,
    bytecode: bytecodeOf('BondingCurve.sol/BondingCurve.json'),
    args: [
      ZERO_ADDRESS,
      escrow,
      profile.virtualTokenReserves,
      profile.virtualQuoteReserves,
      profile.saleSupply,
    ],
  })
  const curveHash = (await rpc(rpcUrl, 'eth_sendTransaction', [
    { from: factory, data: curveInit, gas: '0x2dc6c0' },
  ])) as Hex
  const curveReceipt = await clients.publicClient.waitForTransactionReceipt({ hash: curveHash })
  if (curveReceipt.status !== 'success' || !curveReceipt.contractAddress) {
    throw new Error('deploying the zero-creator curve from the factory failed')
  }
  const curve = getAddress(curveReceipt.contractAddress)

  // The token has no `msg.sender` requirement, so the EOA can deploy it. Its
  // constructor mints the whole supply to the curve.
  const token = await deploy(clients, 'LaunchToken.sol/LaunchToken.json', launchTokenAbi, [
    'ZeroCreator',
    'ZERO',
    'ipfs://zero',
    devAccount.address,
    curve,
    `0x${'00'.repeat(32)}` as Hex,
  ])

  // `bind` FROM THE FACTORY, which is what its guard requires.
  const bindHash = (await rpc(rpcUrl, 'eth_sendTransaction', [
    {
      from: factory,
      to: curve,
      data: encodeFunctionData({ abi: bondingCurveAbi, functionName: 'bind', args: [token] }),
      gas: '0x7a120',
    },
  ])) as Hex
  const bindReceipt = await clients.publicClient.waitForTransactionReceipt({ hash: bindHash })
  if (bindReceipt.status !== 'success') throw new Error('bind reverted')

  await rpc(rpcUrl, 'anvil_stopImpersonatingAccount', [factory])

  const onChainCreator = (await clients.publicClient.readContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: 'creator',
  })) as Address
  if (getAddress(onChainCreator) !== ZERO_ADDRESS) {
    throw new Error(
      `the zero-creator fixture has creator ${String(onChainCreator)}, not the zero address`,
    )
  }

  // ...and it must be TRADABLE, which the EOA-deployed version is not. A
  // fixture that cannot trade would make every assertion about it vacuous.
  const treasury = (await clients.publicClient.readContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: 'protocolTreasury',
  })) as Address
  if (getAddress(treasury) !== TREASURY) {
    throw new Error(`the zero-creator curve resolves its treasury to ${String(treasury)}`)
  }

  return { token, curve, escrow, factory, treasury: TREASURY, creator: ZERO_ADDRESS }
}

/** A raw JSON-RPC call, for the anvil-only methods viem does not expose. */
async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`)
  return body.result
}
