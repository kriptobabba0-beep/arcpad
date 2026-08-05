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
export type {
  FreshIndexer,
  IndexerStatus,
  SortKey,
  StaleIndexer,
  StaleReason,
  SyncPoint,
  TokenOverview,
} from '@arcpad/db'
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
 * ISLEM SATIRI = Faz 3'un satiri. BOSLUK KAPANDI.
 *
 * ============ BU YORUM BIR SURE YANLISTI, VE YANLISLIGI ONEMLIYDI ============
 *
 * Burada "listTrades bugun sekiz alan seciyor, ucretleri SECMIYOR" yaziyordu ve
 * alanlar bu yuzden OPSIYONEL kilinmisti. `listTrades` artik ONUCUNU de seciyor
 * (`packages/db/src/queries.ts`): iki ucret parcasi ve DORT rezerv. Yani
 * `DbTradeRow` hepsini ZORUNLU tasiyor, ve bir kesisim bir alani opsiyonel
 * YAPAMAZ -- `A & B`'de alan ancak IKI tarafta da opsiyonelse opsiyoneldir.
 * Olculdu: `{ x: bigint } & { x?: bigint }` icin `{}` atamasi TS2322 verir ve
 * `const t: bigint = row.x` temiz derlenir. Yani asagidaki `?`'ler hicbir sey
 * yapmiyordu ve yorum okuyucuyu var olmayan bir boslugu kapatmaya gonderiyordu.
 *
 * SONUC: overlay KALDIRILDI. `walletDeltaWei` ve `feeBreakdown` icindeki
 * "ucretler yoksa `null`" dallari ve tablonun "—" cizimi TIP DUZEYINDE
 * ULASILAMAZ durumda; hicbir test onlari kosmuyor. Silinmediler cunku bu
 * satirlar API sinirindan JSON olarak da gecebiliyor, ama ULASILAMAZ olduklari
 * artik yazili -- "kimsenin yazmadigi bir nedenle yesil duran" bir dal olarak
 * degil.
 *
 * KRITIK OLAN SU DEGISMEDI: eksik ucretlerde `quoteAmountWei`'ye DUSULMEZ.
 * Curve tutarini "cuzdandan cikan" diye etiketlemek, brief'in yasakladigi
 * hatanin ta kendisi -- ve yanlis bir sayi, eksik bir sayidan pahaliya mal
 * olur. `test/token/tables.test.tsx` bunu iddia eder.
 */
export type TradeRow = DbTradeRow

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
