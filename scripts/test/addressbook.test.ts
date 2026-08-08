import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'

import { resolveEscrow, resolvePool } from '../addressbook'

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
