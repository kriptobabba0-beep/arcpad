import type { HolderRow as DbHolderRow, TradeRow as DbTradeRow } from '@arcpad/db'

/**
 * OKUMA MODELININ TIPLERI -- KAYNAK BASKA YERDE, BURASI YALNIZCA KAPI.
 *
 * `TokenOverview`, `IndexerStatus`, `SortKey`  -> `packages/db/src/queries.ts`
 * `ReadResult`, `Page`, `fold`, `valueOf`      -> `web/lib/read.ts`
 *
 * Hicbiri burada YENIDEN TANIMLANMIYOR. Daha once tam tersi yapilmisti: bu
 * dosya migration'lardan elle turetilmisti, `queries.ts` sonradan indi ve iki
 * taraf SESSIZCE ayrildi (snake_case/string vs camelCase/bigint). `import
 * type` calisma zamaninda tamamen silinir (`verbatimModuleSyntax`), yani `pg`
 * istemci paketine girmez; ama bir kolon adi degistiginde BURASI DERLENMEZ.
 *
 * SONEK SOZLESMESI baglayici:
 *   `…Wei` = 18 ondalikli native USDC   `…Tok` = 18 ondalikli token tabani
 *   `…Ppm` = milyonda pay               `…Seq` = event_seq
 *   `…At`  = YALNIZCA gosterim, ASLA siralama
 */
export type { IndexerStatus, SortKey, TokenOverview } from '@arcpad/db'
export type { Page, ReadFailure, ReadResult } from '@/lib/read'
// DEGER ihraci `./result`'tan: `@/lib/read` `server-only` ve `pg` tasiyor,
// oradan bir fonksiyon yeniden ihrac etmek `pg`'yi istemci paketine sokar.
export { fold, stalenessOf, valueOf } from './result'

/**
 * `0x` + 40 hex.
 *
 * Faz 3'un satirlari adresleri DUZ `string` verir (veritabani CHECK ile
 * zorlar, tip zorlamaz). Bu daraltma yalnizca ZINCIRE giden sinirda kullanilir;
 * bileşen prop'lari bilerek `string` kalir, cunku bir satiri EKRANA cizmek icin
 * daraltmaya ihtiyac yok ve her bileşene bir cast tasitmak, castlerin
 * dogrulanmadigi bir yerde cogalmasi demek olurdu.
 */
export type HexAddress = `0x${string}`

/**
 * Sinirda daraltma, DOGRULAYARAK.
 *
 * `as HexAddress` bir IDDIADIR ve yanlis oldugunda sessizce gecer. Bu, sekli
 * KONTROL eder ve bozuksa atar -- deger bir kullanicidan ya da bir veritabani
 * satirindan geliyorsa iddia yeterli degildir.
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
 * Ama `walletDeltaWei` -- "cuzdandan cikan tutari goster, curve tutarini
 * degil" -- onlarsiz HESAPLANAMAZ: alimda kullanicinin odedigi
 * `quote + protokol + creator`, satimda aldigi `quote - ucretler`. Yalnizca
 * `quoteAmountWei` gostermek, brief'in acikca yasakladigi sey.
 *
 * Kolonlar VERITABANINDA VAR (`003_trades_and_curve_state.sql`); yalnizca
 * SELECT'te yoklar.
 *
 * ONCE zorunlu yazildilar ve derleme GERCEKTEN kirildi -- boslugun var
 * oldugunun kaniti bu. Ama zorunlu birakmak, calisan bir sayfayi derlenmez
 * yapardi; yerine alanlar OPSIYONEL ve `walletDeltaWei` onlar yokken `null`
 * doner. Tablo o durumda "—" cizer.
 *
 * KRITIK OLAN SU: eksik ucretlerde `quoteAmountWei`'ye DUSULMEZ. Curve
 * tutarini "cuzdandan cikan" diye etiketlemek, brief'in yasakladigi hatanin ta
 * kendisi -- ve yanlis bir sayi, eksik bir sayidan pahaliya mal olur.
 * `test/token/tables.test.tsx` bunu iddia eder.
 */
export type TradeRow = DbTradeRow & {
  readonly protocolFeeWei?: bigint | undefined
  /** Creator sifirsa SIFIRDIR ve protokol payina KATLANMAZ. */
  readonly creatorFeeWei?: bigint | undefined
  readonly virtualTokenReservesTok?: bigint | undefined
  readonly virtualQuoteReservesWei?: bigint | undefined
}

/** Faz 3'un satiri. Curve sorguda HARIC tutulur (`h.holder <> c.curve`). */
export type HolderRow = DbHolderRow

/**
 * SIRALAMA ANAHTARLARI BIR BEYAZ LISTEDIR.
 *
 * URL'den gelen dize hicbir zaman bir SQL ifadesine donusmez; buradan gecen
 * tek sey `SORTS`'un bir ANAHTARIDIR. Dizi olarak duruyor cunku filtre seridi
 * uzerinde donmek zorunda -- ama asagidaki iki iddia, listenin Faz 3'un anahtar
 * kumesiyle AYNI kalmasini derleme zamaninda zorunlu kilar.
 */
export const SORT_KEYS = ['recentBuys', 'newest', 'oldest', 'marketCap', 'volume'] as const

/** `relevance` YALNIZCA arama icindir ve `q` bos oldugunda secilemez. */
export const SEARCH_SORT_KEYS = ['relevance', ...SORT_KEYS] as const
export type SearchSortKey = (typeof SEARCH_SORT_KEYS)[number]

/** Kanoniklik uc degerlidir ve ikisi AYNI ekrana gider. */
export type { Canonicity } from '@/lib/canonical'
