import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARC_CHAINS, ARC_TESTNET_CHAIN_ID, buildArcChain, MULTICALL3_ADDRESS } from '../src/chain'
import { CHAIN_KEYS, chainKeyFor, REPO_ROOT } from '../src/profiles'

// --------------------------------------------------------------------------
// (a) BEHAVIOUR: an Arc network that is not in the registry can still be built
//     with ONE call. This is the entire body of work that opening a new Arc
//     network requires, so it is worth being able to point at.
// --------------------------------------------------------------------------

describe('buildArcChain', () => {
  it('builds a network that is not in the registry, in one call', () => {
    const hypothetical = buildArcChain({
      id: 424242,
      name: 'Arc Hypothetical',
      rpcHttp: 'https://rpc.example.invalid',
      explorerUrl: 'https://explorer.example.invalid',
      testnet: false,
    })
    expect(hypothetical.id).toBe(424242)
    expect(hypothetical.nativeCurrency).toEqual({
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 18,
    })
    expect(hypothetical.contracts?.multicall3?.address).toBe(MULTICALL3_ADDRESS)
    expect(hypothetical.blockExplorers?.default.url).toBe('https://explorer.example.invalid')
    expect(hypothetical.testnet).toBe(false)
  })

  it('omits webSocket rather than emitting an empty list when none is configured', () => {
    const noWs = buildArcChain({
      id: 424243,
      name: 'Arc No Socket',
      rpcHttp: 'https://rpc.example.invalid',
      explorerUrl: 'https://explorer.example.invalid',
      testnet: false,
    })
    expect(noWs.rpcUrls.default.webSocket).toBeUndefined()
  })
})

// --------------------------------------------------------------------------
// The two halves of the registry must agree. `ARC_CHAINS` is chain -> RPC
// profile; `CHAIN_KEYS` is chain -> governance key and is pinned to
// `Profiles.sol`. A chain may have a governance key and no RPC profile
// (31337 is anvil), but an RPC profile with no governance key would load an
// address book that no governance file can vouch for.
// --------------------------------------------------------------------------

describe('the two halves of the chain registry', () => {
  it('every chain with an RPC profile also has a governance key', () => {
    for (const id of Object.keys(ARC_CHAINS).map(Number)) {
      expect(() => chainKeyFor(id)).not.toThrow()
    }
  })

  it('the testnet is the same chain on both sides', () => {
    expect(CHAIN_KEYS[ARC_TESTNET_CHAIN_ID]).toBe('arc-testnet')
  })
})

// --------------------------------------------------------------------------
// (b) THE GATE. Without this, (a) is a claim on paper: a second copy of the
//     chain id or of an Arc host anywhere in the tracked source means opening
//     a new network is NOT "one registry entry", it is a hunt.
// --------------------------------------------------------------------------

const CHAIN_ID_PATTERN = /\b5042002\b/
const ARC_HOST_PATTERN = /arc\.(io|network)|arcscan/

/**
 * Files allowed to carry the literals, each with the reason it is allowed.
 * The reasons are load-bearing: `allowlist entries must still be violations`
 * below fails when an entry stops matching, so this map cannot quietly grow
 * into a blanket permission as files change.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ['packages/shared/src/chain.ts', 'the registry itself -- the one place the literals belong'],
  [
    'packages/shared/src/profiles.ts',
    'CHAIN_KEYS: the chain -> governance-key half of the registry, hand-written to stay a real cross-language gate against Profiles.sol',
  ],
  [
    'scripts/addressbook.ts',
    "the generator's chainId -> profile table. Outside this track's ownership (packages/shared, web), so it is recorded rather than moved; folding it into the registry is a change for whoever owns scripts/.",
  ],
])

/**
 * Tests are NOT scanned, and that is a deliberate, narrow carve-out: pinning a
 * constant with a literal is what a test is FOR, and `chain.test.ts` asserting
 * `arcTestnet.id === 5042002` is the assertion that gives the registry its
 * meaning. The carve-out is narrow enough that the mutant this gate exists to
 * kill -- a `chainId: 5042002` literal in `web/lib/wagmi.ts` -- still lands in
 * scanned territory, and `the scan actually covers the files that matter`
 * below measures that rather than trusting it.
 */
function isTestFile(path: string): boolean {
  return /(^|\/)test\//.test(path) || /\.test\.[cm]?tsx?$/.test(path)
}

/**
 * Removes block comments and whole-line comments, and NOTHING else.
 *
 * It deliberately does not strip trailing `//` comments. A naive `//` stripper
 * cuts `'https://rpc.testnet.arc.io'` down to `'https:` and the host half of
 * this gate would then pass on a file that does contain a hard-coded host --
 * a test asserting through a path that bypasses the thing under test. The
 * cases this repo actually has are jsdoc blocks, full-line `//` and SQL `--`,
 * all of which this handles.
 */
export function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  return withoutBlocks
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      return !(
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('--') ||
        trimmed.startsWith('#')
      )
    })
    .join('\n')
}

export type ScannedFile = { path: string; source: string }
export type Violation = { path: string; kind: 'chainId' | 'arcHost'; line: string }

export function findRegistryLeaks(files: readonly ScannedFile[]): Violation[] {
  const leaks: Violation[] = []
  for (const file of files) {
    if (ALLOWED.has(file.path) || isTestFile(file.path)) continue
    for (const line of stripComments(file.source).split(/\r?\n/)) {
      if (CHAIN_ID_PATTERN.test(line)) leaks.push({ path: file.path, kind: 'chainId', line })
      if (ARC_HOST_PATTERN.test(line)) leaks.push({ path: file.path, kind: 'arcHost', line })
    }
  }
  return leaks
}

/**
 * `git ls-files`, not a directory walk: it measures what has ENTERED the repo,
 * and `node_modules`, `contracts/out` and every build artefact fall out for
 * free rather than by an exclusion list that rots.
 */
function gitTrackedFiles(globs: readonly string[]): string[] {
  const stdout = execFileSync('git', ['ls-files', '-z', ...globs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout.split('\0').filter((line) => line !== '')
}

function trackedSources(): ScannedFile[] {
  return gitTrackedFiles(['*.ts', '*.tsx', '*.sql']).map((path) => ({
    path,
    source: readFileSync(join(REPO_ROOT, path), 'utf8'),
  }))
}

describe('the chain id and the Arc hosts live only in the registry', () => {
  // ---- the scanner itself, on inputs whose answer is known ----

  it('reports a chain-id literal in a file that has no business carrying one', () => {
    const leaks = findRegistryLeaks([
      { path: 'web/lib/wagmi.ts', source: 'export const c = { chainId: 5042002 }\n' },
    ])
    expect(leaks).toHaveLength(1)
    expect(leaks[0]?.kind).toBe('chainId')
    expect(leaks[0]?.path).toBe('web/lib/wagmi.ts')
  })

  it('reports an Arc host literal', () => {
    const leaks = findRegistryLeaks([
      { path: 'web/lib/wagmi.ts', source: "const url = 'https://rpc.testnet.arc.io'\n" },
    ])
    expect(leaks.map((l) => l.kind)).toEqual(['arcHost'])
  })

  it('does not report the same literals inside comments', () => {
    const leaks = findRegistryLeaks([
      {
        path: 'packages/shared/src/client.ts',
        source:
          '/**\n * connected to chain 5042002 over https://rpc.testnet.arc.io\n */\nexport const x = 1\n',
      },
      { path: 'packages/db/migrations/002_launches.sql', source: '-- chainId 5042002\n' },
      { path: 'indexer/src/index.ts', source: '// see https://rpc.testnet.arc.io\n' },
    ])
    expect(leaks).toEqual([])
  })

  // The stripper is the part most likely to make this gate pass for the wrong
  // reason, so its failure mode is pinned directly.
  it('the comment stripper does not eat a URL string literal', () => {
    const kept = stripComments("export const rpc = 'https://rpc.testnet.arc.io'\n")
    expect(kept).toContain('https://rpc.testnet.arc.io')
    expect(ARC_HOST_PATTERN.test(kept)).toBe(true)
  })

  // ---- the scanner, on the real repository ----

  it('the scan actually covers the files that matter', () => {
    const paths = new Set(trackedSources().map((f) => f.path))
    // If a glob or a cwd broke, this set would be empty and the gate below
    // would pass by scanning nothing.
    expect(paths.size).toBeGreaterThan(30)
    // Where the mutant would land.
    expect(paths.has('web/lib/wagmi.ts')).toBe(true)
    expect(paths.has('web/lib/addresses.ts')).toBe(true)
    // Carries the chain id in a comment only: proof that the gate passes here
    // because of comment stripping, not because the file was excluded.
    expect(paths.has('packages/shared/src/client.ts')).toBe(true)
    expect(ALLOWED.has('packages/shared/src/client.ts')).toBe(false)
    expect(isTestFile('packages/shared/src/client.ts')).toBe(false)
  })

  it('no tracked source outside the registry carries the chain id or an Arc host', () => {
    const leaks = findRegistryLeaks(trackedSources())
    const rendered = leaks.map((l) => `${l.path} [${l.kind}]: ${l.line.trim()}`).join('\n')
    expect(rendered, `registry literals leaked outside chain.ts:\n${rendered}`).toBe('')
  })

  // An allowlist that outlives its reason is how a gate turns into a rubber
  // stamp. Every entry must still be a file that WOULD trip the gate.
  it('allowlist entries must still be violations', () => {
    for (const [path, reason] of ALLOWED) {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8')
      const stripped = stripComments(source)
      const trips = CHAIN_ID_PATTERN.test(stripped) || ARC_HOST_PATTERN.test(stripped)
      expect(trips, `${path} is allowlisted ("${reason}") but no longer needs to be`).toBe(true)
    }
  })
})
