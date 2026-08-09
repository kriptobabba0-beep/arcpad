import type { TradeRow } from '@/components/read/types'
import { SMOKE } from '../fixtures/readModel'

/**
 * ============ THE SEAM, AS TWO ROWS ============
 *
 * These are the two rows that sit either side of graduation, and their numbers
 * are the ones the indexer MEASURED rather than invented:
 *
 *   from the curve   vQ/vT                     = 58_783_256_052 wei/token
 *   from the pool    impliedReserves(L, sqrtP) = 58_783_256_039 wei/token
 *   difference 13 wei, relative 2.2e-10
 *
 * The curve side is the live smoke curve's closing state, which
 * `test/fixtures/readModel.ts` already pins (`SMOKE.priceWeiPerTok`). The pool
 * side is the virtual pair that produces the measured pool price EXACTLY, so
 * the seam in these fixtures is the seam that was measured -- not an arbitrary
 * pair of numbers that happen to be close.
 *
 * EVERY ROW CARRIES `source`. `listTrades` selects it now, so `TradeRow`
 * requires it and a fixture that omitted it would not compile -- which is the
 * point: the venue is a fact on the row, not something a call site passes.
 *
 * `GRADUATED_SEQ` IS STILL HERE, and it is no longer what decides the venue.
 * It is the input to `venueFromGraduationSeq`, the differential reference in
 * `components/token/venue.ts`, so that `venue.test.ts` can assert the row's own
 * answer and the derived one never disagree over exactly these rows.
 */

/** `event_seq = block << 20 | logIndex`. Graduation lands in block 60. */
export const GRADUATED_SEQ = (60n << 20n) | 3n

const CLOSING_VT = 279_900_000_000_000_000_000_000_000n

const BASE: TradeRow = {
  eventSeq: 0n,
  txHash: `0x${'ab'.repeat(32)}`,
  blockTime: new Date('2026-08-09T12:00:00.000Z'),
  trader: '0x00000000000000000000000000000000000000cc',
  isBuy: true,
  tokenAmountTok: 1_000_000_000_000_000_000_000n,
  quoteAmountWei: 1_000_000_000_000_000_000n,
  protocolFeeWei: 9_500_000_000_000_000n,
  creatorFeeWei: 3_000_000_000_000_000n,
  virtualTokenReservesTok: CLOSING_VT,
  virtualQuoteReservesWei: SMOKE.virtualQuoteReservesWei,
  realTokenReservesTok: 0n,
  realQuoteReservesWei: SMOKE.realQuoteReservesWei,
  isDev: false,
  source: 'curve',
}

/** An ordinary curve trade, well before graduation. Block 40. */
export const CURVE_EARLY: TradeRow = {
  ...BASE,
  eventSeq: (40n << 20n) | 1n,
  virtualTokenReservesTok: 872_276_046_879_238_259_473_675_895n,
  virtualQuoteReservesWei: 5_279_654_320_987_654_320n,
  realTokenReservesTok: 592_376_046_879_238_259_473_675_895n,
  realQuoteReservesWei: 987_654_320_987_654_320n,
}

/**
 * THE LAST CURVE TRADE -- the one that completed the sale. Block 60, log 1,
 * i.e. STRICTLY BEFORE the `Graduated` log in the same transaction.
 *
 * `vQ/vT` = 58_783_256_052 wei/token, which is `SMOKE.priceWeiPerTok`.
 */
export const CURVE_CLOSE: TradeRow = {
  ...BASE,
  eventSeq: (60n << 20n) | 1n,
  virtualQuoteReservesWei: 16_453_433_369_060_378_714n,
  virtualTokenReservesTok: CLOSING_VT,
}

/**
 * THE POOL'S FIRST SWAP. Block 61, i.e. after graduation.
 *
 * `vQ` is chosen so that `vQ * 1e18 / vT` is EXACTLY 58_783_256_039 -- the
 * price the indexer derived from the pool's `sqrtPriceX96` and `liquidity` at
 * the opening. The 13-wei gap against `CURVE_CLOSE` is the measured seam.
 *
 * Its `realTokenReservesTok` is the POOL's implied reserve (the seeded
 * position), which is what makes it unplottable on the bonding curve's x axis:
 * `saleSupply - poolSeedSupply` lands at ~74% while the curve is at 100%.
 */
export const POOL_FIRST: TradeRow = {
  ...BASE,
  eventSeq: (61n << 20n) | 0n,
  source: 'pool',
  isBuy: true,
  virtualQuoteReservesWei: 16_453_433_365_316_100_000n,
  virtualTokenReservesTok: CLOSING_VT,
  realTokenReservesTok: 206_886_011_183_597_390_493_942_218n,
  realQuoteReservesWei: 12_161_433_000_000_000_000n,
}

/** A second pool swap, one block later and cheaper (a sell). */
export const POOL_SECOND: TradeRow = {
  ...POOL_FIRST,
  eventSeq: (62n << 20n) | 0n,
  isBuy: false,
  virtualQuoteReservesWei: 16_000_000_000_000_000_000n,
  realTokenReservesTok: 210_000_000_000_000_000_000_000_000n,
}

/** Newest first, exactly as `listTrades` returns them. */
export const MIXED_HISTORY: readonly TradeRow[] = [
  POOL_SECOND,
  POOL_FIRST,
  CURVE_CLOSE,
  CURVE_EARLY,
]
