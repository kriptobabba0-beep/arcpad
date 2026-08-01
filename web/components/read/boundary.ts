import type {
  Canonicity,
  HexAddress,
  HolderRow,
  Page,
  PageParams,
  ReadResult,
  SearchSortKey,
  SortKey,
  TokenOverview,
  TradeRow,
} from './types'

/**
 * =========================================================================
 *  OKUMA SINIRI -- TASK 7 GELDIGINDE BU DOSYA SILINIR.
 * =========================================================================
 *
 * NEDEN BURADA VE NEDEN BOS DONUYOR, ikisi de olculdu:
 *
 * 1. Task 7'nin dosyalari (`web/lib/db.ts`, `read.ts`, `canonical.ts`,
 *    `metadata.ts`) bu dalgada BASKA BIR IZIN SAHIBINDE.
 *
 * 2. Daha onemlisi: Task 7'nin KENDI on kosulu da yok. Plan, Faz 3'un
 *    `packages/db/src/queries.ts`'ini "hazir gelenler" diye sayiyor --
 *    `SORTS`, `listTokens`, `getTokenOverview`, `listTrades`, `listHolders`
 *    ve `token_overview` VIEW'i. Bugun depoda:
 *      - `packages/db/src/queries.ts`  YOK
 *      - `token_overview` view'i       YOK (yalnizca 006'da bir yorumda anilir)
 *      - `SORTS`                       YOK
 *    Var olan sey SEMA: launches, curve_state, trades, token_transfers,
 *    holders, fee_events, fee_balances, token_stats -- hepsi migration'larda,
 *    kolon adlari ve tipleriyle. `./types.ts` oradan turetildi, plandan
 *    kopyalanmadi.
 *
 * BU YUZDEN HER OKUMA `{ ok: false, reason: 'unavailable' }` DONER, ve bu bir
 * yer tutucu degil BUGUNUN DOGRUSU: okuma katmani gercekten yok. Sonuc,
 * "veritabani dustu" yolunun uretimde CANLI yol olmasi -- yani arayuzun
 * dususe dayanikliligi bir gelecek vaadi degil, su anda ekranda gorunen sey.
 *
 * Task 7 indiginde yapilacak is: bu dosyayi silmek ve `web/lib/read.ts`'i
 * import etmek. Imzalar Task 7'nin brief'indeki `Uretir` satiriyla BIREBIR
 * ayni tutuldu, tek fark `ReadResult`'in `./types`'tan gelmesi.
 */

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const

/**
 * `guard`'in kendisi. Task 7'de bir `try/catch` sarmalayicisi olacak; burada
 * cagrilacak bir sorgu olmadigi icin dogrudan `unavailable` donuyor.
 *
 * Loglama BILEREK burada degil: bu bir hata degil, EKSIK BIR BAGIMLILIK.
 * Her istekte bir satir yazmak, gercek bir dusus geldiginde onu gurultunun
 * icinde kaybettirirdi.
 */
export type ListParams = {
  readonly sort: SortKey
  readonly ageDays: number | null
  readonly cursor: string | null
  readonly limit: number
}

export type SearchParams = {
  readonly q: string
  readonly sort: SearchSortKey
  readonly ageDays: number | null
  readonly cursor: string | null
  readonly limit: number
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function readTokenList(_params: ListParams): Promise<ReadResult<Page<TokenOverview>>> {
  return UNAVAILABLE
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function readTokenOverview(_token: HexAddress): Promise<ReadResult<TokenOverview>> {
  return UNAVAILABLE
}

export async function readTrades(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _token: HexAddress,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _params: PageParams,
): Promise<ReadResult<Page<TradeRow>>> {
  return UNAVAILABLE
}

export async function readHolders(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _token: HexAddress,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _params: PageParams,
): Promise<ReadResult<Page<HolderRow>>> {
  return UNAVAILABLE
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function readSearch(_params: SearchParams): Promise<ReadResult<Page<TokenOverview>>> {
  return UNAVAILABLE
}

/**
 * KANONIKLIK. Task 7'de bir `eth_call`; burada `unverifiable`.
 *
 * Varsayilanin `unverifiable` olmasi FAIL-CLOSED'dir ve tek dogru varsayilan
 * budur: `canonical` donen bir stub, dogrulanmamis her adresi bir launch gibi
 * cizdirirdi -- sahtekarligin isleyis bicimi tam olarak odur. Faz 1c olctu:
 * bir sahteci gercek bir launch'in creator'ini, curve'unu, metadata'sini,
 * salt'ini ve gerceklesen islem fiyatini BIREBIR taklit edebilir; ayiran tek
 * sey adresin kendi HAM verisinden yeniden turetilmesidir.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function verifyCanonical(_token: HexAddress): Promise<Canonicity> {
  return 'unverifiable'
}

export type ResolvedMetadata = {
  readonly description?: string
  readonly image?: string
  readonly x?: string
  readonly telegram?: string
}

/**
 * `uri` SALDIRGAN KONTROLUNDEDIR ve bu stub HICBIR ISTEK YAPMAZ.
 *
 * Task 7 burada bir sunucu-tarafi fetch acacak, ve `uri` launch edenin
 * yazdigi serbest bir dizedir -- yani bir SSRF yuzeyi. Stub'in `null`
 * donmesi, o yuzey acilana kadar hicbir ic aga istek gitmemesini garanti
 * eder. Cozulemeyen metadata zaten YAYGIN durumdur (`uri` bos olabilir), o
 * yuzden bu bir hata dali degil normal daldir.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function resolveMetadata(_uri: string): Promise<ResolvedMetadata | null> {
  return null
}
