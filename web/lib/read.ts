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
  getIndexerStatus,
  getTokenOverview,
  type HolderRow,
  type IndexerStatus,
  listHolders,
  listTokens,
  listTrades,
  type SearchSortKey,
  searchTokens,
  type SortKey,
  type TokenOverview,
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

export type ReadResult<T> =
  | { readonly ok: true; readonly stale: false; readonly data: T; readonly indexer: IndexerStatus }
  | {
      readonly ok: true
      readonly stale: true
      readonly staleData: T
      readonly indexer: IndexerStatus
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
    fresh: (data: T, indexer: IndexerStatus) => R
    stale: (data: T, indexer: IndexerStatus) => R
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

const CURSOR_KEY: Record<SortKey, (row: TokenOverview) => bigint> = {
  recentBuys: (r) => r.lastBuySeq ?? r.createdSeq,
  newest: (r) => r.createdSeq,
  oldest: (r) => r.createdSeq,
  marketCap: (r) => r.marketCapWei,
  volume: (r) => r.volume24hWei,
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

export async function readTokenList(params: ListParams): Promise<ReadResult<Page<TokenOverview>>> {
  return guard(async () => {
    const { rows, indexer } = await listTokens(getPool(), {
      sort: params.sort,
      ...(params.ageDays === null ? {} : { ageDays: params.ageDays }),
      cursor: parseCursor(params.cursor),
      limit: params.limit,
    })
    const key = CURSOR_KEY[params.sort]
    return {
      value: { rows, nextCursor: nextCursorFrom(rows, params.limit, key) },
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
 *  IMLEC BURADA YENIDEN TURETILMEZ, ve bu `readTokenList`ten AYRILDIGI YER.
 * =========================================================================
 *
 * `listTokens` icin `nextCursor`'u yukaridaki `CURSOR_KEY` haritasi hesaplar --
 * yani sorgunun ORDER BY ifadesi ile bu dosyadaki bir lambda AYNI seyi iki kez
 * anlatir ve sessizce ayrisabilir. `searchTokens` bu kapiyi kapatiyor:
 * `nextCursor`'u SORGUNUN KENDISI dondurur (`(${key})::text AS cursor_key`),
 * cunku `relevance` anahtari `similarity()` uzerinden hesaplanir ve TypeScript'te
 * yeniden hesaplanamaz. Burada yapilan tek sey onu dizeye cevirmektir.
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
 * NO CURSOR YET, and that is a dependency rather than an oversight:
 * `listHolders` in `packages/db` takes only `{ limit }`. Paging it needs a
 * keyset on `(balance_tok DESC, holder ASC)` -- the second key is REQUIRED
 * because balances tie -- and `packages/db` belongs to another track. Named in
 * the report; `nextCursor` is null here until it lands, which is honest rather
 * than a cursor that silently repeats rows.
 */
export async function readHolders(
  token: string,
  params: PageParams,
): Promise<ReadResult<Page<HolderRow>>> {
  return guard(async () => {
    const pool = getPool()
    const rows = await listHolders(pool, token as `0x${string}`, { limit: params.limit })
    const indexer = await getIndexerStatus(pool)
    return { value: { rows, nextCursor: null }, indexer }
  })
}
