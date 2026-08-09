import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AWAITING_SOURCE_COLUMN,
  partitionByVenue,
  VENUE_NOUN,
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

describe('AWAITING_FIXTURE — trades.source is not exposed yet', () => {
  /**
   * `packages/db`'s `listTrades` selects thirteen columns and `source` is not
   * one of them, so `TradeRow` cannot carry it and a fixture that declared it
   * would fail the `tsc` gate. The venue is derived from `graduatedSeq`
   * meanwhile -- exactly, see below.
   *
   * THIS TEST GOES RED THE DAY THE COLUMN LANDS. That is its job: on that day
   * `venueOf` must take the venue from the row instead of from a boundary, the
   * fixture must gain `source`, and this exemption must be deleted.
   */
  it('the SELECT behind listTrades still does not name `source`', () => {
    const queries = readFileSync(join(REPO_ROOT, 'packages', 'db', 'src', 'queries.ts'), 'utf8')
    const start = queries.indexOf('export async function listTrades')
    expect(start, 'listTrades not found -- this gate cannot run').toBeGreaterThan(-1)
    const body = queries.slice(start, queries.indexOf('export interface HolderRow', start))
    expect(
      /\bt\.source\b/.test(body),
      `${AWAITING_SOURCE_COLUMN.column} is now selected by ${AWAITING_SOURCE_COLUMN.query}. ` +
        AWAITING_SOURCE_COLUMN.whenItLands,
    ).toBe(false)

    // ANTI-VACUITY: the slice really is the query, and the column really does
    // exist on the table -- so "not selected" is a fact about the SELECT rather
    // than about the schema.
    expect(body).toContain('FROM trades t')
    expect(body).toContain('t.quote_amount_wei')
    const migration = readFileSync(
      join(REPO_ROOT, 'packages', 'db', 'migrations', '003_trades_and_curve_state.sql'),
      'utf8',
    )
    expect(migration).toMatch(/source\s+text\s+NOT NULL\s+DEFAULT 'curve'/)
  })
})

describe('the venue is derived from graduatedSeq, and the partition is exact', () => {
  it('a row after graduation is a pool row; a row before it is not', () => {
    expect(venueOf(CURVE_CLOSE, GRADUATED_SEQ)).toBe('curve')
    expect(venueOf(POOL_FIRST, GRADUATED_SEQ)).toBe('pool')
  })

  it('the boundary is STRICT: the graduation log itself is not a trade', () => {
    // `graduate()` emits `Graduated` and initialises the pool in ONE
    // transaction, so the pool's first swap has a strictly larger log index. A
    // `>=` here would label the last curve trade as a pool trade whenever the
    // two shared a sequence.
    expect(venueOf({ eventSeq: GRADUATED_SEQ }, GRADUATED_SEQ)).toBe('curve')
    expect(venueOf({ eventSeq: GRADUATED_SEQ + 1n }, GRADUATED_SEQ)).toBe('pool')
  })

  it('an ungraduated token has NO pool rows -- which is every token today', () => {
    for (const row of MIXED_HISTORY) expect(venueOf(row, null)).toBe('curve')
  })

  it('the partition preserves order within each half', () => {
    const { curve, pool } = partitionByVenue(MIXED_HISTORY, GRADUATED_SEQ)
    expect(pool.map((r) => r.eventSeq)).toEqual([POOL_SECOND.eventSeq, POOL_FIRST.eventSeq])
    expect(curve.map((r) => r.eventSeq)).toEqual([CURVE_CLOSE.eventSeq, CURVE_EARLY.eventSeq])
    expect(curve.length + pool.length).toBe(MIXED_HISTORY.length)
  })

  it('the fee sentence’s noun follows the venue', () => {
    expect(VENUE_NOUN.curve).toBe('the curve')
    expect(VENUE_NOUN.pool).toBe('the pool')
  })
})

describe('THE DEFECT: pool rows are unplottable on the bonding curve’s x axis', () => {
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
