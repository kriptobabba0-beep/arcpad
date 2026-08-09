import type { TradeSource } from '@/components/read/types'

/**
 * ==========================================================================
 *  ONE HISTORY, TWO VENUES -- AND THE ROW NOW SAYS WHICH ONE IT CAME FROM.
 * ==========================================================================
 *
 * `trades.source` is `'curve' | 'pool'` and has been in the schema since
 * migration 003; the indexer began writing `'pool'` at commit `89acc4f`. What
 * was missing was the READ: `listTrades` selected thirteen columns and `source`
 * was not one of them, so `TradeRow` could not carry it and this file derived
 * the venue from `TokenOverview.graduatedSeq` instead.
 *
 * `listTrades` now selects it. So the venue is TAKEN FROM THE ROW, and the
 * derivation is gone from every production path.
 *
 * ============ WHY THE DERIVATION IS GONE, RATHER THAN KEPT ALONGSIDE ============
 *
 * Both answers are correct, and that is exactly the problem: two candidate
 * truths in one render path means the render silently picks one, and this
 * repository's record is that a duplicated fact drifts and the copy that drifts
 * is the one nobody is looking at. So there is ONE answer in production, and it
 * is the independent one:
 *
 *   `source`            written PER ROW by the decoder that produced it.
 *   `eventSeq > graduatedSeq`  derived from ONE number per token -- so a single
 *                       wrong `graduatedSeq` mislabels the WHOLE history, and a
 *                       call site that forgets to pass it mislabels it silently.
 *
 * The second point is the concrete win and it closes an instance of this
 * package's number-one failure mode: the venue used to be a PROP that four call
 * sites had to remember to pass (`CurveChart`, `PriceHistoryChart`,
 * `TableTabs`, `TradesTable`), and a mutant that dropped it at ONE of them
 * survived the whole suite until a test was written for that one hop. A field
 * that travels on the row cannot be forgotten at a call site at all.
 *
 * ============ AND SOMETHING STILL ASSERTS THE TWO AGREE ============
 *
 * Removing the derivation from production does not remove the obligation to
 * prove it agrees -- it moves it to the layer where BOTH facts exist together
 * with real data. `packages/db/test/pool-trades.test.ts`
 * ("`source` ile `graduated_seq` turetmesi AYNI bolumlemeyi verir") runs a real
 * curve history + a real `Graduated` + real pool swaps through a real Postgres
 * and asserts, row by row, that `source === 'pool'` exactly when
 * `event_seq > graduated_seq` -- with a control that inserts a
 * chain-impossible row and proves the comparison can fail.
 *
 * `venueFromGraduationSeq` below is that derivation, kept as the DIFFERENTIAL
 * REFERENCE (the same shape `test/pool/plan.test.ts` uses against the shared
 * slippage helpers) and deliberately called by no component. Why it is exact:
 *
 *   - No curve trade can follow graduation. `graduate()` reverts `NotComplete()`
 *     unless the curve is complete, and all three curve entrypoints revert
 *     `CurveComplete()` once it is. `graduated => complete` always holds.
 *   - No pool trade can precede it. `ArcpadLocker.graduate` initialises and
 *     seeds the pool INSIDE the same transaction, after the curve's `Graduated`
 *     log, so the pool's first possible swap has a strictly larger
 *     `(block, logIndex)` -- and `event_seq = block << 20 | logIndex` preserves
 *     that order.
 */

export type Venue = TradeSource

/** Every row that can be classified. `TradeRow` satisfies it; so does a literal. */
export type VenueRow = { readonly source: Venue }

/**
 * Which venue a row came from: the row's own answer.
 *
 * There is no fallback and no default. A row that reaches the UI without a
 * `source` is a type error, not a curve trade -- guessing here is how a pool
 * row would end up captioned "to the curve" on a screen nobody re-checked.
 */
export function venueOf(row: VenueRow): Venue {
  return row.source
}

/**
 * THE DIFFERENTIAL REFERENCE -- not used by any component, on purpose.
 *
 * See the header: this is the second, independent way to answer the same
 * question, and `test/pool/venue.test.ts` asserts the two never disagree over
 * the fixtures while `packages/db` asserts it over real rows. Keeping it
 * exported and named makes the claim checkable; calling it from a component
 * would put two truths back into one render.
 *
 * `graduatedSeq === null` means the token has not graduated, so every row is a
 * curve row -- which is the state of every token on every chain today.
 */
export function venueFromGraduationSeq(
  row: { readonly eventSeq: bigint },
  graduatedSeq: bigint | null,
): Venue {
  if (graduatedSeq === null) return 'curve'
  return row.eventSeq > graduatedSeq ? 'pool' : 'curve'
}

/**
 * Rows whose own `source` disagrees with the derivation. EMPTY is the invariant.
 *
 * Exists so the agreement is a value a test can assert on rather than a loop
 * each test rewrites -- and so the same comparison shape is used here and in
 * `packages/db`, where it runs against real rows.
 */
export function venueDisagreements<T extends VenueRow & { readonly eventSeq: bigint }>(
  rows: readonly T[],
  graduatedSeq: bigint | null,
): readonly { readonly eventSeq: bigint; readonly declared: Venue; readonly derived: Venue }[] {
  return rows
    .map((row) => ({
      eventSeq: row.eventSeq,
      declared: venueOf(row),
      derived: venueFromGraduationSeq(row, graduatedSeq),
    }))
    .filter((r) => r.declared !== r.derived)
}

/** Split a descending list by venue, preserving order within each half. */
export function partitionByVenue<T extends VenueRow>(
  rows: readonly T[],
): { readonly curve: readonly T[]; readonly pool: readonly T[] } {
  const curve: T[] = []
  const pool: T[] = []
  for (const row of rows) (venueOf(row) === 'pool' ? pool : curve).push(row)
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
