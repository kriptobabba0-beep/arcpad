import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FullConfig } from '@playwright/test'
import { ARC_TESTNET_CHAIN_ID, getArcChain, USDC_VIEW_SCALE } from '@arcpad/shared/browser'
import type { Address } from 'viem'
import {
  addressbookEnv,
  asAddress,
  bookSmokePair,
  probeArc,
  resolveSigningKey,
  throwawayAddress,
} from './fixtures/arc'
import { runNextBuild, startWebServer } from './fixtures/server'
import { webRoot } from './state'

/**
 * AN ARC-CONFIGURED APP, BUILT AND STARTED BY THE RUN THAT NEEDS IT.
 *
 * This is the whole reason `e2e/arc/two-view-balance.spec.ts` had never run.
 * The suite's shared `global-setup.ts` starts anvil and builds the app against
 * that DEVCHAIN, for every project including `arc` -- so the one leg whose
 * entire claim is "this cannot be measured on a devchain" was handed a devchain
 * app and no Arc app, and `E2E_ARC_BASE_URL` was never set by anything.
 * Baseline, measured 2026-08-09 before this file existed:
 *
 *     pnpm --filter @arcpad/web e2e:arc   ->   1 passed, 5 skipped (37.6s)
 *
 * and those 37.6 seconds were spent starting an anvil, building a devchain app
 * and killing them again, for a leg that then skipped.
 *
 * IT LIVES IN ITS OWN CONFIG (`playwright.arc.config.ts`) RATHER THAN AS A
 * BRANCH IN THE SHARED SETUP, and the reason is measured rather than argued:
 * `FullConfig.projects` is NOT filtered by `--project`, so a branch there could
 * not have told "only the arc project was selected" from "everything was". See
 * `fixtures/arc.ts` for the throwaway-config measurement. The other three legs
 * are untouched by construction -- this change does not edit a line they read.
 *
 * THE EXTERNAL BASE URL STILL WINS. If `E2E_ARC_BASE_URL` is already set, this
 * starts nothing and uses it. That is the deployment case (a preview URL, a
 * staging host), and it is strictly cheaper. What it must NOT be is the ONLY
 * mode: requiring a human to build and start an Arc app by hand is precisely
 * why five tests sat unrun.
 */

export type ArcE2EState = {
  readonly startedAt: string
  readonly baseURL?: string
  readonly serverPid: number | null
  readonly external?: boolean
}

export function arcStatePath(webDir: string): string {
  return join(webDir, 'e2e', '.arc-state.json')
}

function record(path: string, state: ArcE2EState): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
}

function banner(lines: readonly string[]): void {
  console.warn(`\n${lines.map((line) => `[e2e:arc] ${line}`).join('\n')}\n`)
}

export default async function arcGlobalSetup(config: FullConfig): Promise<void> {
  const webDir = webRoot(config)
  const repoRoot = dirname(webDir)
  const path = arcStatePath(webDir)
  record(path, { startedAt: new Date().toISOString(), serverPid: null })

  /*
   * WITH `E2E_ARC` UNSET THIS DOES NOTHING AT ALL -- no build, no server, no
   * network. The spec's first test then prints its OPEN CELL and the five
   * others skip, exactly as before. An unconfigured Arc leg is a known gap; it
   * must stay cheap, or nobody will leave it in the default run.
   */
  if (process.env.E2E_ARC !== '1') {
    banner([
      'E2E_ARC is not set. Nothing was built and nothing was started.',
      'The spec will print its own OPEN CELL. To run the leg for real:',
      '  E2E_ARC=1 E2E_ARC_WATCH=<a funded address> pnpm --filter @arcpad/web e2e:arc',
    ])
    return
  }

  /*
   * THE RPC DEFAULTS TO THE REGISTRY'S OWN ENTRY.
   *
   * `packages/shared/src/chain.ts` is the only place an Arc host may be written
   * (`chain-registry.test.ts` measures that), so defaulting to it here adds no
   * second copy. `E2E_ARC_RPC_URL` overrides it, and whichever wins is ALSO
   * given to the build as `NEXT_PUBLIC_ARC_RPC_URL` -- the CSP's `connect-src`
   * is derived from that variable, so a harness that pointed its own client at
   * one host and the browser at another would produce a page that shows dashes
   * for a reason no assertion names.
   */
  const registryRpc = getArcChain(ARC_TESTNET_CHAIN_ID).rpcUrls.default.http[0] as string
  const configuredRpc = (process.env.E2E_ARC_RPC_URL ?? '').trim()
  const rpcUrl = configuredRpc === '' ? registryRpc : configuredRpc
  process.env.E2E_ARC_RPC_URL = rpcUrl

  const webEnv = await addressbookEnv(repoRoot)
  const bookChainId = Number(webEnv['NEXT_PUBLIC_ARC_CHAIN_ID'])
  if (bookChainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(
      `the address book on disk is for chain ${bookChainId}, but the Arc leg is ` +
        `written for ${ARC_TESTNET_CHAIN_ID}. Refusing to build against the wrong chain.`,
    )
  }
  const factory = asAddress(webEnv['NEXT_PUBLIC_ARCPAD_FACTORY'])
  if (factory === null) {
    throw new Error('addressbook --env-only produced no usable NEXT_PUBLIC_ARCPAD_FACTORY')
  }
  process.env.E2E_ARC_FACTORY = factory

  /*
   * THE TOKEN PAGE THE LEG DRIVES. Env wins; otherwise the book's smoke pair,
   * read through the loader. The pair MOVES TOGETHER -- half a pair is a
   * configuration error the address book itself refuses to write -- so a
   * half-configured env is rejected here rather than producing a `/token/`
   * navigation that 404s and reads like a UI bug.
   */
  const envToken = asAddress(process.env.E2E_ARC_TOKEN)
  const envCurve = asAddress(process.env.E2E_ARC_CURVE)
  if ((envToken === null) !== (envCurve === null)) {
    throw new Error(
      'E2E_ARC_TOKEN and E2E_ARC_CURVE must be set together: they name one launch. ' +
        'Set both, or neither and let the address book supply its smoke pair.',
    )
  }
  /*
   * THE BOOK IS READ UNCONDITIONALLY NOW, even when env names a pair.
   *
   * The graduation leg needs the COMPLETED curve specifically, and the pair a
   * run is driven with is often the OPEN one (T2/T3/T4 need an open curve to
   * trade against, and the book's smoke pair is complete). Deriving the smoke
   * pair only "when env did not override" made the two mutually exclusive: a
   * run configured for the trading tests silently had no completed curve to
   * point the graduation test at, and the honest options were to skip it -- a
   * silent skip reads exactly like a pass -- or to hardcode an address here,
   * which is what the address book exists to prevent.
   */
  const book = await bookSmokePair(repoRoot, webDir, ARC_TESTNET_CHAIN_ID)
  if (book.smokeToken !== null) process.env.E2E_ARC_SMOKE_TOKEN = book.smokeToken
  if (book.smokeCurve !== null) process.env.E2E_ARC_SMOKE_CURVE = book.smokeCurve
  if (book.arcpadLocker !== null) process.env.E2E_ARC_LOCKER = book.arcpadLocker

  let token: Address | null = envToken
  let curve: Address | null = envCurve
  let pairSource = 'E2E_ARC_TOKEN / E2E_ARC_CURVE'
  if (token === null) {
    token = book.smokeToken
    curve = book.smokeCurve
    pairSource = 'the address book (smokeToken / smokeCurve)'
  }

  const watch = asAddress(process.env.E2E_ARC_WATCH)
  const { privateKey, keyIsThrowaway } = resolveSigningKey()
  process.env.E2E_ARC_PRIVATE_KEY = privateKey

  const probe = await probeArc({ rpcUrl, factory, watch, token, curve })

  // A CONFIGURED-BUT-BROKEN RUN FAILS HERE, not four tests later. The spec's own
  // `beforeAll` repeats both of these; this is not redundancy for its own sake:
  // a build takes minutes, and being told the factory is empty afterwards is the
  // difference between a diagnosis and a wasted run.
  if (probe.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(`${rpcUrl} reports chain ${probe.chainId}, not ${ARC_TESTNET_CHAIN_ID}`)
  }
  if (probe.factoryCodeSize === 0) {
    throw new Error(
      `${factory} has NO CODE on chain ${probe.chainId}. This is a configuration ` +
        'failure, not a reason to skip.',
    )
  }

  const notes: string[] = [
    `chain ${probe.chainId} via ${rpcUrl}${configuredRpc === '' ? ' (registry default)' : ''}`,
    `factory ${factory} — ${probe.factoryCodeSize} B, launchCount ${probe.launchCount}`,
    `token/curve from ${pairSource}: ${token ?? '(none)'} / ${curve ?? '(none)'}`,
  ]

  if (watch === null) {
    notes.push(
      'OPEN CELL — E2E_ARC_WATCH is unset. K1 will read the throwaway signing ' +
        'account, whose balance is zero, and a zero balance satisfies every ' +
        'relation between the two views vacuously. Set it to a funded address.',
    )
  } else if (probe.watchUnits === 0n) {
    notes.push(
      `OPEN CELL — E2E_ARC_WATCH ${watch} holds ZERO. K1's non-vacuity assertion ` +
        'will fail, correctly: on zero both views agree for no reason.',
    )
  } else {
    const units = probe.watchUnits ?? 0n
    const wei = probe.watchWei ?? 0n
    notes.push(
      `watch ${watch}: units=${units} wei=${wei} dust=${wei - units * USDC_VIEW_SCALE} ` +
        `(floor relation ${units === wei / USDC_VIEW_SCALE}, ` +
        `the plan's units*1e12===wei ${units * USDC_VIEW_SCALE === wei})`,
    )
  }

  if (curve !== null && probe.curveComplete === true) {
    notes.push(
      `THE ONLY CURVE ON THIS FACTORY IS COMPLETE (${curve}). The three tests that ` +
        'need an OPEN curve cannot pass against it: a 1-wei buy reverts ' +
        'CurveComplete() (0xd98e1888), not NetTooSmall() (0xe811f9f5), and there is ' +
        'no trade panel to type into. Launching one is a WRITE and this harness ' +
        'does not broadcast.',
    )
  }
  if (curve !== null && probe.curveToken !== null && token !== null) {
    const bound = probe.curveToken.toLowerCase() === token.toLowerCase()
    const owned = (probe.curveFactory ?? '').toLowerCase() === factory.toLowerCase()
    notes.push(
      `pair check: curve.token()==token ${bound}, curve.factory()==factory ${owned}, ` +
        `factory.isCanonical(token) ${probe.tokenIsCanonical}`,
    )
    if (!bound || !owned || probe.tokenIsCanonical !== true) {
      throw new Error(
        'the configured token/curve pair does not belong to the configured factory. ' +
          'A page driven against a foreign curve measures nothing.',
      )
    }
  }
  if (keyIsThrowaway) {
    notes.push(
      `no E2E_ARC_PRIVATE_KEY: signing with a GENERATED throwaway ` +
        `(${throwawayAddress(privateKey)}, balance zero). Every write path fails at ` +
        'gas estimation before a transaction exists, so this run cannot broadcast.',
    )
  }
  if (token !== null) process.env.E2E_ARC_TOKEN = token
  if (curve !== null) process.env.E2E_ARC_CURVE = curve

  /*
   * AN EXTERNALLY SUPPLIED APP SHORT-CIRCUITS THE BUILD.
   *
   * Checked AFTER the chain probe on purpose: a preview URL does not make the
   * factory address or the funding any less worth checking, and the probe is
   * seconds against a build's minutes.
   */
  const external = (process.env.E2E_ARC_BASE_URL ?? '').trim()
  if (external !== '') {
    notes.push(`using the externally supplied E2E_ARC_BASE_URL ${external}; nothing was built`)
    banner(notes)
    record(path, {
      startedAt: new Date().toISOString(),
      baseURL: external,
      serverPid: null,
      external: true,
    })
    return
  }

  const buildEnv = {
    ...webEnv,
    NEXT_PUBLIC_ARC_RPC_URL: rpcUrl,
    /*
     * NO `DATABASE_URL`. The indexer is a separate track and its rows are not
     * part of this claim; with the variable stripped the token page takes its
     * chain-only branch, which is the branch that reads the live curve.
     */
    DATABASE_URL: '',
    NEXT_TELEMETRY_DISABLED: '1',
    /*
     * The same escape hatch, for the same reason and with the same limit as the
     * devchain harness: `next build` type-checks the whole tsconfig project, so
     * another track's mid-flight test file would otherwise leave this leg with
     * no server. `web/scripts/release-gate.ts` is the gate that rules on those.
     */
    ARCPAD_E2E_UNSAFE_SKIP_TYPECHECK: '1',
  }
  notes.push('building an ARC-configured app with ARCPAD_E2E_UNSAFE_SKIP_TYPECHECK=1')
  banner(notes)

  await runNextBuild({ cwd: webDir, env: buildEnv })
  const server = await startWebServer({ cwd: webDir, env: buildEnv })
  record(path, {
    startedAt: new Date().toISOString(),
    baseURL: server.url,
    serverPid: server.pid ?? null,
  })
  process.env.E2E_ARC_BASE_URL = server.url
  banner([`the Arc-configured app is at ${server.url} (pid ${server.pid ?? 'unknown'})`])
}
