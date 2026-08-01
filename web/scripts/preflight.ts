import { createPublicClient, http } from 'viem'
import { readWebConfig, WebConfigError } from '../lib/addresses'
import {
  PREFLIGHT_NOT_CONFIGURED,
  preflightExitMeaning,
  runPreflight,
  viemPreflightReader,
} from '../lib/preflight'

/**
 * `pnpm --filter @arcpad/web preflight`
 *
 * A thin shell around `runPreflight`. Everything worth testing lives in
 * `lib/preflight.ts` and is exercised against stubs; this file only builds a
 * real client and translates the result into an exit code, so that "the
 * negative paths are tested" is not a claim about code that only ever runs
 * against a live RPC.
 */
async function main(): Promise<number> {
  const env = process.env as Record<string, string | undefined>

  // Building the client needs the chain and the RPC URL, which is the very
  // first thing the preflight validates. Resolve it here so that an unset env
  // exits 2 with a named variable instead of throwing inside viem.
  let rpcUrl: string
  let chain
  try {
    const config = readWebConfig(env)
    rpcUrl = config.rpcUrl
    chain = config.chain
  } catch (error) {
    if (error instanceof WebConfigError) {
      process.stderr.write(`FAIL ${error.message}\n`)
      const code = error.kind === 'unset' ? PREFLIGHT_NOT_CONFIGURED : 1
      process.stderr.write(`exit ${code}: ${preflightExitMeaning(code)}\n`)
      return code
    }
    throw error
  }

  const client = createPublicClient({ chain, transport: http(rpcUrl) })
  const result = await runPreflight({
    env,
    reader: viemPreflightReader(client),
    log: (line) => process.stdout.write(`${line}\n`),
  })
  if (result.code !== 0) {
    process.stderr.write(`exit ${result.code}: ${preflightExitMeaning(result.code)}\n`)
  }
  return result.code
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(
      `FAIL preflight crashed: ${error instanceof Error ? error.stack : String(error)}\n`,
    )
    process.exitCode = 1
  },
)
