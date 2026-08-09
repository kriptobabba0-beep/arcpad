/**
 * ==========================================================================
 *  ONE HISTORY, TWO VENUES -- AND HOW A ROW SAYS WHICH ONE IT CAME FROM.
 * ==========================================================================
 *
 * `trades.source` is `'curve' | 'pool'` and has been in the schema since
 * migration 003; the indexer began writing `'pool'` at commit `89acc4f`. The
 * price seam across graduation was measured at 2.2e-10, so the two venues are
 * meant to read as ONE history and the list and the chart must not restart.
 *
 * ============ BUT `listTrades` DOES NOT SELECT `source` ============
 *
 * Verified by reading `packages/db/src/queries.ts`: the `SELECT` behind
 * `listTrades` names thirteen columns and `source` is not one of them, so
 * `TradeRow` -- which `web/components/read/types.ts` re-exports UNCHANGED from
 * `@arcpad/db` -- has no such field. Adding it is a four-line change in
 * `packages/`, which belongs to another track, and a fixture edit here. Until
 * it lands, a `source: 'curve'` written into `web/test/fixtures/readModel.ts`
 * would be an EXCESS PROPERTY on a `TradeRow` literal and would fail
 * `test/typecheck.test.ts`, which runs `tsc` for real.
 *
 * ============ SO THE VENUE IS DERIVED, AND THE DERIVATION IS EXACT ============
 *
 * `TokenOverview.graduatedSeq` is the `event_seq` of the token's `Graduated`
 * log, and it is already on the row. A trade is a POOL trade exactly when its
 * `event_seq` is greater than that:
 *
 *   - No curve trade can follow it. `graduate()` reverts `NotComplete()` unless
 *     the curve is complete, and all three curve entrypoints revert
 *     `CurveComplete()` once it is. `graduated => complete` always holds.
 *   - No pool trade can precede it. `ArcpadLocker.graduate` initialises the
 *     pool and seeds it INSIDE the same transaction, after the curve's
 *     `Graduated` log, so the pool's first possible swap has a strictly larger
 *     `(block, logIndex)` -- and `event_seq = block << 20 | logIndex` preserves
 *     that order.
 *
 * This is therefore not an approximation waiting for the real field; it is the
 * same partition computed from a different column. What `source` will add is
 * INDEPENDENCE: today a wrong `graduatedSeq` mislabels the history, whereas the
 * column is written per row by the decoder that produced it.
 *
 * `AWAITING_SOURCE_COLUMN` below is the exemption in this repository's
 * `AWAITING_FIXTURE` shape: `test/pool/venue.test.ts` asserts the column is
 * still absent from `listTrades`, so the day another track adds it the test
 * goes RED and forces this file to switch to the authoritative field.
 */

export type Venue = 'curve' | 'pool'

/**
 * The exemption, in the shape this repository uses for a claim that must expire.
 *
 * `column` names what is missing; `owner` names who can add it; `whenItLands`
 * names what must change here. The test that reads it fails as soon as the
 * statement stops being true.
 */
export const AWAITING_SOURCE_COLUMN = {
  column: 'trades.source',
  query: 'listTrades',
  owner: 'packages/db',
  reason:
    'listTrades does not select `source`, so `TradeRow` cannot carry it and a fixture that ' +
    'declared it would fail the tsc gate. The venue is derived from `graduatedSeq` meanwhile, ' +
    'which partitions the same history exactly.',
  whenItLands:
    'add `source` to web/test/fixtures/readModel.ts, then take `venueOf` from the row instead ' +
    'of from `graduatedSeq`, and delete this constant.',
} as const

/**
 * Which venue a row came from.
 *
 * `graduatedSeq === null` means the token has not graduated, so every row is a
 * curve row -- which is the state of every token on every chain today.
 */
export function venueOf(row: { readonly eventSeq: bigint }, graduatedSeq: bigint | null): Venue {
  if (graduatedSeq === null) return 'curve'
  return row.eventSeq > graduatedSeq ? 'pool' : 'curve'
}

/** Split a descending list at the seam, preserving order within each half. */
export function partitionByVenue<T extends { readonly eventSeq: bigint }>(
  rows: readonly T[],
  graduatedSeq: bigint | null,
): { readonly curve: readonly T[]; readonly pool: readonly T[] } {
  const curve: T[] = []
  const pool: T[] = []
  for (const row of rows) (venueOf(row, graduatedSeq) === 'pool' ? pool : curve).push(row)
  return { curve, pool }
}

export const VENUE_LABEL: Readonly<Record<Venue, string>> = {
  curve: 'Curve',
  pool: 'Pool',
}

/**
 * The venue's noun, for the fee sentence.
 *
 * `TradesTable` said "to the curve" / "from the curve" on every row. On a pool
 * row that sentence names a contract the trade never touched -- and the fee it
 * describes was taken by `ArcpadHook`, not by a curve.
 */
export const VENUE_NOUN: Readonly<Record<Venue, string>> = {
  curve: 'the curve',
  pool: 'the pool',
}
