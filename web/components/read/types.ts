import type {
  Fresh,
  HolderRow as DbHolderRow,
  IndexerStatus,
  SortKey,
  TokenOverview,
  TradeRow as DbTradeRow,
} from '@arcpad/db'

/**
 * OKUMA MODELININ TIPLERI -- TEK KAYNAK `packages/db/src/queries.ts`.
 *
 * Bu dosya BIR KOPYA DEGIL. `import type` calisma zamaninda tamamen silinir
 * (`verbatimModuleSyntax` acik), yani `pg` istemci paketine girmez; ama
 * derleme zamaninda tip Faz 3'un kendi tanimidir. Bir kolon adi orada
 * degistiginde burasi DERLENMEZ -- ki daha once tam tersi oldu: bu dosya
 * migration'lardan elle turetilmisti, `queries.ts` sonradan indi ve iki taraf
 * SESSIZCE ayrildi (snake_case/string vs camelCase/bigint).
 *
 * SONEK SOZLESMESI hâlâ baglayici, camelCase'e cevrilmis hâliyle:
 *   `…Wei` = 18 ondalikli native USDC   `…Tok` = 18 ondalikli token tabani
 *   `…Ppm` = milyonda pay               `…Seq` = event_seq
 *   `…At`  = YALNIZCA gosterim, ASLA siralama
 * `…Wei` ve `…Tok` ikisi de 1e18 olcekli ama TOPLANMALARI kategori hatasidir.
 */
export type { Fresh, IndexerStatus, SortKey, TokenOverview }

/**
 * `0x` + 40 hex.
 *
 * Faz 3'un satirlari adresleri DUZ `string` olarak veriyor (veritabani CHECK
 * ile zorluyor, tip zorlamiyor). Bu daraltma yalnizca ZINCIRE ve okuma
 * fonksiyonlarina giden sinirda kullanilir -- viem `0x${string}` ister ve bir
 * `as` orada kacinilmazdir.
 *
 * Bileşen prop'lari bilerek `string` kalir: bir satiri EKRANA cizmek icin
 * daraltmaya ihtiyac yok, ve her bileşene bir cast tasitmak, castlerin
 * dogrulanmadigi bir yerde cogalmasi demek olurdu.
 */
export type HexAddress = `0x${string}`

/**
 * Sinirda daraltma, DOGRULAYARAK.
 *
 * `as HexAddress` yazmak bir iddiadir ve yanlis oldugunda sessizce gecer.
 * Bu, sekli KONTROL eder ve bozuksa atar -- adres bir kullanicidan ya da bir
 * veritabani satirindan geliyorsa iddia yeterli degildir.
 */
export function asHex(value: string): HexAddress {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`not a 20-byte hex address: ${value}`)
  }
  return value.toLowerCase() as HexAddress
}

/**
 * ISLEM SATIRI = Faz 3'un satiri + UCRET VE REZERV ALANLARI.
 *
 * ============ BU BIR BOSLUK, VE DERLEME ZAMANINDA DURUYOR ============
 *
 * `listTrades` bugun sekiz alan seciyor: eventSeq, txHash, blockTime, trader,
 * isBuy, tokenAmountTok, quoteAmountWei, isDev. Ucretleri SECMIYOR.
 *
 * Ama `walletDeltaWei` -- Task 11'in merkezi gereksinimi, "cuzdandan cikan
 * tutari goster, curve tutarini degil" -- onlarsiz HESAPLANAMAZ: alimda
 * kullanicinin odedigi `quote + protokol + creator`, satimda aldigi
 * `quote - ucretler`. Yalnizca `quoteAmountWei` gostermek, brief'in acikca
 * yasakladigi sey.
 *
 * Kolonlar VERITABANINDA VAR (`003_trades_and_curve_state.sql`:
 * `protocol_fee_wei`, `creator_fee_wei`, `virtual_*`); yalnizca SELECT'te
 * yoklar. Bu yuzden burada ZORUNLU alan olarak duruyorlar: Task 7'nin
 * adaptoru yazildiginda `listTrades`'in cikti tipi bu tipe ATANAMAZ ve derleme
 * kirilir. Bir yorum degil, bir kapi.
 *
 * Grafik de ayni sebeple etkileniyor: `realisedSeries` her islemin sakladigi
 * rezerv anlik goruntusunden fiyat turetir.
 */
export type TradeRow = DbTradeRow & {
  readonly protocolFeeWei: bigint
  /** Creator sifirsa SIFIRDIR ve protokol payina KATLANMAZ. */
  readonly creatorFeeWei: bigint
  readonly virtualTokenReservesTok: bigint
  readonly virtualQuoteReservesWei: bigint
}

/** Faz 3'un satiri. Curve sorguda HARIC tutulur (`h.holder <> c.curve`). */
export type HolderRow = DbHolderRow

/**
 * SIRALAMA ANAHTARLARI BIR BEYAZ LISTEDIR.
 *
 * URL'den gelen dize hicbir zaman bir SQL ifadesine donusmez; buradan gecen
 * tek sey `SORTS`'un bir ANAHTARIDIR. Dizi olarak ayrica duruyor cunku filtre
 * seridi uzerinde donmek zorunda -- ama asagidaki iki iddia, listenin Faz
 * 3'un anahtar kumesiyle AYNI kalmasini derleme zamaninda zorunlu kilar.
 */
export const SORT_KEYS = ['recentBuys', 'newest', 'oldest', 'marketCap', 'volume'] as const

// Iki yonlu: eksik bir anahtar da, uydurma bir anahtar da burada kirilir.
const _sortKeysCoverDb: SortKey extends (typeof SORT_KEYS)[number] ? true : never = true
const _dbCoversSortKeys: (typeof SORT_KEYS)[number] extends SortKey ? true : never = true
void _sortKeysCoverDb
void _dbCoversSortKeys

/** `relevance` YALNIZCA arama icindir ve `q` bos oldugunda secilemez. */
export const SEARCH_SORT_KEYS = ['relevance', ...SORT_KEYS] as const
export type SearchSortKey = (typeof SEARCH_SORT_KEYS)[number]

export type PageParams = { readonly cursor: string | null; readonly limit: number }

/**
 * SAYFA = satirlar + imlec + toplam.
 *
 * Faz 3'un `listTokens`'i `Fresh<TokenOverview[]>` doner: `nextCursor` ve
 * `total` YOK. Ikisi de bizim sorumlulugumuzda -- imlec son satirin siralama
 * anahtarindan turer, toplam ayri bir sayimdir. Task 7'nin adaptoru bunu
 * doldurur; bugun stub bos sayfa doner.
 */
export type Page<T> = {
  readonly rows: readonly T[]
  readonly nextCursor: string | null
  readonly total: number
}

/**
 * VERITABANI DUSTUGUNDE SAYFA 500 VERMEZ.
 *
 * Istisna yukari sizarsa Next hata sinirini cizer ve token sayfasinin TAMAMI
 * kaybolur -- al-sat paneli dahil, ki o rezervleri ZINCIRDEN okur.
 *
 * `indexer` HER BASARILI OKUMADA tasinir, cunku "veri var" ile "veri GUNCEL"
 * ayri sorulardir: bayat ama mevcut bir fiyati canliymis gibi gostermek,
 * hic gostermemekten daha pahaliya mal olur.
 */
export type ReadResult<T> =
  | { readonly ok: true; readonly data: T; readonly indexer: IndexerStatus }
  | { readonly ok: false; readonly reason: 'unavailable' | 'notFound' }

/** Kanoniklik uc degerlidir ve ikisi AYNI ekrana gider. */
export type Canonicity = 'canonical' | 'forged' | 'unverifiable'
