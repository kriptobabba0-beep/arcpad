import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'

import { buildAddressBook, resolveEscrow, resolvePool } from '../addressbook'

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

const previousBook = (over: Record<string, unknown> = {}) => ({
  feeEscrow: CHAIN_ESCROW,
  escrowInitcodeHash: CHAIN_ESCROW_INITCODE,
  feeEscrowBlock: '54661437',
  feeSchedule: '0x47548C1ce996b24846E948B815459D98BB08dc84',
  poolManager: '0x617321A877e024C870516CD599A581dCDCa6c09b',
  arcpadHook: '0xd95198Cd806B736C8EcEcfFC23976b59F565e0cC',
  arcpadLocker: '0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8',
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
})
