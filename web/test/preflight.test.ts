import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addressBookPath,
  type AddressBook,
  DEFAULT_BOOK_DIR,
  GOVERNANCE_PATH,
  loadAddressBook,
  readProfiles,
} from '@arcpad/shared'
import { ARC_TESTNET_CHAIN_ID } from '@arcpad/shared/browser'
import type { Address } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  isRateLimited,
  PREFLIGHT_DISAGREES,
  PREFLIGHT_NOT_CONFIGURED,
  PREFLIGHT_OK,
  PREFLIGHT_UNREACHABLE,
  type PreflightCode,
  preflightExitMeaning,
  type PreflightReader,
  runPreflight,
} from '../lib/preflight'

/**
 * THE PREFLIGHT MUST FAIL CLOSED, AND THAT IS SHOWN HERE RATHER THAN CLAIMED.
 *
 * Every negative case below runs the real `runPreflight` against the real
 * committed address book and the real `expected-governance.json`. The only
 * fakes are the chain reads, which are behind `PreflightReader` precisely so
 * the disagreement cases can exist at all.
 */

const CHAIN_ID = ARC_TESTNET_CHAIN_ID
const BOOK: AddressBook = loadAddressBook(CHAIN_ID)
const PROFILES = readProfiles()

function goodEnv(): Record<string, string | undefined> {
  return {
    NEXT_PUBLIC_ARC_CHAIN_ID: String(BOOK.chainId),
    NEXT_PUBLIC_ARCPAD_FACTORY: BOOK.launchFactory,
    NEXT_PUBLIC_ARCPAD_ESCROW: BOOK.feeEscrow,
    ARC_FACTORY_ADDRESS: BOOK.launchFactory,
    ARC_ESCROW_ADDRESS: BOOK.feeEscrow,
    ARC_START_BLOCK: String(BOOK.startBlock),
  }
}

function goodReader(overrides: Partial<PreflightReader> = {}): PreflightReader {
  return {
    getChainId: async () => BOOK.chainId,
    getCode: async () => `0x${'60'.repeat(120)}`,
    readFactoryEscrow: async () => BOOK.feeEscrow,
    readFactoryVirtualQuoteReserves: async () => BOOK.virtualQuoteReserves,
    ...overrides,
  }
}

let tmpRoot: string
let emptyDir: string
let tamperedGovernanceDir: string
let wrongProfileDir: string

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'arcpad-preflight-'))
  emptyDir = join(tmpRoot, 'empty')
  tamperedGovernanceDir = join(tmpRoot, 'tampered-governance')
  wrongProfileDir = join(tmpRoot, 'wrong-profile')
  for (const dir of [emptyDir, tamperedGovernanceDir, wrongProfileDir]) {
    mkdirSync(dir, { recursive: true })
  }

  const raw = JSON.parse(
    readFileSync(addressBookPath(CHAIN_ID, DEFAULT_BOOK_DIR), 'utf8'),
  ) as Record<string, unknown>

  // A book that is internally consistent -- correct chain key, correct
  // profile digest, both addresses still derivable from their initcode
  // hashes -- and whose governor is simply not the Safe the reviewed
  // governance file names. Nothing but the cross-file check can see this.
  writeFileSync(
    addressBookPath(CHAIN_ID, tamperedGovernanceDir),
    JSON.stringify({ ...raw, governor: '0x0000000000000000000000000000000000000601' }, null, 2),
    'utf8',
  )

  // A book claiming the production economy on the chain that is running the
  // testnet one. V differs by exactly 1000x and nothing downstream notices.
  writeFileSync(
    addressBookPath(CHAIN_ID, wrongProfileDir),
    JSON.stringify(
      {
        ...raw,
        profile: 'production',
        virtualTokenReserves: String(PROFILES.production.virtualTokenReserves),
        virtualQuoteReserves: String(PROFILES.production.virtualQuoteReserves),
        saleSupply: String(PROFILES.production.saleSupply),
      },
      null,
      2,
    ),
    'utf8',
  )
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('preflight, happy path', () => {
  it('passes against the committed book with agreeing chain reads', async () => {
    const result = await runPreflight({ env: goodEnv(), reader: goodReader() })
    expect(result.lines.join('\n')).toContain('OK preflight passed')
    expect(result.code).toBe(PREFLIGHT_OK)
  })

  it('names which economy is live, on stdout', async () => {
    const logged: string[] = []
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader(),
      log: (line) => logged.push(line),
    })
    expect(result.code).toBe(PREFLIGHT_OK)
    expect(logged.join('\n')).toContain(`profile    ${BOOK.profile} profile`)
  })
})

describe('preflight fails closed: NOT CONFIGURED is exit 2', () => {
  // The state `cp .env.example .env` produces. A preflight that skipped here
  // would be indistinguishable from one that passed.
  it('a blank env exits 2, naming the first missing variable', async () => {
    const result = await runPreflight({
      env: { NEXT_PUBLIC_ARC_CHAIN_ID: '', NEXT_PUBLIC_ARCPAD_FACTORY: '' },
      reader: goodReader(),
    })
    expect(result.code).toBe(PREFLIGHT_NOT_CONFIGURED)
    expect(result.lines.join('\n')).toContain('NEXT_PUBLIC_ARC_CHAIN_ID')
  })

  it('an env with no addresses exits 2, not 1', async () => {
    const env = goodEnv()
    env['NEXT_PUBLIC_ARCPAD_FACTORY'] = ''
    const result = await runPreflight({ env, reader: goodReader() })
    expect(result.code).toBe(PREFLIGHT_NOT_CONFIGURED)
  })

  it('a MISSING address book exits 2 and names the path it looked for', async () => {
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader(),
      bookDir: emptyDir,
    })
    expect(result.code).toBe(PREFLIGHT_NOT_CONFIGURED)
    expect(result.lines.join('\n')).toContain('cannot read')
    expect(result.lines.join('\n')).toContain(`addresses.${CHAIN_ID}.json`)
  })

  // A server-side variable being unset is just as unconfigured as a browser
  // one: the indexer and keeper read those, and a half-configured deployment
  // is a split brain, not a working one.
  it('a set browser env with an unset server env still exits 2', async () => {
    const env = goodEnv()
    env['ARC_START_BLOCK'] = ''
    const result = await runPreflight({ env, reader: goodReader() })
    expect(result.code).toBe(PREFLIGHT_NOT_CONFIGURED)
    expect(result.lines.join('\n')).toContain('ARC_START_BLOCK')
  })
})

describe('preflight fails closed: DISAGREEMENT is exit 1', () => {
  it('a wrong chain id on the RPC exits 1 and prints BOTH values', async () => {
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader({ getChainId: async () => 1 }),
    })
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
    const text = result.lines.join('\n')
    expect(text).toContain('reports chain 1')
    expect(text).toContain(String(BOOK.chainId))
  })

  it('a chain id that is not in the registry exits 1, not 2', async () => {
    const env = goodEnv()
    env['NEXT_PUBLIC_ARC_CHAIN_ID'] = '424242'
    const result = await runPreflight({ env, reader: goodReader() })
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
  })

  it('a factory address with no code exits 1', async () => {
    for (const empty of ['0x', undefined]) {
      const result = await runPreflight({
        env: goodEnv(),
        reader: goodReader({ getCode: async () => empty }),
      })
      expect(result.code).toBe(PREFLIGHT_DISAGREES)
      expect(result.lines.join('\n')).toContain('no code at the configured factory')
    }
  })

  // Individually valid, mutually wrong -- the realistic copy-paste error, and
  // invisible to every check that looks at one address at a time.
  it("a factory paired with someone else's escrow exits 1", async () => {
    const other = '0x0000000000000000000000000000000000009999' as Address
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader({ readFactoryEscrow: async () => other }),
    })
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
    expect(result.lines.join('\n')).toContain('points at escrow')
  })

  it('a stale env address that disagrees with the book exits 1', async () => {
    const env = goodEnv()
    env['NEXT_PUBLIC_ARCPAD_FACTORY'] = '0x0000000000000000000000000000000000009999'
    const result = await runPreflight({ env, reader: goodReader() })
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
    expect(result.lines.join('\n')).toContain('NEXT_PUBLIC_ARCPAD_FACTORY')
  })

  // ---- THE GOVERNANCE CROSS-CHECK ----
  //
  // The book below is internally perfect. It fails only because
  // `expected-governance.json` -- reached through a MODULE CONSTANT, not an
  // env variable -- names a different governor.
  it('a book whose governance disagrees with the reviewed file exits 1', async () => {
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader(),
      bookDir: tamperedGovernanceDir,
    })
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
    const text = result.lines.join('\n')
    expect(text).toContain('address book:')
    expect(text).toContain('governor')
    expect(text).toContain('expected-governance.json')
  })

  // If the governance path were env-redirectable, this would let the tampered
  // book through. The keeper has a contract test on the same property; this is
  // the web half, so that "one entrypoint covered" does not read as "all
  // entrypoints covered".
  it('no environment variable can redirect the governance file', async () => {
    const env = goodEnv()
    env['GOVERNANCE_PATH'] = join(DEFAULT_BOOK_DIR, 'testdata', 'tampered-governance.json')
    env['ARCPAD_GOVERNANCE_FILE'] = env['GOVERNANCE_PATH']
    env['KEEPER_GOVERNANCE_FILE'] = env['GOVERNANCE_PATH']
    const result = await runPreflight({
      env,
      reader: goodReader(),
      bookDir: tamperedGovernanceDir,
    })
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
    expect(GOVERNANCE_PATH).toContain('expected-governance.json')
  })

  // ---- THE PROFILE CROSS-CHECK ----

  it('a production V on a testnet deployment exits 1', async () => {
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader({
        readFactoryVirtualQuoteReserves: async () => PROFILES.production.virtualQuoteReserves,
      }),
    })
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
    expect(result.lines.join('\n')).toContain('the chain is running the "production" profile')
  })

  it('a book claiming production against a testnet chain exits 1', async () => {
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader(),
      bookDir: wrongProfileDir,
    })
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
  })

  it('a V that matches no reviewed profile exits 1 and lists the ones it knows', async () => {
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader({ readFactoryVirtualQuoteReserves: async () => 1n }),
    })
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
    const text = result.lines.join('\n')
    expect(text).toContain('no reviewed profile')
    expect(text).toContain('testnet=')
    expect(text).toContain('production=')
  })

  // A contract that HAS code but is not a LaunchFactory reverts on
  // `escrow()`. That is a wrong address, not an unreachable node.
  it('a reverting factory call exits 1, not 3', async () => {
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader({
        readFactoryEscrow: async () => {
          throw new Error('execution reverted for an unknown reason')
        },
      }),
      retry: { sleep: async () => {} },
    })
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
    expect(result.lines.join('\n')).toContain('does not behave like a LaunchFactory')
  })

  // ANTI-VACUITY. Every case above asserts a non-zero code, which a
  // `runPreflight` that always failed would also satisfy. This pins that the
  // candidate profile values are read from profiles.toml rather than written
  // into preflight.ts, by showing the testnet value is accepted and is not
  // the production one.
  it('the accepted V is the one profiles.toml calls testnet, and the two differ', async () => {
    expect(PROFILES.testnet.virtualQuoteReserves).not.toBe(PROFILES.production.virtualQuoteReserves)
    expect(BOOK.virtualQuoteReserves).toBe(PROFILES.testnet.virtualQuoteReserves)
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader({
        readFactoryVirtualQuoteReserves: async () => PROFILES.testnet.virtualQuoteReserves,
      }),
    })
    expect(result.code).toBe(PREFLIGHT_OK)
  })
})

/**
 * These exist because of an OBSERVED failure. The first live run of
 * `scripts/preflight.ts` against `rpc.testnet.arc.io` cleared five assertions
 * and then died on `factory.VIRTUAL_QUOTE_RESERVES()` with
 * "Details: request limit reached" -- Arc throttles sequential eth_calls --
 * and reported it as exit 1, i.e. "your deployment is misconfigured". It was
 * not. A throttle that blocks a correct deploy is worse than no preflight.
 */
describe('preflight fails closed: UNREACHABLE is exit 3, never exit 1', () => {
  const throttled = () => {
    throw new Error(
      'ContractFunctionExecutionError: RPC Request failed.\nDetails: request limit reached',
    )
  }

  it('a persistently throttled RPC exits 3 and says nothing was contradicted', async () => {
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader({ readFactoryVirtualQuoteReserves: async () => throttled() }),
      retry: { attempts: 3, delayMs: 0, sleep: async () => {} },
    })
    expect(result.code).toBe(PREFLIGHT_UNREACHABLE)
    const text = result.lines.join('\n')
    expect(text).toContain('VIRTUAL_QUOTE_RESERVES')
    expect(text).toContain('NOT contradicted')
  })

  it('a throttle that clears on retry still passes', async () => {
    let attempts = 0
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader({
        readFactoryVirtualQuoteReserves: async () => {
          attempts += 1
          if (attempts < 3) throttled()
          return BOOK.virtualQuoteReserves
        },
      }),
      retry: { attempts: 4, delayMs: 0, sleep: async () => {} },
    })
    expect(attempts).toBe(3)
    expect(result.code).toBe(PREFLIGHT_OK)
  })

  it('recognises the throttle, and does not mistake a revert for one', () => {
    expect(isRateLimited(new Error('Details: request limit reached'))).toBe(true)
    expect(isRateLimited(new Error('HTTP 429 Too Many Requests'))).toBe(true)
    expect(isRateLimited(new Error('execution reverted'))).toBe(false)
  })

  // A DISAGREEMENT MUST NEVER BE RETRIED. Retrying a mismatch is a loop that
  // reports the same mismatch later, or a different one mid-reorg -- and it
  // would turn a hard stop into something that eventually "passes" if the
  // chain state moves.
  it('never retries a wrong answer', async () => {
    let reads = 0
    const result = await runPreflight({
      env: goodEnv(),
      reader: goodReader({
        getChainId: async () => {
          reads += 1
          return 1
        },
      }),
      retry: { attempts: 5, delayMs: 0, sleep: async () => {} },
    })
    expect(reads).toBe(1)
    expect(result.code).toBe(PREFLIGHT_DISAGREES)
  })

  /**
   * AN UNSTATED PRECONDITION, STATED.
   *
   * `pnpm --filter @arcpad/web preflight` runs `tsx scripts/preflight.ts`, and
   * `tsx` is NOT a declared dependency of this package. It resolves today only
   * because it is an OPTIONAL PEER of `vite`, which arrives through `vitest`
   * (`pnpm-lock.yaml`: `vite@8.1.5(...)(tsx@4.23.1)`). A vite release that
   * drops that peer would break the preflight command with a "tsx: not found"
   * that has nothing to do with anything in this repo.
   *
   * If this goes red, the fix is to declare `tsx` in `web/package.json`
   * devDependencies and run an install -- not to delete this test.
   */
  it('the preflight command has an interpreter it did not declare', () => {
    const bin = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.CMD' : 'tsx',
    )
    expect(existsSync(bin), `${bin} is missing; declare tsx in web/package.json`).toBe(true)
  })

  it('gives every exit code a distinct meaning', () => {
    const codes: PreflightCode[] = [
      PREFLIGHT_OK,
      PREFLIGHT_DISAGREES,
      PREFLIGHT_NOT_CONFIGURED,
      PREFLIGHT_UNREACHABLE,
    ]
    expect(new Set(codes).size).toBe(codes.length)
    expect(new Set(codes.map(preflightExitMeaning)).size).toBe(codes.length)
  })
})
