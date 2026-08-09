import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CREATE2_FACTORY,
  loadAddressBook,
  ROUTER_SALT as BARREL_ROUTER_SALT,
  WEB_ENV_BINDINGS,
  webEnvBlock,
} from '@arcpad/shared'
import { ARC_TESTNET_CHAIN_ID } from '@arcpad/shared/browser'
import { getAddress, getCreate2Address, keccak256, toBytes } from 'viem'
import { describe, expect, it } from 'vitest'
import { readWebConfig, WebConfigError, type WebEnv } from '@/lib/addresses'
import { webEnvFor } from '@/e2e/fixtures/chain'

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
 *   3. `WEB_ENV_BINDINGS` now carries `NEXT_PUBLIC_ARCPAD_ROUTER`, so every env
 *      generated from the book has it and `web/lib/addresses.ts` reads it --
 *      with the one remaining reason for the field's nullability (the devchain
 *      has no pool stack) held open as an expiring exemption.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

/**
 * THE SALT, DERIVED FROM ITS NAME HERE RATHER THAN IMPORTED -- AND NOW BY
 * CHOICE.
 *
 * This comment used to record a defect: the barrel exported `ESCROW_SALT` and
 * `FACTORY_SALT` and silently omitted the other five, so `import { ROUTER_SALT }
 * from '@arcpad/shared'` compiled under vitest (which transpiles without
 * type-checking), evaluated to `undefined`, and `getCreate2Address` cheerfully
 * derived a DIFFERENT address. That is fixed (`packages/shared/test/
 * barrel-salts.test.ts` enumerates the salts from source and fails on the next
 * one that stops at `addresses.ts`).
 *
 * Deriving it from the name is kept anyway, because it is the stronger check:
 * `RouterDeployLib`'s salt is `keccak256("arcpad.ArcpadRouter.v1")` BY
 * DEFINITION, so this asserts the book against the definition rather than
 * against another copy of it -- and the barrel's value is then checked against
 * the same definition below, which is the half that would catch a typo in the
 * shared constant itself.
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
    // AND THE SHARED CONSTANT IS THE SAME SALT. `loadAddressBook` uses the
    // barrel's value, not this one, so without this line the two could differ
    // and every assertion above would still pass.
    expect(BARREL_ROUTER_SALT).toBe(ROUTER_SALT)
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
   * ============ THE BINDING LANDED, AND THIS IS THE ASSERTION THAT REPLACED IT ============
   *
   * The old test here asserted `WEB_ENV_BINDINGS` did NOT carry the router, so
   * the day it did would be loud. It does now. What must be true from this day
   * on is the opposite, and it is stronger: an env DERIVED FROM THE BOOK carries
   * the router, and it is the book's router rather than something transcribed.
   */
  it('the binding table carries the router, and webEnvBlock emits the BOOK’s value', () => {
    const names = WEB_ENV_BINDINGS.map((binding) => binding.name)
    expect(names).toContain('NEXT_PUBLIC_ARCPAD_ROUTER')
    // ANTI-VACUITY: this really is the table preflight reads, and it still
    // carries the five it always did.
    for (const name of [
      'NEXT_PUBLIC_ARC_CHAIN_ID',
      'NEXT_PUBLIC_ARCPAD_FACTORY',
      'NEXT_PUBLIC_ARCPAD_ESCROW',
      'ARC_FACTORY_ADDRESS',
      'ARC_START_BLOCK',
    ]) {
      expect(names).toContain(name)
    }

    const book = loadAddressBook(ARC_TESTNET_CHAIN_ID)
    const line = webEnvBlock(book)
      .split('\n')
      .find((l) => l.startsWith('NEXT_PUBLIC_ARCPAD_ROUTER='))
    expect(line, 'webEnvBlock does not print the router').toBeDefined()
    // The VALUE, not just the key: a binding wired to the wrong field would
    // print a perfectly well-formed line naming the factory.
    expect(line).toBe(`NEXT_PUBLIC_ARCPAD_ROUTER=${book.arcpadRouter}`)
    expect(book.arcpadRouter).toBe(getAddress(LIVE.router))

    // AND THE ENV THIS PRODUCES REACHES THIS FILE'S READER. Generator and
    // reader are two halves and each has passed on its own before while the
    // pair did not meet.
    const fromBook = Object.fromEntries(
      webEnvBlock(book)
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    ) as WebEnv
    expect(readWebConfig(fromBook).addresses.arcpadRouter).toBe(getAddress(LIVE.router))
  })

  /**
   * ============ AWAITING_FIXTURE: THE DEVCHAIN HAS NO POOL STACK ============
   *
   * This is why `arcpadRouter` is STILL nullable, and it is a different reason
   * from the one that has just expired. `web/e2e/fixtures/chain.ts` builds the
   * app against an anvil devchain and constructs its env BY HAND from
   * `ArcpadDeployment` -- which has a factory, an escrow and a fee schedule and
   * NOTHING of the pool stack. There is no router address to pass because there
   * is no router contract, and a build that REQUIRED one would die at the
   * `/_not-found` prerender and take the whole devchain e2e leg with it.
   *
   * THIS TEST GOES RED THE DAY THAT ENV GAINS A ROUTER. On that day
   * `arcpadRouter` must stop being nullable, `requireAddress` must replace
   * `optionalAddress`, and the `routerMissing` rung in `PoolTradePanel` must go.
   *
   * It runs the REAL producer rather than reading its source, so a devchain
   * that started deploying a router would be seen here even if nobody thought
   * to update a regex.
   */
  it('AWAITING_FIXTURE — the devchain env has no router, and the reader tolerates that', () => {
    const devEnv = webEnvFor({
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: ARC_TESTNET_CHAIN_ID,
      deployment: {
        factory: BASE_ENV.NEXT_PUBLIC_ARCPAD_FACTORY as `0x${string}`,
        escrow: BASE_ENV.NEXT_PUBLIC_ARCPAD_ESCROW as `0x${string}`,
        feeSchedule: '0x0000000000000000000000000000000000000f11',
        treasury: '0x0000000000000000000000000000000000007EA5',
        token: '0x085C926e24Ed64bb045e67D26D9E76e5730c21b3',
        curve: '0xDdB9e739a948c968eB4C7E1449B94C598B1cf27B',
        creator: '0x00000000000000000000000000000000000000cc',
      },
      stop: async () => {},
    })

    expect(
      Object.keys(devEnv),
      'the devchain env now carries a router. Make ArcpadAddresses.arcpadRouter non-nullable, ' +
        'swap optionalAddress for requireAddress in web/lib/addresses.ts, drop the routerMissing ' +
        'rung from PoolTradePanel, and delete this exemption.',
    ).not.toContain('NEXT_PUBLIC_ARCPAD_ROUTER')

    // ANTI-VACUITY: this really is the env the devchain build is given, and it
    // really does carry the variables that are NOT missing.
    expect(Object.keys(devEnv)).toContain('NEXT_PUBLIC_ARCPAD_FACTORY')
    expect(Object.keys(devEnv)).toContain('NEXT_PUBLIC_ARC_CHAIN_ID')

    // AND THE READER SURVIVES IT -- which is the property that lets that build
    // exist at all. A required field would throw here.
    const config = readWebConfig(devEnv as WebEnv)
    expect(config.addresses.arcpadRouter).toBeNull()
    expect(config.addresses.launchFactory).toBe(getAddress(BASE_ENV.NEXT_PUBLIC_ARCPAD_FACTORY!))
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
