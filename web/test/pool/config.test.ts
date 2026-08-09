import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CREATE2_FACTORY, loadAddressBook, WEB_ENV_BINDINGS, webEnvBlock } from '@arcpad/shared'
import { ARC_TESTNET_CHAIN_ID } from '@arcpad/shared/browser'
import { getAddress, getCreate2Address, keccak256, toBytes } from 'viem'
import { describe, expect, it } from 'vitest'
import { readWebConfig, WebConfigError, type WebEnv } from '@/lib/addresses'

/**
 * ============ THE ROUTER ADDRESS: WHERE IT COMES FROM AND WHAT IS MISSING ============
 *
 * `ArcpadRouter` is the ONLY way a wallet can reach a graduated pool, and
 * NOTHING ON CHAIN REFERENCES IT -- not the pool, not the hook, not the
 * factory, not the token. So unlike `graduationTarget`, it cannot be read from
 * the chain: it has to be configured, and a wrong value is a site that trades
 * through somebody else's contract.
 *
 * The address book carries it as `arcpadRouter` alongside `routerInitcodeHash`,
 * and `loadAddressBook` RE-DERIVES it offline (CREATE2 + the salt) rather than
 * trusting the copy. This file checks the three claims web depends on:
 *
 *   1. the book's router is genuinely derivable (not just copied),
 *   2. it is the address measured live on 2026-08-09,
 *   3. `web/lib/addresses.ts` treats the env var the way the shared binding
 *      table currently allows -- and says so with an expiring exemption.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

/**
 * THE SALT, DERIVED FROM ITS NAME HERE RATHER THAN IMPORTED -- AND NOT BY
 * CHOICE.
 *
 * `packages/shared/src/addresses.ts` defines `ROUTER_SALT` and USES it inside
 * `loadAddressBook`, but `src/index.ts` DOES NOT RE-EXPORT IT: the barrel
 * carries `ESCROW_SALT` and `FACTORY_SALT` and stops there. Measured while
 * writing this file -- the import compiled under vitest (which transpiles
 * without type-checking), evaluated to `undefined`, and `getCreate2Address`
 * cheerfully derived a DIFFERENT address from an undefined salt. That is a
 * one-line follow-up for `packages/` (add `ROUTER_SALT` to the barrel).
 *
 * Deriving it from the name is also the stronger check: `RouterDeployLib`'s
 * salt is `keccak256("arcpad.ArcpadRouter.v1")` by definition, so this asserts
 * the book against the DEFINITION rather than against another copy of it.
 */
const ROUTER_SALT = keccak256(toBytes('arcpad.ArcpadRouter.v1'))

/**
 * MEASURED 2026-08-09 by `eth_getCode` and two `eth_call`s against
 * `rpc.testnet.arc.io`:
 *
 *   code at 0x6D9f4270…            6679 runtime bytes
 *   router.poolManager()           0x617321A877e024C870516CD599A581dCDCa6c09b
 *   router.hook()                  0xd95198Cd806B736C8EcEcfFC23976b59F565e0cC
 *
 * Both answers equal the address book's `poolManager` / `arcpadHook`, which is
 * the only executable proof that the configured router is wired to the pool
 * this app talks about.
 */
const LIVE = {
  router: '0x6D9f42706C7E7bF3D2Ad3123ca7397DA6F0bB7cd',
  poolManager: '0x617321A877e024C870516CD599A581dCDCa6c09b',
  hook: '0xd95198Cd806B736C8EcEcfFC23976b59F565e0cC',
  runtimeBytes: 6679,
} as const

const BASE_ENV: WebEnv = {
  NEXT_PUBLIC_ARC_CHAIN_ID: String(ARC_TESTNET_CHAIN_ID),
  NEXT_PUBLIC_ARCPAD_FACTORY: '0x5CA156f1809aB784655410d0f4B0704d2b306B47',
  NEXT_PUBLIC_ARCPAD_ESCROW: '0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6',
}

describe('the book’s router is DERIVED, not merely copied', () => {
  it('CREATE2 over the recorded initcode hash reproduces the address', () => {
    const book = loadAddressBook(ARC_TESTNET_CHAIN_ID)
    const derived = getCreate2Address({
      from: CREATE2_FACTORY,
      salt: ROUTER_SALT,
      bytecodeHash: book.routerInitcodeHash,
    })
    expect(derived).toBe(book.arcpadRouter)
    // AND IT IS THE ONE THE LIVE CHAIN ANSWERED FOR. This is the half a
    // self-consistent transcription cannot give: the derivation proves the book
    // agrees with itself; this proves it agrees with the chain.
    expect(book.arcpadRouter).toBe(getAddress(LIVE.router))
  })

  it('the router’s own wiring, as measured, is the pool this app talks about', () => {
    const book = loadAddressBook(ARC_TESTNET_CHAIN_ID)
    expect(book.poolManager).toBe(getAddress(LIVE.poolManager))
    expect(book.arcpadHook).toBe(getAddress(LIVE.hook))
    expect(LIVE.runtimeBytes).toBeGreaterThan(0)
  })
})

describe('the web env: optional today, and the exemption expires loudly', () => {
  it('an absent router is `null`, and the rest of the config still loads', () => {
    const config = readWebConfig(BASE_ENV)
    expect(config.addresses.arcpadRouter).toBeNull()
    expect(config.addresses.launchFactory).toBe(getAddress(BASE_ENV.NEXT_PUBLIC_ARCPAD_FACTORY!))
  })

  it('an empty string is UNSET, not a wrong value', () => {
    expect(
      readWebConfig({ ...BASE_ENV, NEXT_PUBLIC_ARCPAD_ROUTER: '   ' }).addresses.arcpadRouter,
    ).toBeNull()
  })

  it('a present-but-invalid router still THROWS -- "not configured" is not "misconfigured"', () => {
    // Collapsing the two would ship a silently router-less site whose only
    // symptom is that graduated tokens cannot be traded.
    expect(() => readWebConfig({ ...BASE_ENV, NEXT_PUBLIC_ARCPAD_ROUTER: 'nope' })).toThrow(
      WebConfigError,
    )
    try {
      readWebConfig({ ...BASE_ENV, NEXT_PUBLIC_ARCPAD_ROUTER: 'nope' })
    } catch (error) {
      expect((error as WebConfigError).kind).toBe('invalid')
      expect((error as WebConfigError).key).toBe('NEXT_PUBLIC_ARCPAD_ROUTER')
    }
  })

  it('a valid router is checksummed on the way in', () => {
    const config = readWebConfig({
      ...BASE_ENV,
      NEXT_PUBLIC_ARCPAD_ROUTER: LIVE.router.toLowerCase(),
    })
    expect(config.addresses.arcpadRouter).toBe(getAddress(LIVE.router))
  })

  /**
   * ============ AWAITING_FIXTURE: THE SHARED BINDING TABLE ============
   *
   * `WEB_ENV_BINDINGS` in `packages/shared/src/addresses.ts` is the ONE table
   * that both `pnpm addressbook` (the generator) and `assertEnvMatchesBook`
   * (the auditor) read, and CI writes its build env from `webEnvBlock(book)`.
   * It does not carry `NEXT_PUBLIC_ARCPAD_ROUTER`, and `packages/` belongs to
   * another track -- so making the address REQUIRED here today would fail every
   * existing build, CI's included, at the `/_not-found` prerender.
   *
   * THIS TEST GOES RED THE DAY THE KEY IS ADDED, and that is its job: on that
   * day `arcpadRouter` must stop being nullable, `requireAddress` must replace
   * `optionalAddress`, and this exemption must be deleted. Without it the
   * optionality would outlive its reason silently, which is the shape of every
   * stale exemption this repository has had to find the hard way.
   */
  it('AWAITING_FIXTURE — the shared binding table does not carry the router yet', () => {
    const names = WEB_ENV_BINDINGS.map((binding) => binding.name)
    expect(
      names,
      'NEXT_PUBLIC_ARCPAD_ROUTER has landed in WEB_ENV_BINDINGS. Delete this exemption, make ' +
        'ArcpadAddresses.arcpadRouter non-nullable, swap optionalAddress for requireAddress in ' +
        'web/lib/addresses.ts, and drop the routerMissing branch from PoolTradePanel.',
    ).not.toContain('NEXT_PUBLIC_ARCPAD_ROUTER')
    // ANTI-VACUITY: the table really is the one preflight uses, and it really
    // does carry the other four.
    expect(names).toContain('NEXT_PUBLIC_ARCPAD_FACTORY')
    expect(webEnvBlock(loadAddressBook(ARC_TESTNET_CHAIN_ID))).not.toMatch(/ARCPAD_ROUTER/)
  })

  /**
   * AND THE VARIABLE IS DISCOVERABLE ANYWAY.
   *
   * `.env.example` is the only place an operator learns a variable exists. A
   * value that CI cannot generate and the example does not mention is a value
   * nobody sets, and then the pool panel is dark on every deployment for a
   * reason no one can see.
   */
  it('.env.example names the variable, blank, with the address book as its source', () => {
    const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8')
    expect(example).toMatch(/^NEXT_PUBLIC_ARCPAD_ROUTER=\s*$/m)
    // Blank, like the other four -- copying the address in would make the
    // "not configured" state unreachable and preflight's exit code 2 dead.
    expect(example).not.toContain(LIVE.router)
  })
})
