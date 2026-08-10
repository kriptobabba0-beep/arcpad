/**
 * SERVER ONLY -- BY CONVENTION TODAY, NOT BY THE `server-only` PACKAGE.
 *
 * That import is the mechanism that turns "a client component imported this"
 * into a BUILD error. It is not installed in this workspace, and installing it
 * would edit `pnpm-lock.yaml`, which every track shares.
 *
 * The guarantee is therefore weaker than it should be, and it is named here
 * rather than assumed: this module reaches `pg` through `@arcpad/db`, so a
 * client component that imports it fails at BUNDLE time on an unresolvable
 * `node:` builtin -- loudly, but with a worse message. Add `server-only` the
 * next time the lockfile is legitimately touched.
 */

import {
  type ChatMessageRow,
  type CreatorEarnings,
  encodeChatCursor,
  encodeHolderCursor,
  encodePositionCursor,
  type FreshIndexer,
  getCreatorEarnings,
  getIndexerStatus,
  getProtocolStats,
  getTokenOverview,
  type HolderRow,
  type IndexerStatus,
  listChatMessages,
  listHolders,
  listLaunchesByCreator,
  listPositionsByHolder,
  listProtocolDaily,
  listTokens,
  listTrades,
  listTradesByTrader,
  parseChatCursor,
  parseHolderCursor,
  parsePositionCursor,
  type PositionRow,
  type ProtocolDay,
  type ProtocolStats,
  type SearchSortKey,
  searchTokens,
  type SortKey,
  type StaleIndexer,
  type TokenOverview,
  type TraderTradeRow,
  type TradeRow,
} from '@arcpad/db'
import { getPool } from './db'

/**
 * THE READ LAYER: EVERY VALUE ARRIVES WITH ITS FRESHNESS, OR IT DOES NOT
 * ARRIVE.
 *
 * Absent data is obvious -- the page shows a box that says so. A REAL BUT
 * STALE price rendered as live is the state that costs a user money, because
 * nothing on screen distinguishes it from a correct one. So the danger is not
 * "the database is down", it is "the indexer is four minutes behind and the
 * page looks perfect".
 *
 * `ReadResult` is therefore shaped so that THE COMPILER WILL NOT LET YOU READ
 * THE VALUE WITHOUT LEARNING ITS FRESHNESS:
 *
 *   ok: true,  stale: false -> `data`
 *   ok: true,  stale: true  -> `staleData`     <- a DIFFERENT field name
 *   ok: false                -> no value at all
 *
 * `result.data` does not typecheck on an un-narrowed `ReadResult`, because the
 * stale branch has no `data`. A consumer who wants the value regardless has to
 * write `r.stale ? r.staleData : r.data`, which is an explicit acknowledgement
 * rather than an omission. `web/test/read-types.test.ts` runs `tsc` on both
 * shapes to keep it that way.
 *
 * A boolean `stale` sitting NEXT TO `data` was the obvious design and it does
 * not work: `const { data } = result` compiles, ignores the flag, and reads
 * exactly like correct code in review.
 */

export type ReadFailure = 'unavailable' | 'notFound'

/**
 * THE TWO BRANCHES CARRY DIFFERENT STATUSES, NOT THE SAME UNION TWICE.
 *
 * `FreshIndexer` cannot be constructed without a `blocksBehind: bigint` (see
 * `packages/db/src/queries.ts`), so `{ ok: true, stale: false }` is unreachable
 * for a reading whose distance from the chain head was never measured. That is
 * the half this contract was missing: before, `stale` answered "is the indexer
 * process writing", and a database 767 504 blocks behind compiled -- and
 * rendered -- as fresh.
 */
export type ReadResult<T> =
  | { readonly ok: true; readonly stale: false; readonly data: T; readonly indexer: FreshIndexer }
  | {
      readonly ok: true
      readonly stale: true
      readonly staleData: T
      readonly indexer: StaleIndexer
    }
  | {
      readonly ok: false
      readonly reason: ReadFailure
      /** `null` when the database could not be reached to ask. */
      readonly indexer: IndexerStatus | null
    }

export type Page<T> = {
  readonly rows: readonly T[]
  readonly nextCursor: string | null
}

/**
 * The fold. Every branch is REQUIRED, so a caller cannot forget the stale one
 * the way it can forget to check a boolean.
 */
export function fold<T, R>(
  result: ReadResult<T>,
  handlers: {
    fresh: (data: T, indexer: FreshIndexer) => R
    stale: (data: T, indexer: StaleIndexer) => R
    missing: (reason: ReadFailure, indexer: IndexerStatus | null) => R
  },
): R {
  if (!result.ok) return handlers.missing(result.reason, result.indexer)
  return result.stale
    ? handlers.stale(result.staleData, result.indexer)
    : handlers.fresh(result.data, result.indexer)
}

/** The value, with the acknowledgement made explicit at the call site. */
export function valueOf<T>(result: ReadResult<T>): T | undefined {
  return fold(result, {
    fresh: (data) => data,
    stale: (data) => data,
    missing: () => undefined,
  })
}

function ok<T>(data: T, indexer: IndexerStatus): ReadResult<T> {
  // The ONE place the split is made. `indexer.stale` is computed by
  // `packages/db` from `now() - updated_at` on the SERVER's clock, not ours.
  return indexer.stale
    ? { ok: true, stale: true, staleData: data, indexer }
    : { ok: true, stale: false, data, indexer }
}

/**
 * Turns a thrown query into `{ ok: false, reason: 'unavailable' }` and LOGS it.
 *
 * The reason this exists rather than letting the exception propagate: Next
 * would draw the error boundary and the WHOLE token page would disappear,
 * trade panel included -- and the trade panel reads its reserves from the
 * chain, so it had no reason to fail. Degrading the half that depends on
 * Postgres is the entire design.
 *
 * A missing row is `notFound`, not `unavailable`: a token that does not exist
 * and a database that cannot be reached call for different screens, and
 * collapsing them would show "try again later" for an address that will never
 * exist.
 */
export async function guard<T>(
  run: () => Promise<{ value: T; indexer: IndexerStatus }>,
  isMissing: (value: T) => boolean = () => false,
): Promise<ReadResult<T>> {
  try {
    const { value, indexer } = await run()
    if (isMissing(value)) return { ok: false, reason: 'notFound', indexer }
    return ok(value, indexer)
  } catch (error) {
    // One line, with the cause. Not per-row, not per-field: a real outage
    // should produce a readable log, not a flood that hides the first one.
    console.error('[read] query failed, degrading to unavailable:', error)
    return { ok: false, reason: 'unavailable', indexer: null }
  }
}

export type ListParams = {
  readonly sort: SortKey
  readonly ageDays: number | null
  readonly cursor: string | null
  readonly limit: number
}

export type PageParams = { readonly cursor: string | null; readonly limit: number }

/**
 * THE TOKEN PAGE'S PAGE SIZE, IN ONE PLACE.
 *
 * It lives here rather than in the page because the SERVER ACTION that fetches
 * page two has to ask for the same size, and the two sitting in different files
 * is how a "load more" quietly returns a differently-sized page.
 *
 * IT MUST STAY <= `packages/db`'s 200-row clamp. `listTrades`/`listHolders`
 * clamp `limit` to `[1, 200]`, and `nextCursorFrom` decides "there is more" by
 * `rows.length < limit` -- so a caller asking for 500 would get 200 rows, read
 * `200 < 500`, and report NO next page while 4,000 trades sat behind it. That
 * is the exact shape of the paging loss Explore already paid for, so the bound
 * is named here instead of being an unstated precondition.
 */
export const TABLE_PAGE_SIZE = 25

/** The cursor is the sort key of the LAST row, or null when the page is short. */
function nextCursorFrom<T>(
  rows: readonly T[],
  limit: number,
  key: (row: T) => bigint,
): string | null {
  if (rows.length < limit) return null
  const last = rows[rows.length - 1]
  return last === undefined ? null : key(last).toString()
}

function parseCursor(cursor: string | null): bigint | null {
  if (cursor === null || cursor === '') return null
  try {
    const value = BigInt(cursor)
    return value < 0n ? null : value
  } catch {
    // A cursor comes from the URL. A malformed one is a first page, never a
    // 500 and never a SQL error.
    return null
  }
}

/**
 * EXPLORE LISTESI. IMLEC BURADA YENIDEN TURETILMEZ -- ARTIK.
 *
 * Onceki hal bir `CURSOR_KEY: Record<SortKey, (row) => bigint>` haritasiydi ve
 * `marketCap` icin `r.marketCapWei` dondururdu. Bu, `packages/db`de OLCULDU
 * (`ordering.test.ts`): hic islem gormemis her token AYNI acilis market cap'ini
 * tasidigi icin `limit: 2` ile alti tokenin YALNIZCA IKISINE ulasiliyordu ve
 * kalan dordu HICBIR sayfada gorunmuyordu; `sort=volume`da ikinci sayfa BOS
 * donuyordu. Sayfa `limit: 24` ile canliydi.
 *
 * `listTokens` artik anahtari `search_key(<miktar>, created_seq)` olarak
 * PAKETLIYOR ve `nextCursor`'u SORGUNUN KENDISI donduruyor -- yani ORDER BY,
 * imlec suzgeci ve donen imlec TEK bir ifadedir ve ayrisamaz. `readSearch`
 * zaten boyleydi; iki yol artik ayni.
 *
 * IMLEC `Number`A DOKUNMAZ: paketlenmis `marketCap` anahtari testnet acilis
 * cap'inde 38 basamaktir (`Number.MAX_SAFE_INTEGER` 16). `bigint` -> `toString`
 * -> URL -> `parseCursor`'un `BigInt`i; arada `Number` YOKTUR.
 */
export async function readTokenList(params: ListParams): Promise<ReadResult<Page<TokenOverview>>> {
  return guard(async () => {
    const { rows, nextCursor, indexer } = await listTokens(getPool(), {
      sort: params.sort,
      ...(params.ageDays === null ? {} : { ageDays: params.ageDays }),
      cursor: parseCursor(params.cursor),
      limit: params.limit,
    })
    return {
      value: { rows, nextCursor: nextCursor === null ? null : nextCursor.toString() },
      indexer,
    }
  })
}

export type SearchParams = {
  readonly q: string
  readonly sort: SearchSortKey
  readonly ageDays: number | null
  readonly cursor: string | null
  readonly limit: number
}

/**
 * ⌘K'NIN METIN ARAMASI.
 *
 * `web/components/search/searchBoundary.ts` YERINE gecer. O dosya `searchTokens`
 * `packages/db`'ye inene kadar durdu ve her cagriya `unavailable` dondu -- bir
 * yer tutucu degil, o gunun dogrusu. Sorgu `c035a88` ile indi, dolayisiyla
 * sinir kalkti ve rota buradan okuyor.
 *
 * =========================================================================
 *  IMLEC BURADA YENIDEN TURETILMEZ -- ve `readTokenList` de artik oyle.
 * =========================================================================
 *
 * `nextCursor`'u SORGUNUN KENDISI dondurur (`(${key})::text AS cursor_key`),
 * cunku `relevance` anahtari `similarity()` uzerinden hesaplanir ve TypeScript'te
 * yeniden hesaplanamaz. Burada yapilan tek sey onu dizeye cevirmektir.
 * `readTokenList` bu sekli GEC benimsedi: onun `CURSOR_KEY` haritasi tam da bu
 * ayrismanin canli ornegiydi ve alti tokenin dordunu kaybediyordu.
 *
 * =========================================================================
 *  IMLEC 64 BITE SIGMAZ VE `Number`A HIC DOKUNMAZ.
 * =========================================================================
 *
 * Anahtar `amount * 2^63 + created_seq` olarak PAKETLENIR (packages/db,
 * migration 008): `created_seq` `[0, 2^63)` araliginda oldugu icin bu esleme
 * konumsal ve BIREBIRDIR, yani tek bir karsilastirma `(amount, created_seq)`
 * sozluk sirasinin ta kendisidir. Bedeli boyudur -- olculdu: testnet acilis
 * market cap'inde `marketCap` imleci **38 basamak**, teorik ust sinir 97.
 * `Number.MAX_SAFE_INTEGER` 16 basamaktir, yani `Number(cursor)` 17. basamaktan
 * itibaren hassasiyet kaybeder ve keyset'i YANLIS SATIRA oturtur: tam olarak bu
 * anahtarin onlemek icin var oldugu sessiz tekrar/atlama. `parseCursor` zaten
 * `BigInt` kullanir; burasi onu tekrar etmez, ADIYLA anar.
 */
export async function readSearch(params: SearchParams): Promise<ReadResult<Page<TokenOverview>>> {
  return guard(async () => {
    const { rows, nextCursor, indexer } = await searchTokens(getPool(), params.q, {
      sort: params.sort,
      ...(params.ageDays === null ? {} : { ageDays: params.ageDays }),
      cursor: parseCursor(params.cursor),
      limit: params.limit,
    })
    return {
      // BOS SONUC BIR SAYFADIR, `notFound` DEGIL. "Hicbir sey eslesmedi" ile
      // "arama calismiyor" iki ayri cumledir ve yalnizca biri dogrudur;
      // ikisini ayni yanita katlamak, calisan bir aramaya bozuk dedirtir.
      value: { rows, nextCursor: nextCursor === null ? null : nextCursor.toString() },
      indexer,
    }
  })
}

export async function readTokenOverview(token: string): Promise<ReadResult<TokenOverview>> {
  const result = await guard<TokenOverview | null>(
    async () => {
      const { rows, indexer } = await getTokenOverview(getPool(), token as `0x${string}`)
      return { value: rows, indexer }
    },
    (value) => value === null,
  )
  // `notFound` already carries the null; narrow the success branches.
  return result as ReadResult<TokenOverview>
}

/**
 * `listTrades` and `listHolders` return BARE ARRAYS -- `packages/db` attaches
 * `Fresh<T>` only to the two list queries. So this layer asks for the indexer
 * status ITSELF on those paths.
 *
 * That is the point rather than a workaround: freshness is attached at THIS
 * boundary for every read, so no consumer can be handed a value whose
 * freshness simply was not available. A path that quietly returned rows
 * without a status would be the one dangerous case, and it would be the one
 * nobody noticed.
 */
export async function readTrades(
  token: string,
  params: PageParams,
): Promise<ReadResult<Page<TradeRow>>> {
  return guard(async () => {
    const pool = getPool()
    const rows = await listTrades(pool, token as `0x${string}`, {
      cursor: parseCursor(params.cursor),
      limit: params.limit,
    })
    const indexer = await getIndexerStatus(pool)
    return {
      value: { rows, nextCursor: nextCursorFrom(rows, params.limit, (r) => r.eventSeq) },
      indexer,
    }
  })
}

/**
 * Holders, curve EXCLUDED by the query itself (`h.holder <> c.curve`).
 *
 * THE CURSOR IS REAL NOW, and the dependency it was waiting on is named
 * because the wait is the interesting part. This function used to hard-code
 * `nextCursor: null` with a comment saying `listHolders` "takes only
 * `{ limit }`". That stopped being true at `c035a88`: it takes
 * `{ after?: HolderCursor | null, limit? }` and exports
 * `encodeHolderCursor`/`parseHolderCursor`. A comment describing a dependency
 * does not notice when the dependency lands, so the holders tab was capped at
 * one page for every commit in between -- and the cap was INVISIBLE, because a
 * null cursor draws no button and an absent button looks like a short list.
 *
 * THE CURSOR IS TWO-PART AND MUST BE. The order is `balance_tok DESC, holder
 * ASC`; `balance_tok` alone cannot be a keyset because balances TIE, most
 * densely in the tail where an airdrop gave hundreds of wallets the same
 * number. `packages/db` builds the cursor out of the returned row's own fields
 * rather than re-deriving an expression, so the ORDER BY and the cursor cannot
 * drift apart -- this layer only stringifies it.
 */
export async function readHolders(
  token: string,
  params: PageParams,
): Promise<ReadResult<Page<HolderRow>>> {
  return guard(async () => {
    const pool = getPool()
    const rows = await listHolders(pool, token as `0x${string}`, {
      // A malformed cursor is the FIRST PAGE, never a 500: this value arrives
      // from a URL or a client-supplied server-action argument.
      after: parseHolderCursor(params.cursor),
      limit: params.limit,
    })
    const indexer = await getIndexerStatus(pool)
    // A short page is the last page. Same rule as `nextCursorFrom`, but the
    // key is a PAIR rather than a bigint, so it cannot share that helper.
    const last = rows.length < params.limit ? undefined : rows[rows.length - 1]
    return {
      value: { rows, nextCursor: last === undefined ? null : encodeHolderCursor(last) },
      indexer,
    }
  })
}

// ===========================================================================
//  FAZ 5 -- /analytics VE /profile/[address]
// ===========================================================================

/**
 * THE ANALYTICS RANGE IS A WHITELIST, NOT A NUMBER FROM THE URL.
 *
 * `?range=` reaches `getProtocolStats` as an HOUR COUNT. A raw number from the
 * URL would let a link decide the window -- harmless today, but it also makes
 * the page's own claim ("24h") unverifiable, because two links could both say
 * 24h and mean different things. Two keys, two windows, nothing else.
 */
export const ANALYTICS_RANGES = { '24h': 24, all: null } as const
export type AnalyticsRange = keyof typeof ANALYTICS_RANGES

export function parseAnalyticsRange(value: string | string[] | undefined): AnalyticsRange {
  const first = Array.isArray(value) ? value[0] : value
  return first === '24h' ? '24h' : 'all'
}

/** The bar charts' span. One place, because the page and its caption share it. */
export const ANALYTICS_DAYS = 30

export async function readProtocolStats(range: AnalyticsRange): Promise<ReadResult<ProtocolStats>> {
  return guard(async () => {
    const { rows, indexer } = await getProtocolStats(getPool(), {
      windowHours: ANALYTICS_RANGES[range],
    })
    return { value: rows, indexer }
  })
}

export async function readProtocolDaily(
  days: number = ANALYTICS_DAYS,
): Promise<ReadResult<readonly ProtocolDay[]>> {
  return guard(async () => {
    const { rows, indexer } = await listProtocolDaily(getPool(), { days })
    return { value: rows as readonly ProtocolDay[], indexer }
  })
}

/**
 * ============ THE EARNINGS TOTAL DOES NOT COME FROM THE ROWS ============
 *
 * `packages/db`'s `getCreatorEarnings` returns ONE object whose shape makes
 * the wrong total unavailable: there is no field equal to the sum of
 * `byLaunch`. The ledger totals (`depositedTotalWei`, `claimableWei`) come
 * from `fee_balances`, which is `FeeEscrow.owed(recipient)` plus what has been
 * claimed, and the difference from the attributable rows arrives NAMED --
 * `unattributedWei`.
 *
 * This layer forwards that object WHOLE. It does not spread it, does not
 * re-derive anything from it, and the profile page passes it straight to the
 * panel. That is deliberate: every place a total could be recomputed is a
 * place it could be recomputed WRONGLY, and the number that would be wrong is
 * the one a creator reads as "what I earned".
 */
export async function readCreatorEarnings(
  recipient: string,
): Promise<ReadResult<CreatorEarnings>> {
  return guard(async () => {
    const { rows, indexer } = await getCreatorEarnings(getPool(), recipient as `0x${string}`)
    return { value: rows, indexer }
  })
}

export async function readLaunchesByCreator(
  creator: string,
  limit: number,
): Promise<ReadResult<readonly TokenOverview[]>> {
  return guard(async () => {
    const pool = getPool()
    const rows = await listLaunchesByCreator(pool, creator as `0x${string}`, { limit })
    const indexer = await getIndexerStatus(pool)
    return { value: rows as readonly TokenOverview[], indexer }
  })
}

/**
 * Positions, keyset-paged on `(valueWei, token)`.
 *
 * THE CURSOR IS TWO-PART FOR THE SAME REASON THE HOLDERS ONE IS: the price is
 * per token, so every token that has never traded carries the SAME opening
 * price, and two positions of equal size have EXACTLY equal value. A one-part
 * keyset repeats and skips rows precisely there.
 */
export async function readPositions(
  holder: string,
  params: PageParams,
): Promise<ReadResult<Page<PositionRow>>> {
  return guard(async () => {
    const { rows, indexer } = await listPositionsByHolder(getPool(), holder as `0x${string}`, {
      after: parsePositionCursor(params.cursor),
      limit: params.limit,
    })
    const last = rows.length < params.limit ? undefined : rows[rows.length - 1]
    return {
      value: { rows, nextCursor: last === undefined ? null : encodePositionCursor(last) },
      indexer,
    }
  })
}

// ===========================================================================
//  FAZ 6 -- HOLDER-GATED CHAT
// ===========================================================================

/**
 * SOHBET PANELININ SAYFA BOYU.
 *
 * `TABLE_PAGE_SIZE`den AYRI ve daha kucuk: mesajlar dar bir kolonda, cok
 * satirli govdelerle cizilir; 25 mesaj o kolonu iki ekran uzatirdi. Ayni
 * `<= 200` tavani gecerli (bkz. `TABLE_PAGE_SIZE`in yorumu).
 */
export const CHAT_PAGE_SIZE = 20

/**
 * ============ OKUMA YOLU BIR SERVER COMPONENT SORGUSUDUR ============
 *
 * Spec §6.3: "Liste ve gecmis -- server component'lerden DOGRUDAN Postgres
 * sorgusu. Araya ayri bir API katmani konmaz. API route'lari YALNIZCA yazma
 * icin." Chat bu kuralin iki yarisini da ayni ekranda tasiyan ilk ozellik:
 * panel BURADAN okur, gonderme `app/api/chat/route.ts`ten gecer. `/api/chat`
 * icinde bir `GET` YOKTUR ve olmayacaktir.
 *
 * TAZELIK YINE DE ILISTIRILIR (`getIndexerStatus`), ama anlami burada
 * FARKLIDIR ve panel bunu soyler: mesajlarin kendisi indexer'dan GELMEZ, bu
 * tabloyu web yazar. Bayat olabilecek sey mesajin YANINDAKI olculerdir --
 * yazarin SU ANKI bakiyesi (`holders`) ve creator isareti. Bir mesajin
 * gorunmesi indexer'in ilerlemesine bagli degildir.
 */
export async function readChat(
  token: string,
  params: PageParams,
): Promise<ReadResult<Page<ChatMessageRow>>> {
  return guard(async () => {
    const pool = getPool()
    const rows = await listChatMessages(pool, token as `0x${string}`, {
      // Bozuk imlec ILK SAYFADIR, 500 degil: deger URL'den ya da bir istemci
      // argumanindan gelir.
      before: parseChatCursor(params.cursor),
      limit: params.limit,
    })
    const indexer = await getIndexerStatus(pool)
    const last = rows.length < params.limit ? undefined : rows[rows.length - 1]
    return {
      value: { rows, nextCursor: last === undefined ? null : encodeChatCursor(last) },
      indexer,
    }
  })
}

export async function readTraderTrades(
  trader: string,
  params: PageParams,
): Promise<ReadResult<Page<TraderTradeRow>>> {
  return guard(async () => {
    const { rows, indexer } = await listTradesByTrader(getPool(), trader as `0x${string}`, {
      cursor: parseCursor(params.cursor),
      limit: params.limit,
    })
    return {
      value: { rows, nextCursor: nextCursorFrom(rows, params.limit, (r) => r.eventSeq) },
      indexer,
    }
  })
}
