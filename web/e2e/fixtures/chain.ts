import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AnvilHandle,
  type ArcpadDeployment,
  deployArcpad,
  devClients,
  startAnvil,
} from '@arcpad/shared/devchain'
import {
  ARC_TESTNET_CHAIN_ID,
  type CurveProfile,
  getArcChain,
  launchFactoryAbi,
  MULTICALL3_ADDRESS,
} from '@arcpad/shared/browser'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { type Address, createPublicClient, type Hex, http } from 'viem'

/**
 * Multicall3's CREATION code, taken from viem itself.
 *
 * viem keeps it as `multicall3Bytecode` but does not list
 * `./constants/contracts` in its `exports` map, so the public entry point
 * cannot reach it. Resolving the package root and importing the built module
 * directly is the only way to use viem's copy instead of pasting a fourth one
 * into this repository -- and a pasted 5 kB hex literal is exactly the kind of
 * transcribed constant nothing here could check.
 *
 * IT FAILS LOUDLY IF viem MOVES IT. That is the point: the alternative is a
 * silent `undefined`, which deploys an empty contract, which produces a chain
 * that looks fine until the profile read comes back wrong.
 */
async function multicall3CreationCode(): Promise<Hex> {
  // `createRequire` is anchored on the WORKING DIRECTORY, not on
  // `import.meta.url`: Playwright transpiles these files to CommonJS (this
  // package has no `"type": "module"`, a Phase 0 carry-over), and `import.meta`
  // is a syntax error there.
  const require = createRequire(pathToFileURL(join(process.cwd(), 'noop.cjs')).href)
  const root = require.resolve('viem/package.json').replace(/package\.json$/, '')
  const url = pathToFileURL(`${root}_esm/constants/contracts.js`).href
  const mod = (await import(url)) as { multicall3Bytecode?: Hex }
  const bytecode = mod.multicall3Bytecode
  if (typeof bytecode !== 'string' || !bytecode.startsWith('0x') || bytecode.length < 1000) {
    throw new Error(
      `viem no longer exposes multicall3Bytecode at ${url}. ` +
        'The devchain needs Multicall3 at the canonical address; find its new home ' +
        'rather than pasting the bytecode into this repository.',
    )
  }
  return bytecode
}

/**
 * THE LOCAL CHAIN, AS THE BROWSER LEG NEEDS IT.
 *
 * This file WRAPS `@arcpad/shared/devchain` and adds nothing to it but the two
 * things a browser needs and a vitest differential does not: a chain id the
 * app's registry recognises, and an `.env` file that `next build` can inline.
 *
 * WHY THE DEVCHAIN RUNS AS 5042002. `getArcChain` is a fail-closed registry
 * with one entry. A web build pointed at anvil's own 31337 throws inside
 * `getWebConfig()` on the FIRST render, so there is no page to test at all --
 * and the alternative, adding a devchain to the production registry, would put
 * a fictional network into the shipped configuration. The fiction belongs on
 * anvil's side, where everything already is.
 *
 * `NEXT_PUBLIC_*` IS A BUILD-TIME SUBSTITUTION, not a runtime read. That is why
 * the deploy has to happen BEFORE `next build` and why this returns the values
 * rather than letting the server read them later: a JSON address book read at
 * request time never reaches the client bundle at all (see `web/lib/addresses.ts`).
 */

/**
 * The testnet triple, hand-copied from the deployed factory -- the same three
 * literals `packages/shared/test/chain/curve-differential.test.ts` uses.
 *
 * IT MUST HASH TO THE `testnet` PROFILE DIGEST. `getCurveProfile()` reads T, V
 * and S back off the deployed factory and refuses to price anything whose
 * digest matches no reviewed profile, so a devchain deployed with invented
 * numbers would render a `/create` page with four dashes and a token page with
 * no trade panel -- green-looking, and measuring nothing.
 */
export const E2E_PROFILE: CurveProfile = {
  virtualTokenReserves: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReserves: 4_292_000_000_000_000_000n,
  saleSupply: 793_100_000n * 10n ** 18n,
}

export type LocalChain = {
  readonly rpcUrl: string
  readonly chainId: number
  readonly deployment: ArcpadDeployment
  stop(): Promise<void>
}

/**
 * MEASURED, NOT ASSUMED: anvil 1.6.0 has NO CODE at `0xcA11bde0…`.
 *
 * That matters more than it looks. `getCurveProfile()` reads T, V and S in one
 * `multicall` -- deliberately, because Arc rate-limits sequential `eth_call`s
 * -- and `viem` resolves the Multicall3 address from `chain.contracts`. On a
 * bare devchain that call reverts, `getCurveProfile()` throws, `/create` draws
 * four dashes and the token page renders NO TRADE PANEL AT ALL. The whole
 * browser leg would then be green against a page with nothing on it.
 *
 * The runtime code is not transcribed from anywhere. viem ships Multicall3's
 * CREATION code; this deploys it with a normal transaction, reads back the
 * runtime code the constructor returned, and moves that to the canonical
 * address with `anvil_setCode`. Nothing here is a literal anybody had to copy.
 *
 * And it is CHECKED, because "the code is installed" is not the claim that
 * matters -- "the aggregated read agrees with the direct reads" is. The caller
 * proves that against the factory triple it just deployed.
 */
export async function installMulticall3(rpcUrl: string, chainId: number): Promise<Address> {
  const { wallet, publicClient } = devClients(rpcUrl, chainId)
  const chain = wallet.chain ?? null
  const hash = await wallet.deployContract({
    abi: [],
    bytecode: await multicall3CreationCode(),
    account: wallet.account,
    chain,
  } as never)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error('deploying Multicall3 on the devchain failed')
  }
  const runtime = await publicClient.getCode({ address: receipt.contractAddress })
  if (runtime === undefined || runtime.length < 4) {
    throw new Error('the deployed Multicall3 reported no runtime code')
  }
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'anvil_setCode',
      params: [MULTICALL3_ADDRESS, runtime],
    }),
  })
  const body = (await response.json()) as { error?: { message: string } }
  if (body.error) throw new Error(`anvil_setCode failed: ${body.error.message}`)
  const installed = await publicClient.getCode({ address: MULTICALL3_ADDRESS })
  if (installed !== runtime) {
    throw new Error('anvil_setCode did not put the runtime code at the canonical address')
  }
  return MULTICALL3_ADDRESS
}

const TRIPLE = ['VIRTUAL_TOKEN_RESERVES', 'VIRTUAL_QUOTE_RESERVES', 'SALE_SUPPLY'] as const

/**
 * The non-tautological half: the aggregated read must equal three direct ones.
 *
 * If the runtime code above were the wrong contract, `multicall` would either
 * revert or decode garbage -- and a fixture that only asserted "there is code
 * at the address" would not notice either.
 */
async function assertMulticallAgrees(rpcUrl: string, factory: Address): Promise<void> {
  // THE APP'S OWN CHAIN OBJECT, not the devchain helper's. `foundry` declares
  // no `multicall3` contract, so a client built from it would fail for a
  // reason that has nothing to do with the code installed above -- and the
  // thing worth proving is that the configuration THE BROWSER USES resolves.
  const publicClient = createPublicClient({
    chain: getArcChain(ARC_TESTNET_CHAIN_ID),
    transport: http(rpcUrl),
  })
  const aggregated = (await publicClient.multicall({
    contracts: TRIPLE.map((functionName) => ({
      address: factory,
      abi: launchFactoryAbi,
      functionName,
    })),
    allowFailure: false,
  })) as readonly bigint[]
  for (const [index, functionName] of TRIPLE.entries()) {
    const direct = (await publicClient.readContract({
      address: factory,
      abi: launchFactoryAbi,
      functionName,
    })) as bigint
    if (aggregated[index] !== direct) {
      throw new Error(
        `Multicall3 disagrees with a direct read of ${functionName}: ` +
          `${String(aggregated[index])} vs ${String(direct)}`,
      )
    }
  }
}

export async function startLocalChain(): Promise<LocalChain> {
  const anvil: AnvilHandle = await startAnvil({ chainId: ARC_TESTNET_CHAIN_ID })
  try {
    const deployment = await deployArcpad(anvil.rpcUrl, E2E_PROFILE, ARC_TESTNET_CHAIN_ID)
    await installMulticall3(anvil.rpcUrl, ARC_TESTNET_CHAIN_ID)
    await assertMulticallAgrees(anvil.rpcUrl, deployment.factory)
    return {
      rpcUrl: anvil.rpcUrl,
      chainId: anvil.chainId,
      deployment,
      stop: () => anvil.stop(),
    }
  } catch (error) {
    // A DEPLOY THAT THROWS MUST NOT LEAK A CHAIN. The previous round of this
    // project left two anvils and six Postgres processes running for hours;
    // the fix is that every process has exactly one owner and that owner's
    // failure path kills it.
    await anvil.stop()
    throw error
  }
}

export type WebEnvFile = Record<string, string>

/**
 * The env `next build` and `next start` are given.
 *
 * `DATABASE_URL` IS ABSENT ON PURPOSE and the absence is an assertion, not a
 * convenience: with no database the token page can only reach the chain-only
 * branch, so Task 7's degrade-without-breaking property and Task 12's
 * database-independence property are measured by the SAME run.
 */
export function webEnvFor(chain: LocalChain): WebEnvFile {
  return {
    NEXT_PUBLIC_ARC_CHAIN_ID: String(chain.chainId),
    NEXT_PUBLIC_ARC_RPC_URL: chain.rpcUrl,
    NEXT_PUBLIC_ARCPAD_FACTORY: chain.deployment.factory,
    NEXT_PUBLIC_ARCPAD_ESCROW: chain.deployment.escrow,
  }
}

/** Written for a human debugging a failed run; the processes get the env directly. */
export function writeEnvFile(dir: string, env: WebEnvFile): string {
  const path = join(dir, '.env.e2e')
  const body = [
    '# Generated by web/e2e/fixtures/chain.ts. Ephemeral: the addresses below',
    '# belong to an anvil that no longer exists once the run ends.',
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n')
  writeFileSync(path, body, 'utf8')
  return path
}
