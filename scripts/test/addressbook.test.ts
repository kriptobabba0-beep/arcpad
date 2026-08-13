import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { getAddress } from 'viem'

import { buildAddressBook, resolveEscrow, resolvePool, resolveRouter } from '../addressbook'
import { REPO_ROOT } from '../../packages/shared/src/profiles'

/**
 * THE IMPORT ABOVE IS ITSELF THE FIRST TEST.
 *
 * `addressbook.ts` called `main()` UNCONDITIONALLY at module scope until
 * 2026-08-09, so importing it ran the generator: it parsed an empty argv,
 * printed `usage:` and set `process.exitCode = 1`. That is why the file
 * exported `resolveEscrow` / `resolvePool` / `buildAddressBook` "for testing"
 * with ZERO callers -- the functions were exported for a test that could not
 * exist. Remove the entrypoint guard and this file starts a generator run.
 */

const CHAIN_ESCROW = getAddress('0xeed4431ead3e27f16d97f677a9c4c1a963df8dc6')
const CHAIN_ESCROW_INITCODE = '0xd99a4f910483ee8e40e4898fee5ef732462b55888427cd00c89697b0bff435e8'

const CHAIN_ROUTER = getAddress('0x7496950e09260e1aa7d8785edc46f7e87d25eb30')
const CHAIN_ROUTER_INITCODE = '0x171fbf38f4cc2fd50ccb9ccea85bd2e56e503c1d37a4ad059cdb0febf87a7e9b'

const previousBook = (over: Record<string, unknown> = {}) => ({
  feeEscrow: CHAIN_ESCROW,
  escrowInitcodeHash: CHAIN_ESCROW_INITCODE,
  feeEscrowBlock: '54661437',
  feeSchedule: '0x47548C1ce996b24846E948B815459D98BB08dc84',
  poolManager: '0x617321A877e024C870516CD599A581dCDCa6c09b',
  arcpadHook: '0xd95198Cd806B736C8EcEcfFC23976b59F565e0cC',
  arcpadLocker: '0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8',
  arcpadRouter: CHAIN_ROUTER,
  routerInitcodeHash: CHAIN_ROUTER_INITCODE,
  ...over,
})

const emptyReceipt = { escrow: null, factory: {} as never, bySalt: new Map() }

describe('the module can be imported without running the generator', () => {
  it('did not set a failing exit code merely by being imported', () => {
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true)
  })
})

describe('resolveEscrow', () => {
  /**
   * THE CARRY PATH IS NOT FREE, AND THIS IS THE LINE THAT MAKES IT SAFE.
   * The address is not copied -- it is RE-DERIVED from the previous book's own
   * recorded initcode hash via CREATE2, so what gets carried is not "an
   * address" but "an address proven to derive from its own initcode". These
   * are the real live values, so a passing test means the real book is
   * self-consistent, not that a fixture is.
   */
  it('re-derives the carried address from the recorded initcode hash', () => {
    const out = resolveEscrow(emptyReceipt, previousBook())
    expect(out.address).toBe(CHAIN_ESCROW)
    expect(out.block).toBe(54661437n)
  })

  it('refuses a previous book whose recorded address disagrees with its own hash', () => {
    const tampered = previousBook({
      feeEscrow: '0x0000000000000000000000000000000000001234',
    })
    expect(() => resolveEscrow(emptyReceipt, tampered)).toThrow(/derives/)
  })

  /**
   * WHY THE CARRY PATH EXISTS AT ALL. Task 7's escrow REUSE arm skipped the
   * escrow deployment, so `Deploy.s.sol` sent two transactions instead of
   * three and the broadcast carries no FeeEscrow. The arm that protects the
   * escrow broke the tool that records it; this is the repair.
   */
  it('stops by name when there is neither a broadcast escrow nor a previous book', () => {
    expect(() => resolveEscrow(emptyReceipt, null)).toThrow(/no previous book to carry it from/)
  })

  it('stops by name when the previous book is missing any of the three escrow fields', () => {
    for (const field of ['feeEscrow', 'escrowInitcodeHash', 'feeEscrowBlock']) {
      const book = previousBook()
      delete (book as Record<string, unknown>)[field]
      expect(() => resolveEscrow(emptyReceipt, book), field).toThrow(/escrowInitcodeHash/)
    }
  })
})

describe('resolvePool', () => {
  it('carries all four pool-layer addresses from the previous book when there is no receipt', () => {
    const out = resolvePool(null, previousBook(), undefined)
    expect(out.poolManager).toBe(getAddress('0x617321A877e024C870516CD599A581dCDCa6c09b'))
    expect(out.arcpadHook).toBe(getAddress('0xd95198Cd806B736C8EcEcfFC23976b59F565e0cC'))
    expect(out.arcpadLocker).toBe(getAddress('0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8'))
    expect(out.feeSchedule).toBe(getAddress('0x47548C1ce996b24846E948B815459D98BB08dc84'))
  })

  /**
   * The generator must STOP rather than write a book with a missing field:
   * the loader would reject that file anyway, and the diagnosis is cheaper
   * here than three layers downstream.
   */
  it('stops by name rather than writing a partial book', () => {
    expect(() => resolvePool(null, null, undefined)).toThrow(/cannot determine feeSchedule/)
    const noHook = previousBook()
    delete (noHook as Record<string, unknown>).arcpadHook
    expect(() => resolvePool(null, noHook, undefined)).toThrow(/cannot determine arcpadHook/)
  })
})

/**
 * `resolveRouter` — AND THE RECEIPT IT READS IS THE REAL ONE.
 *
 * These cases run against `contracts/broadcast/DeployRouter.s.sol/5042002/
 * run-latest.json`, the receipt of tx
 * `0x130b321d...` in block 56127501, not a synthetic fixture. That choice is
 * the whole point: `readDeployments` keys deployments BY SALT taken from the
 * first 32 bytes of the calldata the script actually sent, so a `ROUTER_SALT`
 * in TypeScript that disagreed with `RouterDeployLib.ROUTER_SALT` in Solidity
 * would make the lookup MISS and these tests fail. Nothing else in the
 * TypeScript tree pins that cross-language pair, and a synthetic receipt would
 * have pinned it against itself.
 *
 * The repo has already been burned by the generous-fixture failure: the
 * synthetic broadcast assumed `transactionType: "CALL"` with
 * `additionalContracts`, and the first REAL receipt (`"CREATE2"` +
 * `contractAddress`) stopped the generator dead.
 */
describe('resolveRouter', () => {
  const ROUTER_RECEIPT = join(
    REPO_ROOT,
    'contracts',
    'broadcast',
    'DeployRouter.s.sol',
    '5042002',
    'run-latest.json',
  )
  const POOL_RECEIPT = join(
    REPO_ROOT,
    'contracts',
    'broadcast',
    'DeployPool.s.sol',
    '5042002',
    'run-latest.json',
  )

  it('takes the router from the real DeployRouter receipt, keyed by the derived salt', () => {
    const out = resolveRouter(ROUTER_RECEIPT, null)
    expect(out.address).toBe(CHAIN_ROUTER)
    expect(out.initcodeHash).toBe(CHAIN_ROUTER_INITCODE)
  })

  /**
   * THE WRONG RECEIPT IS A REAL WAY TO BE WRONG, so it is driven with a real
   * receipt that really does not carry a router: `DeployPool`'s. Reading it
   * must STOP rather than fall through to the carry path, because falling
   * through would let a book quietly keep a stale router across a redeploy.
   */
  it('stops when the receipt it was pointed at deployed no router', () => {
    expect(() => resolveRouter(POOL_RECEIPT, previousBook())).toThrow(/no ArcpadRouter deployment/)
  })

  /**
   * THE CARRY PATH IS `resolveEscrow`'S, NOT `resolvePool`'S. The address is
   * RE-DERIVED from the previous book's own `routerInitcodeHash` via CREATE2;
   * the pool triple cannot do this because the book records no hash for it.
   */
  it('re-derives the carried router from the recorded initcode hash', () => {
    const out = resolveRouter(null, previousBook())
    expect(out.address).toBe(CHAIN_ROUTER)
    expect(out.initcodeHash).toBe(CHAIN_ROUTER_INITCODE)
  })

  it('refuses a previous book whose recorded router disagrees with its own hash', () => {
    const tampered = previousBook({ arcpadRouter: '0x0000000000000000000000000000000000001234' })
    expect(() => resolveRouter(null, tampered)).toThrow(/derives/)
  })

  it('stops by name, and names the deploy ORDER, when neither source has it', () => {
    expect(() => resolveRouter(null, null)).toThrow(/cannot determine arcpadRouter/)
    expect(() => resolveRouter(null, null)).toThrow(/Deploy -> DeployPool -> DeployRouter/)
    for (const field of ['arcpadRouter', 'routerInitcodeHash']) {
      const book = previousBook()
      delete (book as Record<string, unknown>)[field]
      expect(() => resolveRouter(null, book), field).toThrow(/cannot determine arcpadRouter/)
    }
  })
})

/**
 * `buildAddressBook` is the largest of the three exported-for-testing functions
 * and the one that ASSEMBLES the file. It had no test at all.
 */
const FACTORY = getAddress('0x5ca156f1809ab784655410d0f4b0704d2b306b47')
const GOVERNOR = getAddress('0x970534698e4592932f31892759147f79eb0d2c22')
const TREASURY = getAddress('0xebbecfda308ea307e173c6ec19a9c48f53d4b10c')
const ZERO = getAddress('0x0000000000000000000000000000000000000000')

const liveReads = (over: Record<string, unknown> = {}) => ({
  escrow: CHAIN_ESCROW,
  governor: GOVERNOR,
  protocolTreasury: TREASURY,
  graduationTarget: ZERO,
  virtualTokenReserves: 1073000000000000000000000000n,
  virtualQuoteReserves: 4292000000000000000n,
  saleSupply: 793100000000000000000000000n,
  totalSupply: 1000000000000000000000000000n,
  ...over,
})

const liveArgs = (over: Record<string, unknown> = {}) => ({
  chainId: 5042002,
  receipt: {
    escrow: null,
    factory: {
      address: FACTORY,
      block: 55870261n,
      txHash: '0xda23b32cc34452457cad66e85fbea9c4c2c254c0f64946e1f591167becacf3f5',
      initcodeHash: '0xd9177cabe2f31945eb6a64ac14ca862cadbe52d401e1b4d27c7c4ba8c0ada0b4',
    },
    bySalt: new Map(),
  },
  reads: liveReads(),
  commit: '0'.repeat(40),
  smokeToken: null,
  smokeCurve: null,
  escrow: {
    address: CHAIN_ESCROW,
    block: 54661437n,
    initcodeHash: CHAIN_ESCROW_INITCODE,
  },
  pool: {
    feeSchedule: getAddress('0x47548c1ce996b24846e948b815459d98bb08dc84'),
    poolManager: getAddress('0x617321a877e024c870516cd599a581dcdca6c09b'),
    arcpadHook: getAddress('0xd95198cd806b736c8ececffc23976b59f565e0cc'),
    arcpadLocker: getAddress('0x0e7771091a3471dc12cbfe38836badc7bf5a98e8'),
  },
  router: { address: CHAIN_ROUTER, initcodeHash: CHAIN_ROUTER_INITCODE },
  ...over,
})

describe('buildAddressBook', () => {
  /**
   * `startBlock` IS `min(feeEscrowBlock, launchFactoryBlock)` AND THAT MIN IS
   * LOAD-BEARING -- proven on 2026-08-09 by the indexer investigation, not by
   * the argument the schema originally gave for it.
   *
   * The escrow is keyed by RECIPIENT, not by factory, and Phase 2 REUSED the
   * Phase 1 escrow. So the 1.21M blocks before the current factory existed
   * hold 8 deposits crediting the SAME two recipients the current factory
   * credits. Start at the factory block instead and the indexer misses them;
   * then the first `Claimed` pays a slot the database under-counted, drives
   * `claimable_wei` negative, trips the CHECK, and halts -- replaying the same
   * range on every restart. Unrecoverable, not lossy.
   *
   * Anyone "optimising" this to `receipt.factory.block` would be deleting that
   * guard. This test is what stops them.
   */
  it('sets startBlock to the EARLIER of the escrow and factory blocks', () => {
    const book = buildAddressBook(liveArgs() as never)
    expect(book.startBlock).toBe('54661437')
    expect(book.feeEscrowBlock).toBe('54661437')
    expect(book.launchFactoryBlock).toBe('55870261')
  })

  it('still takes the earlier one when the ordering is reversed', () => {
    const args = liveArgs() as Record<string, unknown>
    ;(args.escrow as Record<string, unknown>).block = 99999999n
    const book = buildAddressBook(args as never)
    expect(book.startBlock).toBe('55870261')
  })

  /**
   * THE CHAIN HAS THE LAST WORD. The escrow may be carried from a previous
   * book, and this is the line that makes that safe: whatever the book says,
   * the LIVE factory's `escrow()` must agree.
   */
  it('refuses a book whose escrow disagrees with the deployed factory', () => {
    const args = liveArgs({
      reads: liveReads({ escrow: getAddress('0x0000000000000000000000000000000000001234') }),
    })
    expect(() => buildAddressBook(args as never)).toThrow(/points at escrow/)
  })

  /** The chain's own numbers must match the profile FILE, or the deploy used a different profile. */
  it('refuses when a live reserve disagrees with the profile file', () => {
    const args = liveArgs({ reads: liveReads({ virtualQuoteReserves: 1n }) })
    expect(() => buildAddressBook(args as never)).toThrow(/virtualQuoteReserves/)
  })

  /**
   * WHICH GUARD ACTUALLY FIRES, MEASURED RATHER THAN ASSUMED.
   *
   * `chainKeyFor(chainId)` runs FIRST and throws for any chain outside
   * `CHAIN_KEYS`, so an unknown chain never reaches the profile check below it.
   * That second guard -- "chain N is not registered; add it to Profiles.sol
   * first" -- can therefore only fire for a chain present in `CHAIN_KEYS` and
   * absent from `PROFILE_FOR_CHAIN`, and today both maps carry the same two
   * chains: it is UNREACHABLE by construction.
   *
   * Left in place deliberately: it is the guard for a HALF-registration, which
   * is the realistic way a new chain gets added. Recorded here so the next
   * reader does not mistake an unreachable branch for a covered one -- the
   * first version of this test asserted its message and failed, which is how
   * the ordering was discovered at all.
   */
  it('refuses an unregistered chain at the chain-key lookup, before the profile check', () => {
    expect(() => buildAddressBook(liveArgs({ chainId: 12345 }) as never)).toThrow(
      /unregistered chain 12345/,
    )
  })

  /**
   * THE ASSEMBLED FILE CARRIES THE ROUTER, AND IN THE SCHEMA'S ORDER.
   *
   * Key ORDER is asserted, not just presence: `serializeAddressBook` writes
   * `JSON.stringify` output, so this object's insertion order IS the file's
   * byte layout, and `addresses.schema.json` plus both checked-in books are
   * compared against it by `@arcpad/shared`. A field appended in the wrong
   * place would still load and would still make every future regeneration a
   * whole-file diff.
   */
  it('writes arcpadRouter and routerInitcodeHash, in the schema positions', () => {
    const book = buildAddressBook(liveArgs() as never)
    expect(book.arcpadRouter).toBe(CHAIN_ROUTER)
    expect(book.routerInitcodeHash).toBe(CHAIN_ROUTER_INITCODE)
    const keys = Object.keys(book)
    expect(keys[keys.indexOf('arcpadLocker') + 1]).toBe('arcpadRouter')
    expect(keys[keys.indexOf('factoryInitcodeHash') + 1]).toBe('routerInitcodeHash')
  })
})

// =====================================================================
// THE RULE THIS WHOLE FILE EXISTS FOR, MADE MECHANICAL.
//
// Twice a field was added to the book while the generator did not learn it,
// and a later bare regeneration would have silently DROPPED it -- once for
// the pool layer (7675f04), once for the smoke pair. Both times the property
// "the generator reproduces the checked-in book byte for byte" was verified
// BY HAND and then had to be re-verified by hand by the next agent.
//
// This runs the real CLI, end to end, in a child process: no `main()` was
// refactored into something importable, because an importable twin of the
// entrypoint is exactly the "test that passes through a path bypassing the
// code under test" this repo keeps finding. The rehearsal chain is offline by
// construction (its chain reads and its `commit` are checked in), so the run
// touches no network and the output is deterministic.
//
// A NEW FIELD THE GENERATOR CANNOT REPRODUCE NOW FAILS HERE, not in a later
// session's memory.
// =====================================================================
describe('the generator reproduces the rehearsal book byte for byte', () => {
  const scratch: string[] = []
  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  })

  it('regenerates contracts/deploy/testdata/addresses.31337.json unchanged', () => {
    const fixture = join(REPO_ROOT, 'contracts', 'deploy', 'testdata', 'addresses.31337.json')
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-rehearsal-'))
    scratch.push(dir)
    // The generator READS the previous book from `--out-dir` (that is the
    // carry path), so the fixture has to be there before it runs.
    copyFileSync(fixture, join(dir, 'addresses.31337.json'))

    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        join(REPO_ROOT, 'scripts', 'addressbook.ts'),
        '--chain',
        '31337',
        '--out-dir',
        dir,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' },
    )

    // BYTES, not parsed objects: key order and trailing newline are part of
    // the claim, and a `JSON.parse` comparison would pass while every future
    // regeneration produced a whole-file diff.
    expect(readFileSync(join(dir, 'addresses.31337.json'), 'utf8')).toBe(
      readFileSync(fixture, 'utf8'),
    )
  }, 120_000)
})
