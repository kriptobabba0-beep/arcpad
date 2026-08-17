'use server'

import type { PositionRow, TraderTradeRow } from '@arcpad/db'
import { isAddress } from 'viem'
import {
  type Page,
  type ReadResult,
  readPositions,
  readTraderTrades,
  TABLE_PAGE_SIZE,
} from '@/lib/read'

/**
 * "LOAD MORE" FOR THE PROFILE'S TWO TABLES.
 *
 * Same shape and same reasoning as `app/token/[address]/actions.ts`, and the
 * lesson it records applies here from the first commit rather than after a
 * defect: without these, `useKeysetRows` reports `canLoadMore: false`, the
 * footer draws nothing, and a wallet with four thousand trades renders
 * identically to one with twenty-five -- an INVISIBLE cap, because an absent
 * button looks exactly like a short list.
 *
 * EVERY ARGUMENT IS RE-VALIDATED. A server action is a public endpoint: the
 * bound address is checked here rather than trusted from the bind, the cursor
 * is handed to a parser that treats a malformed value as the first page (both
 * queries are parameterised, so a hostile cursor is a wrong page at worst), and
 * THE LIMIT IS NOT A PARAMETER -- it is `TABLE_PAGE_SIZE`, so no caller can ask
 * for the 200-row clamp on repeat.
 */

function rejected<T>(): ReadResult<Page<T>> {
  return { ok: false, reason: 'notFound', indexer: null }
}

/** Non-strict, then lower-cased: Postgres stores lower-case, i.e. NOT EIP-55. */
function normalise(address: string): string | null {
  return isAddress(address, { strict: false }) ? address.toLowerCase() : null
}

/** The next page of positions, largest-value first, keyed on `(valueWei, token)`. */
export async function loadMorePositions(
  holder: string,
  cursor: string,
): Promise<ReadResult<Page<PositionRow>>> {
  const address = normalise(holder)
  if (address === null) return rejected<PositionRow>()
  return readPositions(address, { cursor, limit: TABLE_PAGE_SIZE })
}

/** The next page of this wallet's trades, newest-first, keyed on `event_seq`. */
export async function loadMoreTraderTrades(
  trader: string,
  cursor: string,
): Promise<ReadResult<Page<TraderTradeRow>>> {
  const address = normalise(trader)
  if (address === null) return rejected<TraderTradeRow>()
  return readTraderTrades(address, { cursor, limit: TABLE_PAGE_SIZE })
}
