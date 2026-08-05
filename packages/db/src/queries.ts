import type { Address } from './hex'
import { lower } from './hex'
import type { Queryable } from './pool'

/**
 * OKUMA MODELI.
 *
 * Iki kural bu dosyanin sekline hakim:
 *
 * 1. SIRALAMA ASLA BIR ZAMAN KOLONU UZERINDE DEGILDIR. Arc'ta ardisik
 *    bloklarin ~%49'u AYNI timestamp'i tasir (olculdu: 553 ciftin 271'i; sifir
 *    gerileme), yani `ORDER BY last_buy_at DESC` siralamanin yarisini
 *    TANIMSIZ birakir. Postgres esit anahtarlar icin sira garanti etmez ve
 *    plan degistiginde sira da degisir; kararsiz sira ise keyset sayfalamada
 *    SATIR TEKRARLATIR VE ATLATIR -- kullaniciya gorunen, teshisi zor bir
 *    hata ("Explore'da ayni token iki kez cikiyor"). `event_seq` zincirin
 *    kendi tam sirasidir. `ordering.test.ts` bu kurali KAYNAK METNI OKUYARAK
 *    uygular, yani bir yorum degil bir kapidir.
 *
 * 2. HER CANLI SAYI, KENDI TAZELIGIYLE BIRLIKTE DONER. Bunun gerekcesi
 *    yapisaldir: bir okuma modeli "satirlari" dondurup tazeligi AYRI bir
 *    fonksiyona birakirsa, tuketici onu cagirmayi UNUTABILIR ve bayat sayilar
 *    canliymis gibi gosterilir. `listTokens` ve `getTokenOverview` bu yuzden
 *    `{ rows, indexer }` dondurur -- sayilari elde etmenin, tazeligi de elde
 *    etmeden BASKA bir yolu yoktur.
 */

/**
 * INDEXER'IN KENDI TAZELIGI -- IKI EKSEN, VE HICBIRI TEK BASINA CEVAP DEGIL.
 *
 * ================== BURASI BIR KEZ TEK EKSENLIYDI VE YALAN SOYLEDI ==========
 *
 * Eski hal yalnizca `now() - updated_at`i olcuyordu. O sayi SURECIN canli olup
 * olmadigini olcer: her ILERLEYEN aralik `updated_at`i tazeler, bos aralik da
 * dahil. Verinin YASI hakkinda hicbir sey soylemez.
 *
 * OLCULDU (2026-08-05, canli Arc testnet, gercek factory, gercek `runOnce`):
 *
 *   [repro] runOnce -> 54661437-54671436 events=19
 *   [repro] chain head        = 55438940
 *   [repro] indexer lastBlock = 54671436
 *   [repro] BLOCKS BEHIND     = 767504   (~75 saat zincir zamani)
 *   [repro] stalenessSeconds  = 0.165668
 *   [repro] status.stale      = false          <-- YALAN
 *   [repro] token page would take the FRESH branch (NO notice at all)
 *
 * Yani `Fresh<T>` sozlesmesinin ONLEMEK ICIN VAR OLDUGU sey -- bayat bir sayiyi
 * canli gibi cizmek -- tam olarak gerceklesti, ve sozlesmenin hicbir yeri
 * kirilmadi. Kirilmasi gereken yer TIP DUZEYINDE YOKTU.
 *
 * ================== BU YUZDEN SEKIL DEGISTI, SAYI DEGIL ====================
 *
 * `web/lib/read.ts`in kurali "`result.data` `ok` VE `stale` daraltilmadan
 * derlenmez"di. Ayni disiplin artik YASA da uygulaniyor:
 *
 *   TAZE dal bir `MeasuredSyncPoint` TASIMAK ZORUNDA,
 *   ve `MeasuredSyncPoint` `blocksBehind: bigint` OLMADAN INSA EDILEMEZ.
 *
 * Dolayisiyla "basi hic okumadim ama taze diyorum" bir kod yolu olarak MEVCUT
 * DEGILDIR -- yazilabilen tek sey `{ stale: true, why: 'head-unknown' }`tir.
 * Duz bir `blocksBehind?: bigint` alani bunu vermezdi: unutmak yine derlenirdi,
 * ki bu tam olarak eski `{stale, data}` duz seklinin reddedilme sebebidir.
 *
 * IKI EKSEN DE GEREKLI, ve birbirinin yerine gecmez:
 *   `stalenessSeconds`  surec ekseni. OLU bir indexer eski bir `head_block`
 *                       birakir, yani blok yasi KUCUK gorunur; bunu yakalayan
 *                       tek sey yazma bayatligidir.
 *   `blocksBehind`      veri ekseni. CANLI ama geride bir indexer her turda
 *                       taze yazar; bunu yakalayan tek sey blok yasidir.
 *
 * IKISI DE SUNUCUDAN: `now()` veritabaninin saati, `head_block` indexer'in
 * gordugu bas. Tarayicidan hesaplamak, saati kaymis bir kullaniciya kalici bir
 * uyari gosterirdi (ayni gerekce `StaleNotice`'ta yazili).
 */

/** Indexer'in ulastigi nokta. `headBlock`/`blocksBehind` NULL olabilir. */
export interface SyncPoint {
  lastBlock: bigint
  lastBlockHash: string
  updatedAt: Date
  /**
   * `now() - updated_at`, saniye. Sunucu saatinden.
   *
   * BU BIR CANLILIK OLCUSUDUR, "en son ne zaman VERI yazildi" degil: indexer
   * geri cekilirken de `noteAlive` ile bu damgayi tazeler (bkz. `apply.ts`).
   * Verinin yasi `blocksBehind`tir ve ikisi bilerek ayri kalir -- birlestirmek,
   * saglikli bir indexer'i "durmus" gostermenin ta kendisiydi.
   */
  stalenessSeconds: number
  /** Indexer bu satiri yazarken gordugu bas. `null` = hic yazilmamis. */
  headBlock: bigint | null
  /** `headBlock - lastBlock`. `null` = bas bilinmiyor, yani YAS BILINMIYOR. */
  blocksBehind: bigint | null
}

/**
 * YASI OLCULMUS bir nokta. TAZE dalin tasimak ZORUNDA oldugu sey budur.
 * `blocksBehind` burada `bigint`tir, `bigint | null` degil -- fark, "taze"
 * demenin zincirle karsilastirmis olmayi GEREKTIRMESIDIR.
 */
export interface MeasuredSyncPoint extends SyncPoint {
  headBlock: bigint
  blocksBehind: bigint
}

/**
 * ============ NEDEN bayat -- IKI OLGU, DORT AD, HICBIRI DIGERININ ICINDE ====
 *
 * Ilk hal DORT ad yerine bir SIRA kullaniyordu:
 *
 *   if (writeAge > 30) return 'writes-stalled'
 *   if (blocksBehind > 90) return 'behind-head'
 *
 * ...ve bu, iki BAGIMSIZ olguyu tek bir mesaja cokertiyordu. Olculdu
 * (kompozisyon kosusu, canli): geri cekilme merdiveni yazmayi 30 saniyeden
 * uzun susturunca, **25 sayfa cizimin 25'i** "may have stopped" dedi ve
 * `blocksBehind: 727334` -- AYNI yanitin icinde duran, operatorun ihtiyaci
 * olan tek sayi -- cumleden dusuruldu. Ustelik GERCEKTEN olmus bir indexer
 * de birebir ayni cumleyi uretiyordu: "geri cekiliyorum" ile "durdum" ayni
 * kelimelerle yaziliyordu.
 *
 * Simdi iki olgu AYRI olculur ve KOMBINASYONUN kendi adi vardir. Bir durumun
 * mesaji, baska bir durumdan ULASILABILIR DEGILDIR -- sira meselesi degil,
 * ad meselesi:
 *
 *   `behind-head`         yaziyor (yasiyor), veri eski      -> "yetisiyor"
 *   `writes-stalled`      yazmiyor, veri guncel(e yakin)    -> "durmus olabilir"
 *   `stopped-and-behind`  yazmiyor VE veri eski             -> ikisini de soyler
 *
 * Ve `writes-stalled`in ARTIK saglikli bir indexer'da cikmamasi yapisaldir:
 * `noteAlive` geri cekilme uykusunun icinde atilir (bkz. `apply.ts`), yani
 * susan tek sey gercekten durmus bir surectir.
 */
export type StaleReason =
  'never-ran' | 'head-unknown' | 'writes-stalled' | 'behind-head' | 'stopped-and-behind'

export type IndexerStatus =
  { stale: false; at: MeasuredSyncPoint } | { stale: true; why: StaleReason; at: SyncPoint | null }

/** Sayfanin cizecegi dal. `stalenessOf` bunu dondurur. */
export type StaleIndexer = Extract<IndexerStatus, { stale: true }>
export type FreshIndexer = Extract<IndexerStatus, { stale: false }>

/**
 * SUREC EKSENININ esigi.
 *
 * Arc'ta blok suresi ~350ms ve dongu her turda imleci ilerletir (bos aralikta
 * bile), yani saglikli bir indexer'da `updated_at` saniyeler icinde tazelenir.
 * 30 saniye, gecici bir RPC yavaslamasini alarm yapmayacak kadar genis, bir
 * duraklamayi kullanicidan gizlemeyecek kadar dardir.
 */
export const DEFAULT_STALE_AFTER_SECONDS = 30

/**
 * VERI EKSENININ esigi, ve AYNI 30 SANIYEDIR -- blok cinsinden yazilmis hali.
 *
 * Arc'ta blok suresi ~350ms olculdu, yani 30 saniye ≈ 86 blok; yukari yuvarlanip
 * 90. Iki esik ayni cumleyi soyler ("30 saniyeden eski veri bayattir"), biri
 * duvar saatinde biri zincir saatinde.
 *
 * SAGLIKLI BIR INDEXER BUNU ASMAZ, ve bu bir tahmin degil: `runOnce` basa
 * yetistiginde `range.to === head` olur, yani `blocksBehind` TAM SIFIRDIR;
 * yetismemisken zaten geridedir ve uyari DOGRUDUR. `INDEXER_MAX_SPAN` (1.000)
 * bu esigin uzerinde olmasi bir sorun degil -- bir tur 1.000 blok islese bile
 * turun SONUNDA yazilan sayi "islemden sonra ne kadar geride kaldim"dir.
 */
export const DEFAULT_MAX_BLOCKS_BEHIND = 90n

export interface StaleThresholds {
  staleAfterSeconds?: number
  maxBlocksBehind?: bigint
}

export async function getIndexerStatus(
  db: Queryable,
  thresholds: number | StaleThresholds = {},
): Promise<IndexerStatus> {
  // Sayi gecmek ESKI IMZADIR ve saniye esigi demektir; iki cagiran (ve bir
  // test) onu boyle kullaniyordu, kirmanin bir faydasi yok.
  const staleAfterSeconds =
    typeof thresholds === 'number'
      ? thresholds
      : (thresholds.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS)
  const maxBlocksBehind =
    typeof thresholds === 'number'
      ? DEFAULT_MAX_BLOCKS_BEHIND
      : (thresholds.maxBlocksBehind ?? DEFAULT_MAX_BLOCKS_BEHIND)

  const { rows } = await db.query<{
    last_block: string
    last_block_hash: string
    head_block: string | null
    updated_at: Date
    staleness_seconds: string
  }>(
    `SELECT last_block::text AS last_block, last_block_hash,
            head_block::text AS head_block, updated_at,
            EXTRACT(EPOCH FROM (now() - updated_at))::text AS staleness_seconds
       FROM sync_state WHERE id = 1`,
  )
  const row = rows[0]
  if (row === undefined) {
    // HIC KOSMADI. `stale: true` -- "bilinmiyor"u "taze"ye yuvarlamak, bos bir
    // veritabanini canli gostermek olurdu.
    return { stale: true, why: 'never-ran', at: null }
  }

  // `?? null` -- `=== null` DEGIL. Bir NULL sutun `pg`den `null` gelir, ama
  // sutunu SECMEYEN bir okuyucu (ya da bir cift) `undefined` verir ve
  // `BigInt(undefined)` FIRLATIR; `web/lib/read.ts`in `guard`i onu
  // `unavailable`a cevirir, yani eksik bir sutun butun sayfayi dusururdu.
  // Olculdu: `web/test/read.test.ts`in sahte surucusu tam olarak boyle dustu.
  const headBlock = (row.head_block ?? null) === null ? null : BigInt(row.head_block as string)
  const lastBlock = BigInt(row.last_block)
  const at: SyncPoint = {
    lastBlock,
    lastBlockHash: row.last_block_hash,
    updatedAt: row.updated_at,
    stalenessSeconds: Number(row.staleness_seconds),
    headBlock,
    // Bas imlecin gerisindeyse (olmamali; `setCursor` reddeder) NEGATIF bir
    // "geride" uretmek yerine sifira kirpilir -- eksi bir gecikme ekranda
    // anlamsizdir ve bir hatayi gizler yerine gostermez.
    blocksBehind: headBlock === null ? null : headBlock > lastBlock ? headBlock - lastBlock : 0n,
  }

  // "Bas bilinmiyor" TAZE DEGILDIR ve bu, tipin zaten zorladigi seyin calisma
  // zamanindaki karsiligidir. Yas OLCULEMIYORSA baska hicbir sey soylenemez.
  if (at.blocksBehind === null) return { stale: true, why: 'head-unknown', at }

  // IKI OLGU AYRI OLCULUR. Bir `if` zinciri degil, cunku zincirin ilk dali
  // ikincisini GORUNMEZ yapiyordu -- olculdu: 25 cizimin 25'i "durmus olabilir"
  // dedi ve 727.334 bloklu gecikme cumleden dustu.
  const notWriting = at.stalenessSeconds > staleAfterSeconds
  const behind = at.blocksBehind > maxBlocksBehind

  if (notWriting && behind) return { stale: true, why: 'stopped-and-behind', at }
  if (notWriting) return { stale: true, why: 'writes-stalled', at }
  if (behind) return { stale: true, why: 'behind-head', at }
  return { stale: false, at: at as MeasuredSyncPoint }
}

/**
 * EXPLORE SIRALAMALARI (spec 7.1).
 *
 * Sabit bir nesnedir ve `sort` parametresi onun ANAHTARLARIYLA sinirlidir:
 * siralama ifadesi hicbir zaman kullanici girdisinden birlestirilmez.
 *
 * MIKTAR ANAHTARLARI PAKETLENMISTIR, VE BU BIR DUZELTMEDIR -- OLCULEREK.
 *
 * Onceki hal `market_cap_wei DESC` / `volume_24h_wei DESC` seklinde CIPLAK
 * kolonlardi ve `ordering.test.ts` kaybi SAYIYLA olcmustu: alti hic islem
 * gormemis token AYNI acilis market cap'ini tasir (`admit` onu boyle yazar;
 * testnet profilinde tam `4e18`), yani `limit: 2` ile sayfalayan Explore
 * alti tokenin YALNIZCA IKISINE ulasiyordu -- kalan dordu HICBIR sayfada
 * gorunmuyordu, gec degil HIC. `sort=volume` daha kotuydu: islem gormemis her
 * tokenin hacmi `0`, imlec `0`, kosul `volume_24h_wei < 0`, ve ikinci sayfa
 * BOS donuyordu.
 *
 * Anahtar artik `search_key(<miktar>, created_seq)` (bkz.
 * `migrations/008_search.sql`): `created_seq` `launches` icinde UNIQUE ve
 * negatif degildir, carpan tam olarak `bigint` araliginin genisligidir, yani
 * paketleme BIREBIRDIR ve `anahtar < imlec` tek karsilastirmayla
 * `(miktar, created_seq)` sozluk sirasidir. `searchTokens` bunu zaten
 * kullaniyordu; Explore kullanmiyordu.
 *
 * `_seq` anahtarlari OLDUGU GIBI kalir: her biri tek bir olayin `event_seq`i
 * oldugu icin ZATEN birebirdir ve paketlemek onlara hicbir sey katmazdi.
 *
 * DUZELTMENIN IKINCI YARISI `listTokens`in `nextCursor` DONDURMESIDIR ve
 * ayrilamaz: imleci cagiran tarafta yeniden turetmek (web'in eski `CURSOR_KEY`
 * haritasi) ciplak bir degeri paketlenmis bir anahtarla karsilastirirdi ve
 * sayfayi bugunkunden DAHA cok bozardi.
 */
export const SORTS = {
  recentBuys: { key: 'last_buy_seq', desc: true },
  newest: { key: 'created_seq', desc: true },
  oldest: { key: 'created_seq', desc: false },
  marketCap: { key: 'search_key(market_cap_wei, created_seq)', desc: true },
  volume: { key: 'search_key(volume_24h_wei, created_seq)', desc: true },
} as const

export type SortKey = keyof typeof SORTS

/** Keyset sayfalamanin imleci: siralama anahtarinin son degeri. */
export type Cursor = bigint | null

/**
 * ARAMANIN SIRALAMALARI -- `SORTS`TAN AYRI BIR NESNE, VE IKI SEBEPTEN.
 *
 * 1. `relevance` yalnizca ARAMADA vardir. `SORTS`a eklemek `SortKey`i
 *    genisletirdi ve `SortKey` bu paketin DISINA cikiyor: `web/lib/read.ts`
 *    `Record<SortKey, ...>` seklinde TUKETICI TARAFI TAM bir harita tutuyor,
 *    yani anahtar eklemek baska bir izin sahibinin derlemesini kirardi.
 *
 * 2. ARAMANIN ANAHTARLARI `SORTS`INKILERLE AYNI KURALI IZLER ama IFADELERI
 *    FARKLIDIR: burada tablo `o` takma adiyla gelir (`o.market_cap_wei`) ve
 *    `relevance` yalnizca burada vardir. Iki nesnenin AYRI durmasinin sebebi
 *    budur, tam anahtar ile ciplak anahtar farki DEGIL -- o fark
 *    `search_key` paketlemesi `SORTS`a da inince kapandi.
 *
 * `_seq` anahtarlari OLDUGU GIBI kalir: her biri tek bir olayin `event_seq`i
 * oldugu icin ZATEN birebirdir, ve paketlemek onlara hicbir sey katmazdi.
 *
 * `$1` SORGU METNIDIR ve her cagriyla ayni konumda baglanir; ifadenin icinde
 * gorunmesinin sebebi budur -- degerin kendisi buraya HICBIR ZAMAN
 * birlestirilmez.
 */
const SEARCH_SORTS = {
  relevance: {
    key: 'search_key(search_rank(o.name, o.symbol, $1)::numeric, o.created_seq)',
    desc: true,
  },
  marketCap: { key: 'search_key(o.market_cap_wei, o.created_seq)', desc: true },
  volume: { key: 'search_key(o.volume_24h_wei, o.created_seq)', desc: true },
  recentBuys: { key: 'o.last_buy_seq', desc: true },
  newest: { key: 'o.created_seq', desc: true },
  oldest: { key: 'o.created_seq', desc: false },
} as const

export type SearchSortKey = keyof typeof SEARCH_SORTS

/** Arama siralamalarinin adlari -- `ordering.test.ts` bunun uzerinde doner. */
export const SEARCH_SORT_KEYS = Object.keys(SEARCH_SORTS) as readonly SearchSortKey[]

/** Bir arama siralamasinin SQL ifadesi ve yonu; kapinin okudugu yer. */
export function searchSortExpression(sort: SearchSortKey): { key: string; desc: boolean } {
  return SEARCH_SORTS[sort]
}

export interface TokenOverview {
  token: string
  curve: string
  name: string
  symbol: string
  uri: string
  launchCreator: string
  feeCreator: string
  virtualTokenReservesTok: bigint
  virtualQuoteReservesWei: bigint
  realTokenReservesTok: bigint
  realQuoteReservesWei: bigint
  complete: boolean
  completedSeq: bigint | null
  poolSeedSupplyTok: bigint | null
  /**
   * TERMINAL. `complete` DEGILDIR ve o ayrim tasiyicidir.
   *
   * `complete` -> satis arzi tukendi, curve kapandi, HAVUZ HENUZ ACILMADI.
   * `graduated` -> `R` ve `D` hedefe odendi; asagidaki `marketCapWei` ve
   * `priceWeiPerTok` artik CURVE'UN SON DEGERLERIDIR, canli bir fiyat DEGIL.
   *
   * Iki durum arasinda gercek bir zaman araligi vardir: canli smoke curve'u
   * su an `complete && !graduated` (uretim factory'sinde `graduationTarget`
   * sifir). Arayuz "bu sayi canli mi" sorusunu TEK bir alana bakarak
   * cevaplar; `complete && havuzVar` gibi cagri yerinde kurulan bir bilesim,
   * bu deponun zaten bir kez kaydettigi "iki sitede besteleniyor" kusuru
   * olurdu.
   */
  graduated: boolean
  graduatedSeq: bigint | null
  /** `Graduated.to`. Hedef yeniden isaretlenebilir, bu yuzden ANIN kaydi. */
  graduationTargetAddr: string | null
  /** Hedefe GERCEKTEN odenen token; `poolSeedSupplyTok`tan TURETILMEZ. */
  graduationBaseTok: bigint | null
  /** Hedefe GERCEKTEN odenen quote. */
  graduationQuoteWei: bigint | null
  marketCapWei: bigint
  priceWeiPerTok: bigint
  progressPpm: number
  graduationRaiseWei: bigint
  holderCount: number
  volumeTotalWei: bigint
  volume24hWei: bigint
  athMarketCapWei: bigint
  tradeCount: number
  buyCount: number
  lastTradeSeq: bigint | null
  lastBuySeq: bigint | null
  lastTradeAt: Date | null
  lastBuyAt: Date | null
  createdSeq: bigint
  createdAt: Date
}

interface OverviewRow {
  token: string
  curve: string
  name: string
  symbol: string
  uri: string
  launch_creator: string
  fee_creator: string
  virtual_token_reserves_tok: string
  virtual_quote_reserves_wei: string
  real_token_reserves_tok: string
  real_quote_reserves_wei: string
  complete: boolean
  completed_seq: string | null
  pool_seed_supply_tok: string | null
  graduated: boolean
  graduated_seq: string | null
  graduation_target_addr: string | null
  graduation_base_tok: string | null
  graduation_quote_wei: string | null
  market_cap_wei: string
  price_wei_per_tok: string
  progress_ppm: number
  graduation_raise_wei: string
  holder_count: number
  volume_total_wei: string
  volume_24h_wei: string
  ath_market_cap_wei: string
  trade_count: number
  buy_count: number
  last_trade_seq: string | null
  last_buy_seq: string | null
  last_trade_at: Date | null
  last_buy_at: Date | null
  created_seq: string
  created_at: Date
}

const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v))

function toOverview(row: OverviewRow): TokenOverview {
  return {
    token: row.token,
    curve: row.curve,
    name: row.name,
    symbol: row.symbol,
    uri: row.uri,
    launchCreator: row.launch_creator,
    feeCreator: row.fee_creator,
    virtualTokenReservesTok: BigInt(row.virtual_token_reserves_tok),
    virtualQuoteReservesWei: BigInt(row.virtual_quote_reserves_wei),
    realTokenReservesTok: BigInt(row.real_token_reserves_tok),
    realQuoteReservesWei: BigInt(row.real_quote_reserves_wei),
    complete: row.complete,
    completedSeq: big(row.completed_seq),
    poolSeedSupplyTok: big(row.pool_seed_supply_tok),
    graduated: row.graduated,
    graduatedSeq: big(row.graduated_seq),
    graduationTargetAddr: row.graduation_target_addr,
    graduationBaseTok: big(row.graduation_base_tok),
    graduationQuoteWei: big(row.graduation_quote_wei),
    marketCapWei: BigInt(row.market_cap_wei),
    priceWeiPerTok: BigInt(row.price_wei_per_tok),
    progressPpm: row.progress_ppm,
    graduationRaiseWei: BigInt(row.graduation_raise_wei),
    holderCount: row.holder_count,
    volumeTotalWei: BigInt(row.volume_total_wei),
    volume24hWei: BigInt(row.volume_24h_wei),
    athMarketCapWei: BigInt(row.ath_market_cap_wei),
    tradeCount: row.trade_count,
    buyCount: row.buy_count,
    lastTradeSeq: big(row.last_trade_seq),
    lastBuySeq: big(row.last_buy_seq),
    lastTradeAt: row.last_trade_at,
    lastBuyAt: row.last_buy_at,
    createdSeq: BigInt(row.created_seq),
    createdAt: row.created_at,
  }
}

/** Canli sayilar HER ZAMAN tazelikleriyle birlikte. */
export interface Fresh<T> {
  rows: T
  indexer: IndexerStatus
}

export interface ListTokensOptions {
  sort?: SortKey
  /** Yas filtresi: yalnizca son `ageDays` gunde acilanlar. PENCERE, siralama degil. */
  ageDays?: number
  cursor?: Cursor
  limit?: number
}

/** Explore listesinin sonucu: satirlar, SORGUNUN KENDI hesapladigi imlec, tazelik. */
export interface ListResult {
  rows: TokenOverview[]
  /**
   * Bir sonraki sayfanin imleci; sayfa KISAYSA `null`.
   *
   * SORGUDAN doner, cagiran tarafta YENIDEN TURETILMEZ -- ve bu, `SORTS`in
   * paketlenmesinden AYRILAMAZ. Eski hal `web/lib/read.ts`teki `CURSOR_KEY`
   * haritasiydi: `marketCap` icin `r.marketCapWei` dondururdu, yani sorgunun
   * ORDER BY ifadesi ile TypeScript'teki bir lambda AYNI seyi iki kez anlatir
   * ve sessizce ayrisirdi. `search_key(...)` ile paketlenmis bir anahtarin
   * degeri ZATEN TypeScript'te yeniden hesaplanamaz.
   */
  nextCursor: bigint | null
  indexer: IndexerStatus
}

/**
 * EXPLORE listesi, keyset sayfalamayla.
 *
 * `ageDays` bir PENCEREDIR ve `created_at` uzerindedir; siralama yine
 * `created_seq`/`search_key(market_cap_wei, created_seq)` gibi bir
 * seq/paketlenmis-miktar anahtarindadir. Zamanin pencerede kullanilmasi
 * guvenlidir (esitlik siralamayi degil kumeyi etkiler), SIRALAMADA
 * kullanilmasi degildir.
 *
 * TEK IFADE UC ISI GORUR -- `ORDER BY`, imlec suzgeci ve donen `nextCursor`
 * hep `SORTS[sort].key`tir, yani ucu sessizce ayrisamaz. `searchTokens` ayni
 * sekli tasir.
 */
export async function listTokens(
  db: Queryable,
  options: ListTokensOptions = {},
): Promise<ListResult> {
  const sort: SortKey = options.sort ?? 'newest'
  const { key, desc } = SORTS[sort]
  const order = `${key} ${desc ? 'DESC' : 'ASC'}`
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const cursor = options.cursor ?? null

  const where: string[] = []
  const params: unknown[] = []
  if (sort === 'recentBuys') where.push('last_buy_seq IS NOT NULL')
  if (options.ageDays !== undefined) {
    params.push(options.ageDays)
    where.push(`created_at >= now() - ($${params.length}::int * interval '1 day')`)
  }
  if (cursor !== null) {
    params.push(cursor.toString())
    where.push(`${key} ${desc ? '<' : '>'} $${params.length}::numeric`)
  }
  params.push(limit)

  const { rows } = await db.query<OverviewRow & { cursor_key: string | null }>(
    `SELECT *, (${key})::text AS cursor_key FROM token_overview
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${order} LIMIT $${params.length}`,
    params,
  )

  // KISA SAYFA SON SAYFADIR (`searchTokens` ile ayni kural, ayni gerekce).
  const last = rows[rows.length - 1]
  const nextCursor =
    rows.length < limit || last === undefined || last.cursor_key === null
      ? null
      : BigInt(last.cursor_key)

  return { rows: rows.map(toOverview), nextCursor, indexer: await getIndexerStatus(db) }
}

/**
 * `LIKE` DESENI. SORGU METNI BURADA, TEK BIR YERDE HAZIRLANIR.
 *
 * `%` ve `_` `LIKE`in JOKERLERIDIR. Kacislanmadan gecirilirse kullanicinin
 * yazdigi tek bir `%` HER SATIRI dondururdu (olculdu: `'x' LIKE '%' || '%' ||
 * '%'` -> true, kacislanmis hali -> false) -- yani sonuc listesi sorguyla
 * ilgisiz hale gelir ve arama, veritabanini tam tarama yaptiran ucuz bir kola
 * doner.
 *
 * UC KARAKTER DE TEK BIR GECISTE kacislanir (`\`, `%`, `_`). Iki ayri
 * `replace` yazmak, ters bolunun ONCE gelmesini zorunlu kilardi -- yoksa
 * ikinci tur kendi urettigimiz kacis isaretlerini yeniden kacislardi. Tek
 * gecis kendi ciktisini TARAMADIGI icin o sira sorusu hic dogmaz; sekli
 * secmenin sebebi budur.
 *
 * KACIS KARAKTERI ACIKCA YAZILMAZ (`ESCAPE '\'` YOK) ve bu bilerek: ters bolu
 * `LIKE`in VARSAYILAN kacis karakteridir, ve `ESCAPE '\'` yazmak sorgu metnine
 * bir ters bolu LITERALI koyardi -- `standard_conforming_strings` kapali bir
 * sunucuda o literal kapanis tirnagini kacislar ve sorgu SOZDIZIMI HATASI
 * verir. Varsayilana yaslanmak, davranisi ayni tutup o ariza kipini hic
 * yaratmaz.
 *
 * BU BIR SQL ENJEKSIYONU SAVUNMASI DEGILDIR ve oyle okunmamali: dize her
 * zaman BAGLI BIR PARAMETREDIR, hicbir zaman sorgu metnine girmez. Burada
 * kapatilan sey ANLAM kaymasi -- desen dilinin, kullanicinin duz metin
 * sandigi seye karismasi.
 */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** Aramanin sonucu: satirlar, SORGUNUN KENDI hesapladigi imlec, ve tazelik. */
export interface SearchResult {
  rows: TokenOverview[]
  /**
   * Bir sonraki sayfanin imleci; sayfa KISAYSA `null`.
   *
   * SORGUDAN doner, cagiran tarafta YENIDEN TURETILMEZ. Gerekce yapisal:
   * `relevance` anahtari `similarity()` uzerinden hesaplanir ve TypeScript'te
   * yeniden hesaplanamaz; hesaplanabilseydi bile iki ifadenin sessizce
   * ayrismasi icin acik bir kapi olurdu (`web/lib/read.ts`'in `CURSOR_KEY`
   * haritasi tam olarak o kapidir).
   */
  nextCursor: bigint | null
  indexer: IndexerStatus
}

export interface SearchTokensOptions {
  sort?: SearchSortKey
  ageDays?: number
  cursor?: Cursor
  limit?: number
}

/**
 * ⌘K ARAMASI: ad/sembol uzerinde metin eslesmesi + TAM sirali keyset sayfalama.
 *
 * SUZGEC IKI YOLLUDUR ve ikisi de gereklidir:
 *   ILIKE '%q%'  ALT DIZGE. Kullanicilar ON EK yazar ve trigram esigi kisa on
 *                ekleri KACIRIR -- olculdu: 'smo' ile 'SMOKESCREEN'in
 *                benzerligi 0,231'dir, varsayilan 0,3 esiginin ALTINDA, yani
 *                yalnizca `%` operatoru kullanilsa o token hic gorunmezdi.
 *   name % q     BULANIK. Yazim hatasini ve harf sirasi kaymasini yakalar;
 *                alt dizge eslesmesinin YAPAMADIGI sey budur.
 * Ikisi de `gin_trgm_ops` indekslerinden yararlanir (008).
 *
 * BOS `q` OZEL DURUM DEGILDIR ve bilerek oyle birakildi: desen `%%` olur (her
 * satir), `similarity(x, '')` `0` doner (olculdu), yani `relevance` anahtari
 * `0 * 2^63 + created_seq`e -- yani TAM OLARAK `newest`e -- dejenere olur.
 * Ozel bir dal yazmak, hicbir seyin egzersiz etmedigi bir kod yolu eklerdi.
 */
export async function searchTokens(
  db: Queryable,
  q: string,
  options: SearchTokensOptions = {},
): Promise<SearchResult> {
  const sort: SearchSortKey = options.sort ?? 'relevance'
  const { key, desc } = SEARCH_SORTS[sort]
  const order = `${key} ${desc ? 'DESC' : 'ASC'}`
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const cursor = options.cursor ?? null

  // $1 SORGU METNI, $2 DESEN. Konumlari SABITTIR: `SEARCH_SORTS`in ifadeleri
  // `$1`i adiyla anar, yani numaralandirma kaymasi derhal yanlis sonuc verirdi.
  const params: unknown[] = [q, likePattern(q)]
  const where: string[] = ['(o.name ILIKE $2 OR o.symbol ILIKE $2 OR o.name % $1 OR o.symbol % $1)']
  if (sort === 'recentBuys') where.push('o.last_buy_seq IS NOT NULL')
  if (options.ageDays !== undefined) {
    params.push(options.ageDays)
    where.push(`o.created_at >= now() - ($${params.length}::int * interval '1 day')`)
  }
  if (cursor !== null) {
    params.push(cursor.toString())
    where.push(`${key} ${desc ? '<' : '>'} $${params.length}::numeric`)
  }
  params.push(limit)

  const { rows } = await db.query<OverviewRow & { cursor_key: string | null }>(
    `SELECT o.*, (${key})::text AS cursor_key
       FROM token_overview o
      WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT $${params.length}`,
    params,
  )

  // KISA SAYFA SON SAYFADIR. `null` donmek, tuketiciye "daha fazlasi yok"
  // demenin tek dogru yoludur; dolu bir sayfada ise imlec SON satirin kendi
  // anahtaridir, yani bir sonraki sayfa tam olarak onun ardindan baslar.
  const last = rows[rows.length - 1]
  const nextCursor =
    rows.length < limit || last === undefined || last.cursor_key === null
      ? null
      : BigInt(last.cursor_key)

  return { rows: rows.map(toOverview), nextCursor, indexer: await getIndexerStatus(db) }
}

export async function getTokenOverview(
  db: Queryable,
  token: Address,
): Promise<Fresh<TokenOverview | null>> {
  const { rows } = await db.query<OverviewRow>('SELECT * FROM token_overview WHERE token = $1', [
    lower(token),
  ])
  const row = rows[0]
  return {
    rows: row === undefined ? null : toOverview(row),
    indexer: await getIndexerStatus(db),
  }
}

export interface TradeRow {
  eventSeq: bigint
  txHash: string
  blockTime: Date
  trader: string
  isBuy: boolean
  tokenAmountTok: bigint
  quoteAmountWei: bigint
  /**
   * UCRET PARCALARI. AYRI AYRI donerler ve TOPLANMIS bir alan YOKTUR:
   * ucret `feeOn(q,95) + feeOn(q,30)`tir, `feeOn(q,125)` DEGIL, ve fark canli
   * zincirde olculdu (ticaret #1'de bir wei). Toplami burada hesaplayip tek
   * alan olarak donmek, o farki gizleyen bir yol acardi.
   *
   * Tuketici icin ANLAMI: bir alicinin cuzdanindan cikan tutar
   * `quoteAmountWei + protocolFeeWei + creatorFeeWei`, satista ise giren tutar
   * `quoteAmountWei - protocolFeeWei - creatorFeeWei`. Bu hesap ancak parcalar
   * gorunurse yapilabilir.
   */
  protocolFeeWei: bigint
  creatorFeeWei: bigint
  /**
   * ISLEM SONRASI DORT REZERV. `Trade` dordunu de tasir (BondingCurve.sol
   * :133-135) ve `trades` onlari AYNEN saklar, yani her ticaretin ANINDAKI
   * fiyati zincire tekrar sorulmadan turetilebilir:
   *   gerceklesen fiyat = quote/token, o andaki isaret fiyati = vQ/vT.
   * Bunlar olmadan bir fiyat grafigi ancak rezervleri yeniden oynatarak
   * kurulabilirdi.
   */
  virtualTokenReservesTok: bigint
  virtualQuoteReservesWei: bigint
  realTokenReservesTok: bigint
  realQuoteReservesWei: bigint
  /** `trader` O ANDAKI ucret creator'i mi. NOKTASAL -- guncel creator'a gore degil. */
  isDev: boolean
}

/**
 * Bir token'in islemleri, EN YENIDEN eskiye.
 *
 * `is_dev` `creator_at(token, event_seq)` ile NOKTASAL hesaplanir. Guncel
 * creator'a duz bir JOIN, bir devirden sonra devirden ONCEKI islemleri yanlis
 * etiketlerdi -- bugun creator degistirilemez oldugu icin fark GORUNMEZ, ve
 * tam da bu yuzden yol bugunden sentetik bir devirle test edilir.
 */
export async function listTrades(
  db: Queryable,
  token: Address,
  options: { cursor?: Cursor; limit?: number } = {},
): Promise<TradeRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const cursor = options.cursor ?? null
  const { rows } = await db.query<{
    event_seq: string
    tx_hash: string
    block_time: Date
    trader: string
    is_buy: boolean
    token_amount_tok: string
    quote_amount_wei: string
    protocol_fee_wei: string
    creator_fee_wei: string
    virtual_token_reserves_tok: string
    virtual_quote_reserves_wei: string
    real_token_reserves_tok: string
    real_quote_reserves_wei: string
    is_dev: boolean
  }>(
    `SELECT t.event_seq::text AS event_seq, t.tx_hash, t.block_time, t.trader, t.is_buy,
            t.token_amount_tok::text AS token_amount_tok,
            t.quote_amount_wei::text AS quote_amount_wei,
            t.protocol_fee_wei::text AS protocol_fee_wei,
            t.creator_fee_wei::text AS creator_fee_wei,
            t.virtual_token_reserves_tok::text AS virtual_token_reserves_tok,
            t.virtual_quote_reserves_wei::text AS virtual_quote_reserves_wei,
            t.real_token_reserves_tok::text AS real_token_reserves_tok,
            t.real_quote_reserves_wei::text AS real_quote_reserves_wei,
            t.trader = creator_at(t.token, t.event_seq) AS is_dev
       FROM trades t
      WHERE t.token = $1 AND ($2::bigint IS NULL OR t.event_seq < $2)
      ORDER BY t.event_seq DESC LIMIT $3`,
    [lower(token), cursor === null ? null : cursor.toString(), limit],
  )
  return rows.map((r) => ({
    eventSeq: BigInt(r.event_seq),
    txHash: r.tx_hash,
    blockTime: r.block_time,
    trader: r.trader,
    isBuy: r.is_buy,
    tokenAmountTok: BigInt(r.token_amount_tok),
    quoteAmountWei: BigInt(r.quote_amount_wei),
    protocolFeeWei: BigInt(r.protocol_fee_wei),
    creatorFeeWei: BigInt(r.creator_fee_wei),
    virtualTokenReservesTok: BigInt(r.virtual_token_reserves_tok),
    virtualQuoteReservesWei: BigInt(r.virtual_quote_reserves_wei),
    realTokenReservesTok: BigInt(r.real_token_reserves_tok),
    realQuoteReservesWei: BigInt(r.real_quote_reserves_wei),
    isDev: r.is_dev,
  }))
}

export interface HolderRow {
  holder: string
  balanceTok: bigint
}

/**
 * HOLDER IMLECI IKI PARCALIDIR, VE BU BIR ZORUNLULUK.
 *
 * Siralama `balance_tok DESC, holder ASC`tir. Tek basina `balance_tok` bir
 * imlec OLAMAZ: bakiyeler tekrar eder, ve en cok tekrar ettikleri yer bir
 * listenin KUYRUGUDUR -- ayni airdrop'tan ayni miktari alan yuzlerce cuzdan
 * tam olarak oradadir. Esit anahtarla keyset sayfalama satir TEKRARLATIR VE
 * ATLATIR. `holder` ise `(token, holder)` birincil anahtarinin bir parcasidir,
 * yani TEK BIR token icinde BIREBIRDIR; ikisi birlikte TAM sira verir.
 *
 * PAKETLENMEZ (aramanin `search_key`i gibi), cunku ikinci anahtar bir SAYI
 * DEGIL bir ADRESTIR; tek bir tamsayiya sikistirmak 76 basamakli bir imlec
 * uretirdi ve okunurlugunu tumden kaybederdi.
 */
export interface HolderCursor {
  balanceTok: bigint
  holder: string
}

/** Tel uzerindeki bicim: `<bakiye>:<holder>`. */
export function encodeHolderCursor(row: HolderCursor): string {
  return `${row.balanceTok.toString()}:${lower(row.holder as Address)}`
}

/**
 * Imleci COZER; bicimsiz bir deger ILK SAYFADIR, hata degil.
 *
 * Imlec URL'den gelir. Bozuk bir imlece 500 donmek ya da SQL'e bozuk bir deger
 * gecirmek, kullanicinin yapistirdigi bir baglantinin uygulamayi kirmasi
 * demektir; `null` donmek onu listenin basina goturur. Ayni durus
 * `web/lib/read.ts`'in `parseCursor`inda da var.
 */
export function parseHolderCursor(value: string | null | undefined): HolderCursor | null {
  if (value === null || value === undefined || value === '') return null
  const match = /^(\d{1,78}):(0x[0-9a-f]{40})$/.exec(value)
  if (match === null) return null
  return { balanceTok: BigInt(match[1] as string), holder: match[2] as string }
}

/**
 * Holder listesi. CURVE HARIC TUTULUR.
 *
 * `LaunchToken` tum arzi constructor'da curve'e basar, yani curve her zaman en
 * buyuk "holder"dir ve listenin basinda otururdu -- hicbir kullanicinin
 * elinde olmayan bir bakiye. `token_stats.holder_count` de ayni sebeple onu
 * saymaz; iki taraf ayni seyi soylemeli.
 *
 * IMLEC SATIRIN KENDI ALANLARINDAN kurulur (`encodeHolderCursor(sonSatir)`),
 * bir ifadenin yeniden hesaplanmasindan DEGIL -- yani aramada kacinilan
 * "iki ifade sessizce ayrisir" tehlikesi burada YOKTUR: `balanceTok` ve
 * `holder` zaten donen satirin ta kendisidir.
 */
export async function listHolders(
  db: Queryable,
  token: Address,
  options: { after?: HolderCursor | null; limit?: number } = {},
): Promise<HolderRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const after = options.after ?? null
  // KARISIK YONLU SIRA, SATIR-DEGERI KARSILASTIRMASIYLA YAZILAMAZ:
  // `(balance_tok, holder) < ($2,$3)` yalnizca IKI anahtar da DESC olsaydi
  // dogru olurdu. Yon `DESC, ASC` oldugu icin sart ACIKCA yazilir. Esitlik
  // `numeric(78,0)` uzerinde TAM'dir, yani ikinci dal kacirilamaz.
  const { rows } = await db.query<{ holder: string; balance_tok: string }>(
    `SELECT h.holder, h.balance_tok::text AS balance_tok
       FROM holders h
       JOIN curve_state c ON c.token = h.token
      WHERE h.token = $1 AND h.balance_tok > 0 AND h.holder <> c.curve
        AND ($2::numeric IS NULL
             OR h.balance_tok < $2::numeric
             OR (h.balance_tok = $2::numeric AND h.holder > $3::text))
      ORDER BY h.balance_tok DESC, h.holder ASC LIMIT $4`,
    [
      lower(token),
      after === null ? null : after.balanceTok.toString(),
      after === null ? null : after.holder,
      limit,
    ],
  )
  return rows.map((r) => ({ holder: r.holder, balanceTok: BigInt(r.balance_tok) }))
}

/** "Kim baslatti" -- `launches.launch_creator`, ucret alicisi DEGIL. */
export async function listLaunchesByCreator(
  db: Queryable,
  creator: Address,
  options: { limit?: number } = {},
): Promise<TokenOverview[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const { rows } = await db.query<OverviewRow>(
    `SELECT * FROM token_overview WHERE launch_creator = $1
      ORDER BY created_seq DESC LIMIT $2`,
    [lower(creator), limit],
  )
  return rows.map(toOverview)
}

export interface ClaimableFees {
  recipient: string
  claimableWei: bigint
  depositedTotalWei: bigint
  claimedTotalWei: bigint
}

/**
 * Bir alicinin cekilebilir ucreti.
 *
 * ESCROW'UN BAKIYESINI DONDUREN BIR FONKSIYON YOKTUR ve bu bir eksiklik degil
 * KARARDIR: `FeeEscrow`'un NatSpec'i (kisit 1) escrow bakiyesinin `deposit()`
 * DISINDAN da artabilecegini kaydediyor (`USDC.transfer(escrow, x)` basarili
 * olur, `receive()` hic calismaz) ve o para TALEP EDILEMEZ. Yani bakiye,
 * cekilebilir ucretin UST siniridir; onu "cekilebilir" diye gostermek
 * kullaniciya cekemeyecegi bir rakam gostermektir.
 */
export async function getClaimableFees(
  db: Queryable,
  recipient: Address,
): Promise<ClaimableFees | null> {
  const { rows } = await db.query<{
    recipient: string
    claimable_wei: string
    deposited_total_wei: string
    claimed_total_wei: string
  }>(
    `SELECT recipient, claimable_wei::text AS claimable_wei,
            deposited_total_wei::text AS deposited_total_wei,
            claimed_total_wei::text AS claimed_total_wei
       FROM fee_balances WHERE recipient = $1`,
    [lower(recipient)],
  )
  const row = rows[0]
  if (row === undefined) return null
  return {
    recipient: row.recipient,
    claimableWei: BigInt(row.claimable_wei),
    depositedTotalWei: BigInt(row.deposited_total_wei),
    claimedTotalWei: BigInt(row.claimed_total_wei),
  }
}

export interface CreatorEarning {
  token: string
  symbol: string
  earnedWei: bigint
}

/**
 * Creator'in LAUNCH BASINA kazanci.
 *
 * Yalnizca `fee_events.from_addr` sayesinde mumkundur: `Deposited.from`
 * yatiran CURVE'dur ve ucretin hangi launch'tan geldigi baska HICBIR yerde
 * yazili degildir.
 */
export async function listCreatorEarningsByLaunch(
  db: Queryable,
  recipient: Address,
): Promise<CreatorEarning[]> {
  const { rows } = await db.query<{ token: string; symbol: string; earned_wei: string }>(
    `SELECT l.token, l.symbol, sum(f.amount_wei)::text AS earned_wei
       FROM fee_events f
       JOIN curve_state c ON c.curve = f.from_addr
       JOIN launches l ON l.token = c.token
      WHERE f.kind = 'deposit' AND f.recipient = $1
      GROUP BY l.token, l.symbol
      ORDER BY sum(f.amount_wei) DESC, l.token ASC`,
    [lower(recipient)],
  )
  return rows.map((r) => ({
    token: r.token,
    symbol: r.symbol,
    earnedWei: BigInt(r.earned_wei),
  }))
}
