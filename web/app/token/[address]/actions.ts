'use server'

import type { ChatMessageRow, LimitOrderRow } from '@arcpad/db'
import { isAddress } from 'viem'
import type { HolderRow, TradeRow } from '@/components/read/types'
import {
  CHAT_PAGE_SIZE,
  type Page,
  type ReadResult,
  ORDERS_PAGE_SIZE,
  readChat,
  readHolders,
  readOrders,
  readTrades,
  TABLE_PAGE_SIZE,
} from '@/lib/read'

/**
 * "LOAD MORE" -- THE HALF THAT WAS NEVER WRITTEN.
 *
 * `tableShell.tsx:181` said *"Task 7 indiginde bu bir server action olur"*.
 * Task 7 landed; the action did not. The consequence was not a missing feature
 * but an INVISIBLE cap: `<TableTabs>` was rendered without `loadMoreTrades` or
 * `loadMoreHolders`, `useKeysetRows` therefore reported `canLoadMore: false`,
 * and `LoadMoreFooter` correctly drew nothing. So the token page showed the 25
 * newest trades and the 25 largest holders and there was NOTHING ON SCREEN
 * saying more existed -- a token with four thousand trades and one with
 * twenty-five rendered identically. `readTrades` had been returning a real
 * `nextCursor` the whole time, into a prop nobody passed.
 *
 * WHY A SERVER ACTION RATHER THAN A ROUTE HANDLER: `web/lib/read.ts` reaches
 * `pg`, so it cannot be imported by a client component at all. The client needs
 * ONE thing -- the next page of an already-rendered table -- and a route
 * handler would mean inventing a URL, a JSON shape, and a second decoder for
 * `bigint` and `Date`. React's Flight serialisation carries both natively, so
 * the action returns the SAME `ReadResult<Page<T>>` the server component
 * already renders. One shape, one decoder, no drift.
 *
 * ===========================================================================
 *  EVERY ARGUMENT IS RE-VALIDATED HERE. A SERVER ACTION IS A PUBLIC ENDPOINT.
 * ===========================================================================
 *
 * `token` arrives bound (`loadMoreTrades.bind(null, address)`), and Next
 * encrypts bound arguments -- but "encrypted" is a property of the transport,
 * not a proof about the value, and the cursor is not bound at all: it is
 * whatever the caller sends. So:
 *
 *   - the address is checked and lower-cased here, not trusted from the bind;
 *   - the cursor is handed to `parseCursor`/`parseHolderCursor`, which treat a
 *     malformed value as the FIRST PAGE rather than throwing (both queries are
 *     parameterised, so a hostile cursor is a wrong page at worst, never SQL);
 *   - THE LIMIT IS NOT A PARAMETER. It is `TABLE_PAGE_SIZE`. Accepting a limit
 *     would let one request ask for the 200-row clamp repeatedly, and no screen
 *     in this product wants a different number.
 *
 * A bad address answers `notFound` rather than throwing: an unhandled throw in
 * an action reaches the client as a generic digest, and `useKeysetRows` already
 * renders a failed page as "the rows above are still current".
 */

function rejected<T>(): ReadResult<Page<T>> {
  return { ok: false, reason: 'notFound', indexer: null }
}

/**
 * `viem`'s check, NON-STRICT, then lower-cased.
 *
 * Non-strict on purpose: `strict: true` demands an EIP-55 checksum, and the
 * address this is bound to comes out of Postgres, where the schema's
 * `^0x[0-9a-f]{40}$` CHECK guarantees it is lower-case -- i.e. NOT checksummed.
 * A strict check would reject every legitimate call.
 */
function normalise(token: string): string | null {
  return isAddress(token, { strict: false }) ? token.toLowerCase() : null
}

/** The next page of trades, newest-first, keyed on `event_seq`. */
export async function loadMoreTrades(
  token: string,
  cursor: string,
): Promise<ReadResult<Page<TradeRow>>> {
  const address = normalise(token)
  if (address === null) return rejected<TradeRow>()
  return readTrades(address, { cursor, limit: TABLE_PAGE_SIZE })
}

/**
 * The next page of chat, newest-first, keyed on `message_seq`.
 *
 * A SERVER ACTION AND NOT A `GET /api/chat`, and the distinction is the one
 * §6.3 draws: reads never get an API route. The write side of chat DOES have
 * one (`app/api/chat/route.ts`) and it carries no `GET` -- so the two
 * directions stay on the two paths the spec assigns them, on the same screen.
 *
 * Same re-validation as the other two: the address is checked here rather than
 * trusted from the bind, the cursor goes through `parseChatCursor` (a
 * malformed one is the first page, never SQL), and THE LIMIT IS NOT A
 * PARAMETER.
 */
export async function loadMoreChat(
  token: string,
  cursor: string,
): Promise<ReadResult<Page<ChatMessageRow>>> {
  const address = normalise(token)
  if (address === null) return rejected<ChatMessageRow>()
  return readChat(address, { cursor, limit: CHAT_PAGE_SIZE })
}

/** The next page of holders, largest-first, keyed on `(balance_tok, holder)`. */
export async function loadMoreHolders(
  token: string,
  cursor: string,
): Promise<ReadResult<Page<HolderRow>>> {
  const address = normalise(token)
  if (address === null) return rejected<HolderRow>()
  return readHolders(address, { cursor, limit: TABLE_PAGE_SIZE })
}

/**
 * ============ BIR SAHIBIN EMIRLERI ============
 *
 * NEDEN BIR SERVER COMPONENT'TE DEGIL DE BURADA: chat butun token'in
 * mesajlarini gosterir ve sunucu onlari sayfayi cizerken okuyabilir. Bir emir
 * BIR SAHIBE aittir ve sunucu, sayfayi cizdigi anda hangi cuzdanin BAGLI
 * OLDUGUNU BILMEZ -- baglanti tarayicida yasar. Yani okuma ancak cuzdan
 * baglandiktan SONRA, istemciden tetiklenebilir.
 *
 * BUTUN TOKEN'IN EMIRLERINI CIZIP ISTEMCIDE SUZMEK SECILMEDI ve gerekcesi
 * gizlilik: o secim her ziyaretciye HERKESIN acik emirlerini gonderirdi.
 * Burada yalnizca sorulan adresin satirlari doner.
 *
 * ARGUMANLAR BURADA YENIDEN DOGRULANIR -- bir server action HERKESE ACIK bir
 * uctur. `owner` bagli DEGILDIR (istemci onu her cagriya kendi koyar), yani
 * onun kontrolu bir formalite degil.
 *
 * LIMIT BIR PARAMETRE DEGILDIR.
 */
export async function loadOrders(
  token: string,
  owner: string,
  cursor: string | null,
): Promise<ReadResult<Page<LimitOrderRow>>> {
  const address = normalise(token)
  const ownerAddress = normalise(owner)
  if (address === null || ownerAddress === null) return rejected<LimitOrderRow>()
  return readOrders(address, ownerAddress, { cursor, limit: ORDERS_PAGE_SIZE })
}
