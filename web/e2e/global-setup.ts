import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FullConfig } from '@playwright/test'
import { startLocalChain, webEnvFor, writeEnvFile } from './fixtures/chain'
import { runNextBuild, startWebServer } from './fixtures/server'
import { type E2EState, statePath, webRoot } from './state'

/**
 * ONE CHAIN, ONE BUILD, ONE SERVER -- AND A STATE FILE THAT OUTLIVES A CRASH.
 *
 * The processes started here are the only ones this suite owns. Their pids go
 * into `e2e/.state.json` BEFORE anything else can fail, because the failure
 * mode that matters is not "teardown ran and missed one", it is "setup threw
 * halfway and teardown was never called at all". The previous round of this
 * project left two chains and six database processes running for hours; a
 * teardown that can only work when setup succeeded is not a fix for that.
 */

function record(path: string, state: E2EState): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const webDir = webRoot(config)
  const path = statePath(webDir)
  record(path, { startedAt: new Date().toISOString(), serverPid: null })

  const chain = await startLocalChain()
  const env = webEnvFor(chain)
  writeEnvFile(webDir, env)
  record(path, {
    startedAt: new Date().toISOString(),
    rpcUrl: chain.rpcUrl,
    chainId: chain.chainId,
    factory: chain.deployment.factory,
    escrow: chain.deployment.escrow,
    serverPid: null,
  })

  try {
    /*
     * `DATABASE_URL` IS STRIPPED, NOT MERELY LEFT UNSET.
     *
     * A developer with a database in their shell would otherwise run a
     * DIFFERENT test from CI: the token page would find its row, take the
     * indexed branch, and the chain-only branch -- the entire point of this
     * leg -- would never execute. Inheriting the environment is exactly how a
     * gate silently stops guarding the thing it was written for.
     */
    /*
     * THE TYPE-CHECK ESCAPE HATCH, USED HERE AND NOWHERE ELSE.
     *
     * `next build` type-checks the whole tsconfig project, so type errors in
     * ANOTHER track's test files stop this harness from having a server to
     * drive. Stepping over them here does NOT make them disappear: the release
     * gate (`web/scripts/release-gate.ts`) runs a real build with this unset
     * and fails on exactly those errors, and it refuses to run at all if this
     * variable is present in its environment.
     */
    const buildEnv = {
      ...env,
      DATABASE_URL: '',
      NEXT_TELEMETRY_DISABLED: '1',
      ARCPAD_E2E_UNSAFE_SKIP_TYPECHECK: '1',
    }
    console.warn(
      '[e2e] building with ARCPAD_E2E_UNSAFE_SKIP_TYPECHECK=1. Type errors outside the ' +
        'app graph do not block the browser leg; `pnpm --filter @arcpad/web release-gate` ' +
        'is the gate that rules on them.',
    )
    await runNextBuild({ cwd: webDir, env: buildEnv })
    const server = await startWebServer({ cwd: webDir, env: buildEnv })

    record(path, {
      startedAt: new Date().toISOString(),
      baseURL: server.url,
      rpcUrl: chain.rpcUrl,
      chainId: chain.chainId,
      factory: chain.deployment.factory,
      escrow: chain.deployment.escrow,
      token: chain.deployment.token,
      curve: chain.deployment.curve,
      serverPid: server.pid ?? null,
    })

    process.env.E2E_BASE_URL = server.url
    process.env.E2E_RPC_URL = chain.rpcUrl
    process.env.E2E_CHAIN_ID = String(chain.chainId)
    process.env.E2E_FACTORY = chain.deployment.factory
    process.env.E2E_ESCROW = chain.deployment.escrow
    process.env.E2E_TOKEN = chain.deployment.token
    process.env.E2E_CURVE = chain.deployment.curve

    /*
     * A SECOND SERVER, AND ONLY WHEN THERE IS A DATABASE.
     *
     * The two legs need OPPOSITE environments and cannot share a process: the
     * chain leg's whole claim is that the page works with `DATABASE_URL`
     * stripped, and the database leg's whole claim is what the page does when
     * the indexer HAS the row. One server could satisfy only one of them.
     *
     * The BUILD is shared -- `next build` output does not depend on
     * `DATABASE_URL`, which is read at request time -- so the second server
     * costs a process, not a minute.
     */
    const databaseUrl = process.env.DATABASE_URL ?? ''
    if (databaseUrl !== '') {
      const dbServer = await startWebServer({
        cwd: webDir,
        env: { ...buildEnv, DATABASE_URL: databaseUrl },
      })
      process.env.E2E_DB_BASE_URL = dbServer.url
      record(path, {
        startedAt: new Date().toISOString(),
        baseURL: server.url,
        dbBaseURL: dbServer.url,
        rpcUrl: chain.rpcUrl,
        chainId: chain.chainId,
        factory: chain.deployment.factory,
        escrow: chain.deployment.escrow,
        token: chain.deployment.token,
        curve: chain.deployment.curve,
        serverPid: server.pid ?? null,
        dbServerPid: dbServer.pid ?? null,
      })
    }

    // The chain handle cannot cross into the teardown module, so the teardown
    // kills by pid from the state file. Recording the anvil pid is not enough
    // on its own -- `startAnvil` does not expose it -- so the run also stops
    // it here through the closure the reporter process keeps alive.
    globalThis.__arcpadStopChain = () => chain.stop()
  } catch (error) {
    await chain.stop()
    throw error
  }
}

declare global {
  var __arcpadStopChain: (() => Promise<void>) | undefined
}
