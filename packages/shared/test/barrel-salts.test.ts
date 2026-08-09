import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as barrel from '../src/index'

/**
 * EVERY SALT `addresses.ts` DEFINES MUST LEAVE THE BARREL.
 *
 * MEASURED 2026-08-09, and the failure mode is the dangerous kind: the barrel
 * re-exported `ESCROW_SALT` and `FACTORY_SALT` and **silently omitted the other
 * five** (`FEE_SCHEDULE_SALT`, `POOL_MANAGER_SALT`, `ARCPAD_HOOK_SALT`,
 * `LOCKER_SALT`, `ROUTER_SALT`). A consumer reaching for one of those through
 * `@arcpad/shared` got `undefined` -- and an `undefined` salt does not throw in
 * `getCreate2Address`, it DERIVES A DIFFERENT ADDRESS. The whole point of the
 * address book is that no address is ever a literal; a salt that quietly
 * becomes `undefined` reintroduces exactly the class the book exists to close.
 *
 * ENUMERATED FROM SOURCE, NOT LISTED HERE. A hand-written list would have to be
 * updated by the same person who forgot the barrel, which is no gate at all --
 * this repo's named failure mode is that the gap lives in the SELECTION. The
 * next salt someone adds is covered by this test on the day they add it.
 */
describe('the barrel re-exports every salt the address module defines', () => {
  it('has no salt that stops at addresses.ts', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'addresses.ts'), 'utf8')
    const defined = [...src.matchAll(/^export const (\w*SALT)\b/gm)].map((m) => m[1] as string)

    // NON-VACUITY: if the regex ever stops matching, this test would pass while
    // measuring nothing.
    expect(defined.length, 'no salts found in addresses.ts -- the scan is broken').toBeGreaterThan(
      4,
    )

    const missing = defined.filter(
      (name) => (barrel as Record<string, unknown>)[name] === undefined,
    )
    expect(
      missing,
      `salts defined but not re-exported from the barrel: ${missing.join(', ')}`,
    ).toEqual([])
  })
})
