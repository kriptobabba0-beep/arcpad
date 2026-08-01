/**
 * OKUMA MODELININ TIPLERI, MIGRATION'LARDAN TURETILDI -- UYDURULMADI.
 *
 * Her alan `packages/db/migrations/00{2,3,4,6}_*.sql` icindeki bir kolona
 * karsilik gelir ve tipi o kolonun tipidir. `numeric(78,0)` kolonlari
 * TypeScript'te `string`tir, `bigint` degil: `pg` surucusu 78 basamakli bir
 * sayiyi Number'a ceviremeyecegi icin dize dondurur, ve bunu `bigint`
 * yazarak gizlemek, ilk `JSON.parse`ta patlayan bir yalan olurdu.
 *
 * SONEK SOZLESMESI BAGLAYICIDIR (Faz 3):
 *   `_wei` = 18 ondalikli native USDC   `_tok` = 18 ondalikli token tabani
 *   `_ppm` = milyonda pay              `_seq` = event_seq
 *   `_at`  = YALNIZCA gosterim, ASLA siralama
 * `_wei` ve `_tok` ikisi de 1e18 olcekli ama TOPLANMALARI bir kategori
 * hatasidir -- fiyat `wei/tok`tur.
 */

/** `0x` + 40 kucuk harf hex. Veritabani bunu CHECK ile zorluyor. */
export type HexAddress = `0x${string}`

/**
 * Faz 3'un `token_overview` VIEW'i.
 *
 * DIKKAT: bu view HENUZ YOK (bkz. `boundary.ts`'in basligi). Alan listesi
 * Faz 4 planinin "Faz 3 ile hizalama" bolumunden BIREBIR alindi, tipler ise
 * migration'lardaki kolon tiplerinden.
 */
export type TokenOverview = {
  readonly token: HexAddress
  readonly curve: HexAddress
  readonly name: string
  readonly symbol: string
  readonly uri: string

  /**
   * ZINCIRDEKI HAM BAYTLAR, ve gosterim metninin YERINE GECMEZLER.
   *
   * `launches.name`/`symbol`/`uri` `pgSafeText`'ten gecmistir: Postgres'e
   * giremeyen kod birimleri U+FFFD olmustur ve bu COKA-BIR, geri donulemez
   * bir eslemedir. Token kimligi CREATE2 ile HAM baytlardan turetilir, yani
   * kanonikligi gosterim metninden dogrulamak MUMKUN DEGILDIR: zincirdeki
   * ayri iki isim ayni gosterim metnine duser.
   *
   * Kanoniklik hakkinda ekrana yazilan her sey bu alanlardan gelir.
   */
  readonly name_hex: string
  readonly symbol_hex: string
  readonly uri_hex: string
  readonly salt: string

  /** Launch anindaki creator. Kalicidir. */
  readonly launch_creator: HexAddress
  /** Ucreti FIILEN alan cuzdan. Degisebilir; `launch_creator` ile ayni degildir. */
  readonly fee_creator: HexAddress

  readonly virtual_token_reserves_tok: string
  readonly virtual_quote_reserves_wei: string
  readonly real_token_reserves_tok: string
  readonly real_quote_reserves_wei: string

  readonly complete: boolean
  readonly completed_seq: string | null
  readonly pool_seed_supply_tok: string | null

  readonly market_cap_wei: string
  readonly price_wei_per_token: string
  readonly progress_ppm: number
  readonly graduation_raise_wei: string

  readonly holder_count: number
  readonly volume_total_wei: string
  readonly volume_24h_wei: string
  readonly ath_market_cap_wei: string
  readonly trade_count: number
  readonly buy_count: number

  readonly last_trade_seq: string | null
  readonly last_buy_seq: string | null
  readonly last_trade_at: string | null
  readonly last_buy_at: string | null
  readonly created_seq: string
  readonly created_at: string
}

/** `trades` tablosunun bir satiri, arti indexer'in turettigi `is_dev`. */
export type TradeRow = {
  readonly event_seq: string
  readonly block_number: string
  readonly log_index: number
  readonly tx_hash: string
  /** YALNIZCA gosterim ve 24s penceresi. Siralama `event_seq` uzerindedir. */
  readonly block_time: string
  readonly token: HexAddress
  readonly curve: HexAddress
  readonly trader: HexAddress
  readonly is_buy: boolean
  readonly token_amount_tok: string
  /** CURVE tutari. Kullanicinin cuzdanindan cikan tutar bu DEGILDIR. */
  readonly quote_amount_wei: string
  readonly protocol_fee_wei: string
  /** Creator sifirsa SIFIRDIR ve protokol payina katlanmaz. */
  readonly creator_fee_wei: string
  readonly virtual_token_reserves_tok: string
  readonly virtual_quote_reserves_wei: string
  readonly real_token_reserves_tok: string
  readonly real_quote_reserves_wei: string
  readonly source: 'curve' | 'pool'
  /**
   * INDEXER TURETIR, arayuz HESAPLAMAZ.
   *
   * `trader === overview.fee_creator` karsilastirmasi yanlistir: creator
   * degistirilebilir (Faz 1d) ve bugunun creator'iyla eski bir islemi
   * karsilastirmak gecmisi yanlis boyar. Faz 3 bunu `creator_at(token, seq)`
   * ile NOKTASAL olarak cozer.
   */
  readonly is_dev: boolean
}

/** `holders` tablosunun bir satiri. Curve adresi sorguda HARIC tutulur. */
export type HolderRow = {
  readonly token: HexAddress
  readonly holder: HexAddress
  readonly balance_tok: string
  readonly last_seq: string
}

/**
 * SIRALAMA ANAHTARLARI BIR BEYAZ LISTEDIR.
 *
 * URL'den gelen bir dize hicbir zaman bir SQL ifadesine donusmez. Deger
 * burada bir ANAHTAR olarak cozulur; ifadenin kendisi `packages/db`'de durur.
 */
export const SORT_KEYS = ['recentBuys', 'newest', 'oldest', 'marketCap', 'volume'] as const
export type SortKey = (typeof SORT_KEYS)[number]

/** `relevance` YALNIZCA arama icindir ve `q` bos oldugunda secilemez. */
export const SEARCH_SORT_KEYS = ['relevance', ...SORT_KEYS] as const
export type SearchSortKey = (typeof SEARCH_SORT_KEYS)[number]

export type PageParams = { readonly cursor: string | null; readonly limit: number }

export type Page<T> = {
  readonly rows: readonly T[]
  readonly nextCursor: string | null
  readonly total: number
}

/**
 * VERITABANI DUSTUGUNDE SAYFA 500 VERMEZ.
 *
 * Bir istisna yukari sizarsa Next hata sinirini cizer ve token sayfasinin
 * TAMAMI kaybolur -- al-sat paneli dahil, ki o rezervleri ZINCIRDEN okur ve
 * veritabanina hic ihtiyaci yoktur. Sonucu bir deger yapmak, "eksik veriyle
 * ciz" davranisini bir istisna yakalama refleksine degil tip sistemine
 * baglar.
 */
export type ReadResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: 'unavailable' | 'notFound' }

/** Kanoniklik uc degerlidir ve ikisi AYNI ekrana gider. */
export type Canonicity = 'canonical' | 'forged' | 'unverifiable'
