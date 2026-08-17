import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  partitionByVenue,
  VENUE_NOUN,
  venueDisagreements,
  venueFromGraduationSeq,
  venueOf,
} from '@/components/token/venue'
import {
  CURVE_CLOSE,
  CURVE_EARLY,
  GRADUATED_SEQ,
  MIXED_HISTORY,
  POOL_FIRST,
  POOL_SECOND,
} from './fixtures'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

/**
 * ==========================================================================
 *  THE COLUMN LANDED, AND THAT CHANGED WHICH FACT DECIDES.
 * ==========================================================================
 *
 * This file used to hold an `AWAITING_FIXTURE` exemption asserting that
 * `listTrades` did NOT select `source`, so that the day it did would be loud.
 * That day is today: `packages/db/src/queries.ts` selects it, `TradeRow`
 * requires it, and `venueOf` reads it. The exemption is gone -- replaced, not
 * deleted, by the two things below.
 */

describe('the venue comes from the ROW, and the query really provides it', () => {
  /**
   * THE REPLACEMENT FOR THE EXEMPTION, POINTING THE OTHER WAY.
   *
   * The old gate went red when the column arrived. This one goes red if it
   * ever leaves: `venueOf` has no fallback, so a `listTrades` that stopped
   * selecting `source` would hand every component `undefined` and every row
   * would be captioned by a value that is not a venue. The type would catch it
   * inside this repository -- this catches it if the row ever crosses a JSON
   * boundary, and it names what to do.
   */
  it('listTrades SELECTs `source`, which is what makes venueOf total', () => {
    const queries = readFileSync(join(REPO_ROOT, 'packages', 'db', 'src', 'queries.ts'), 'utf8')
    const start = queries.indexOf('export async function listTrades')
    expect(start, 'listTrades not found -- this gate cannot run').toBeGreaterThan(-1)
    const body = queries.slice(start, queries.indexOf('function asTradeSource', start))
    expect(
      /\bt\.source\b/.test(body),
      'listTrades no longer selects `source`. `venueOf` reads the row and has no fallback, so ' +
        'every trade row would arrive without a venue. Restore the column in the SELECT.',
    ).toBe(true)

    // ANTI-VACUITY: the slice really is the query, and the column really is
    // declared on the table -- so this is a fact about the SELECT rather than
    // about a string that happens to appear in the file.
    expect(body).toContain('FROM trades t')
    expect(body).toContain('t.quote_amount_wei')
    const migration = readFileSync(
      join(REPO_ROOT, 'packages', 'db', 'migrations', '003_trades_and_curve_state.sql'),
      'utf8',
    )
    expect(migration).toMatch(/source\s+text\s+NOT NULL\s+DEFAULT 'curve'/)
    expect(migration).toMatch(/CHECK \(source IN \('curve','pool'\)\)/)
  })

  it('a row states its own venue -- both values, from the fixtures', () => {
    expect(venueOf(CURVE_CLOSE)).toBe('curve')
    expect(venueOf(POOL_FIRST)).toBe('pool')
  })

  it('the partition preserves order within each half', () => {
    const { curve, pool } = partitionByVenue(MIXED_HISTORY)
    expect(pool.map((r) => r.eventSeq)).toEqual([POOL_SECOND.eventSeq, POOL_FIRST.eventSeq])
    expect(curve.map((r) => r.eventSeq)).toEqual([CURVE_CLOSE.eventSeq, CURVE_EARLY.eventSeq])
    expect(curve.length + pool.length).toBe(MIXED_HISTORY.length)
  })

  it('the fee sentence’s noun follows the venue', () => {
    expect(VENUE_NOUN.curve).toBe('the curve')
    expect(VENUE_NOUN.pool).toBe('the pool')
  })
})

/**
 * ==========================================================================
 *  THE DIFFERENTIAL: TWO FACTS, ONE ANSWER.
 * ==========================================================================
 *
 * `source` and `eventSeq > graduatedSeq` are two independent ways to answer
 * the same question and they must agree. Production uses only the first (see
 * `venue.ts` for why keeping both in the render path was rejected), so the
 * agreement is what proves nothing was lost by dropping the second.
 *
 * THE EXECUTED HALF OF THIS CLAIM IS NOT HERE. `packages/db/test/pool-trades
 * .test.ts` runs the same comparison over rows a real Postgres produced from a
 * real curve history, a real `Graduated` and real pool swaps -- because that is
 * the only layer where both facts exist together with real data. What runs here
 * is the comparison over the fixtures this package draws, plus the control that
 * makes it non-vacuous.
 */
describe('the row’s venue and the graduatedSeq derivation never disagree', () => {
  it('over every fixture row, both answers are identical', () => {
    for (const row of MIXED_HISTORY) {
      expect(venueFromGraduationSeq(row, GRADUATED_SEQ), `row ${row.eventSeq}`).toBe(venueOf(row))
    }
    expect(venueDisagreements(MIXED_HISTORY, GRADUATED_SEQ)).toEqual([])
  })

  /**
   * CONTROL: THE COMPARISON CAN ACTUALLY FAIL.
   *
   * Without this, `venueDisagreements` could return `[]` unconditionally and
   * the assertion above would pass while measuring nothing. The row below is
   * impossible on chain -- a curve trade after graduation -- and the comparison
   * must see it.
   */
  it('CONTROL: a chain-impossible row IS reported as a disagreement', () => {
    const impossible = { ...POOL_FIRST, source: 'curve' as const }
    const found = venueDisagreements([...MIXED_HISTORY, impossible], GRADUATED_SEQ)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ declared: 'curve', derived: 'pool' })
  })

  /**
   * THE BOUNDARY IS STRICT, and that is the half a `>=` would break.
   *
   * `graduate()` emits `Graduated` and initialises the pool in ONE transaction,
   * so the pool's first swap has a strictly larger log index. A `>=` would
   * label the last curve trade as a pool trade whenever the two shared a
   * sequence -- and with the derivation no longer in production, this test is
   * the only thing that still measures it.
   */
  it('the derivation’s boundary is strict, and an ungraduated token has no pool rows', () => {
    expect(venueFromGraduationSeq({ eventSeq: GRADUATED_SEQ }, GRADUATED_SEQ)).toBe('curve')
    expect(venueFromGraduationSeq({ eventSeq: GRADUATED_SEQ + 1n }, GRADUATED_SEQ)).toBe('pool')
    for (const row of MIXED_HISTORY) expect(venueFromGraduationSeq(row, null)).toBe('curve')
  })

  /**
   * AND THE DIFFERENTIAL REFERENCE IS NOT WIRED INTO THE PRODUCT.
   *
   * The whole argument for deleting the derivation from the render path is that
   * two candidate truths in one render means the render silently picks one. A
   * component that quietly started calling it again would restore exactly that,
   * with every test above still green -- so the absence is asserted, in source,
   * the same way `test/pool/units.test.ts` asserts the 1e12 seam.
   */
  it('no component calls the derivation -- one truth in the render path', () => {
    const dirs = ['components', 'app', 'lib', 'hooks']
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSyncSafe(dir)) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        // The definition itself lives in `venue.ts`; everything else is a call.
        if (full.endsWith(join('components', 'token', 'venue.ts'))) continue
        const text = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
        if (/venueFromGraduationSeq|venueDisagreements/.test(text)) offenders.push(full)
      }
    }
    for (const dir of dirs) walk(join(REPO_ROOT, 'web', dir))
    expect(offenders, 'the differential reference is being used in production code').toEqual([])

    // ANTI-VACUITY: the same scan DOES find `venueOf`, so the walk really is
    // reading these files and the regex really would match a call.
    const users: string[] = []
    const walkUsers = (dir: string): void => {
      for (const entry of readdirSyncSafe(dir)) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walkUsers(full)
        else if (/\.(ts|tsx)$/.test(entry.name) && /\bvenueOf\(/.test(readFileSync(full, 'utf8'))) {
          users.push(full)
        }
      }
    }
    for (const dir of dirs) walkUsers(join(REPO_ROOT, 'web', dir))
    expect(users.length).toBeGreaterThanOrEqual(3)
  })
})

function readdirSyncSafe(dir: string): { name: string; isDirectory(): boolean }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== 'node_modules')
}

/**
 * ==========================================================================
 *  THE DEFECT THIS PARTITION EXISTS FOR: pool rows on the bonding curve axis.
 * ==========================================================================
 */
describe('pool rows are unplottable on the bonding curve’s x axis', () => {
  /**
   * `CurveChart`'s x is `S - realTokenReserves`, tokens sold ON THE CURVE. A
   * pool row's `real_token_reserves_tok` is the POOL's implied reserve, so the
   * realised line would jump BACKWARDS at graduation and then wander along a
   * curve the trade never touched -- the shape that file's own comment forbids
   * as impossible to realise.
   */
  it('the jump is real and its size is measurable', () => {
    const S = 793_100_000n * 10n ** 18n
    const curveX = S - CURVE_CLOSE.realTokenReservesTok
    const poolX = S - POOL_FIRST.realTokenReservesTok
    // The curve ends at 100% of the sale supply...
    expect(curveX).toBe(S)
    // ...and the pool row would be drawn at ~74%, i.e. BACKWARDS.
    expect(poolX).toBeLessThan(curveX)
    expect(Number((poolX * 1000n) / S) / 10).toBeCloseTo(73.9, 1)
  })
})
