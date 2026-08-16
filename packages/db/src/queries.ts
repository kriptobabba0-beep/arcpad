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
  /**
   * ZINCIRIN BASI, VE O GOZLEMIN KENDI YASI. Bkz. `HeadObservation`.
   *
   * Duz bir `blocksBehind: bigint | null` alani BIR KEZ DENENDI ve TAM OLARAK
   * BU YUZDEN YETMEDI: sayi vardi, YASI yoktu, ve donmus bir gozlemden gelen
   * `0` ile taze olculmus bir `0` ayirt edilemiyordu.
   */
  head: HeadObservation
}

/**
 * ============ BIR OLCUM, KENDI YASIYLA BIRLIKTE ============
 *
 * OLCULDU (canli, basa yetismis bir indexer merdivene girdiginde, 11 ardisik
 * cizim): sayfa **11/11 TAZE dalini** secti ve HICBIR uyari cizmedi; gercek
 * gecikme 0'dan 120 bloga cikti (90 esiginin ustu), rapor edilen `blocksBehind`
 * ise 0'da DONDU. Sifir "olculdu" degil "kaldi"ydi.
 *
 * Sebep tam olarak sudur: `noteAlive` `updated_at`i tazeler ama `head_block`a
 * DOKUNMAZ, yani `c26c065`ten sonra iki eksen de bagimsizca "saglikli"
 * diyebiliyordu -- biri gercekten taze oldugu icin, oteki DONDUGU icin.
 *
 * Care dorduncu bir `if` DEGIL: olculmemis durumu TEMSIL EDILEMEZ yapmak.
 * `blocksBehind` YALNIZCA `measured: true` dalinda vardir; olculmemis dalda
 * alanin ADI BILE farklidir (`lastKnownBlocksBehind`), yani daraltmayi unutan
 * bir tuketici DERLENMEZ. Ayni oyun `data`/`staleData` ile bir seviye yukarida
 * oynaniyor ve C1'in tutmasinin sebebi oydu.
 */
export type HeadObservation =
  | {
      readonly measured: true
      readonly headBlock: bigint
      /** `headBlock - lastBlock`, GOZLEM TAZEYKEN. */
      readonly blocksBehind: bigint
      /** Bu gozlemin yasi. Taze oldugu ISPATLANMIS haldedir. */
      readonly observedSecondsAgo: number
    }
  | {
      readonly measured: false
      readonly why: 'never-observed' | 'observation-stale'
      readonly headBlock: bigint | null
      /**
       * SON BILINEN gecikme -- BIR ALT SINIR, guncel bir olcum DEGIL. Adi
       * `blocksBehind` DEGIL, ve bu bilincli: iki alan ayni adi tasisaydi,
       * daraltmayi unutan kod eskisi gibi derlenirdi.
       */
      readonly lastKnownBlocksBehind: bigint | null
      readonly lastObservedSecondsAgo: number | null
    }

export type MeasuredHead = Extract<HeadObservation, { measured: true }>

/**
 * YASI OLCULMUS bir nokta. TAZE dalin tasimak ZORUNDA oldugu sey budur.
 * `head` burada `MeasuredHead`tir -- yani "taze" demek, zincirin basiyla
 * karsilastirmis OLMAYI ve o karsilastirmanin TAZE olmasini birlikte
 * gerektirir.
 */
export interface MeasuredSyncPoint extends SyncPoint {
  head: MeasuredHead
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
  | 'never-ran'
  | 'head-unknown'
  /**
   * INDEXER YASIYOR AMA ZINCIRIN BASINA BAKAMIYOR (tipik olarak bir hiz
   * siniri merdiveninin icinde). Gecikme OLCULEMEZ, ve olculemeyen bir
   * gecikme TAZE DEGILDIR. Bu durum bir sure hicbir ada sahip degildi ve
   * sonucu, sayfanin hicbir uyari cizmemesiydi.
   */
  | 'head-stale'
  | 'writes-stalled'
  | 'behind-head'
  | 'stopped-and-behind'

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

/**
 * UCUNCU EKSEN: GOZLEMIN kendi yasi, ve yine AYNI 30 SANIYE.
 *
 * `head_block` her ilerleyen aralikta ve her bos turda tazelenir (saniyeler),
 * ve YALNIZCA indexer zincire bakamadiginda donar -- yani bir hiz siniri
 * merdiveninin icinde. 30 saniyeden eski bir gozlemden hesaplanan gecikme bir
 * OLCUM degil bir HATIRADIR, ve hatira "taze" diyemez.
 */
export const DEFAULT_HEAD_STALE_AFTER_SECONDS = 30

export interface StaleThresholds {
  staleAfterSeconds?: number
  maxBlocksBehind?: bigint
  headStaleAfterSeconds?: number
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

  const headStaleAfterSeconds =
    typeof thresholds === 'number'
      ? DEFAULT_HEAD_STALE_AFTER_SECONDS
      : (thresholds.headStaleAfterSeconds ?? DEFAULT_HEAD_STALE_AFTER_SECONDS)

  const { rows } = await db.query<{
    last_block: string
    last_block_hash: string
    head_block: string | null
    updated_at: Date
    staleness_seconds: string
    head_age_seconds: string | null
  }>(
    // IKI YAS, IKI AYRI SUTUNDAN, IKISI DE SUNUCUNUN SAATINDEN. Tek bir
    // `updated_at`ten ikisini birden turetmek, tam olarak duzeltilen kusurdur.
    `SELECT last_block::text AS last_block, last_block_hash,
            head_block::text AS head_block, updated_at,
            EXTRACT(EPOCH FROM (now() - updated_at))::text AS staleness_seconds,
            EXTRACT(EPOCH FROM (now() - head_observed_at))::text AS head_age_seconds
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
  const headAgeSeconds =
    (row.head_age_seconds ?? null) === null ? null : Number(row.head_age_seconds)
  // Bas imlecin gerisindeyse (olmamali; `setCursor` reddeder) NEGATIF bir
  // "geride" uretmek yerine sifira kirpilir -- eksi bir gecikme ekranda
  // anlamsizdir ve bir hatayi gizler yerine gostermez.
  const lag = headBlock === null ? null : headBlock > lastBlock ? headBlock - lastBlock : 0n

  /**
   * GOZLEM YA OLCUMDUR YA DEGILDIR, VE UCUNCU HALI YOKTUR.
   *
   * Uc sart birden: bas yazilmis, ne zaman yazildigi yazilmis, ve o an
   * YETERINCE YAKIN. Herhangi biri eksikse `measured: false` -- ve o dalda
   * `blocksBehind` diye bir alan YOKTUR, yani asagidaki mantik onu okumayi
   * bile deneyemez.
   */
  const head: HeadObservation =
    headBlock === null || headAgeSeconds === null || lag === null
      ? {
          measured: false,
          why: 'never-observed',
          headBlock,
          lastKnownBlocksBehind: lag,
          lastObservedSecondsAgo: headAgeSeconds,
        }
      : headAgeSeconds > headStaleAfterSeconds
        ? {
            measured: false,
            why: 'observation-stale',
            headBlock,
            lastKnownBlocksBehind: lag,
            lastObservedSecondsAgo: headAgeSeconds,
          }
        : {
            measured: true,
            headBlock,
            blocksBehind: lag,
            observedSecondsAgo: headAgeSeconds,
          }

  const at: SyncPoint = {
    lastBlock,
    lastBlockHash: row.last_block_hash,
    updatedAt: row.updated_at,
    stalenessSeconds: Number(row.staleness_seconds),
    head,
  }

  const notWriting = at.stalenessSeconds > staleAfterSeconds
  // SON BILINEN gecikme, olculmus olsun olmasin. Bir surec DURDUYSA gecikmesi
  // zaten yalnizca son gozleminden bilinebilir; onu cumleden dusurmek N2'nin
  // ta kendisiydi.
  const lastKnownBehind = head.measured ? head.blocksBehind : head.lastKnownBlocksBehind

  // DURMUS OLMAK EN UST OLGUDUR: gecikmeyi olcemiyor olmamiz onu degistirmez,
  // ve "durdu" cumlesi son bilinen gecikmeyi zaten TASIR.
  if (notWriting) {
    return lastKnownBehind !== null && lastKnownBehind > maxBlocksBehind
      ? { stale: true, why: 'stopped-and-behind', at }
      : { stale: true, why: 'writes-stalled', at }
  }

  // YAZIYOR AMA GECIKME OLCULEMIYOR. Bu, dorduncu durumdur ve bir sure hicbir
  // ada sahip degildi -- sonucu, TAZE dalini secip hicbir uyari cizmemekti
  // (olculdu: 11/11 cizim, gercek gecikme 0 -> 120 blok).
  if (!head.measured) {
    return { stale: true, why: head.why === 'never-observed' ? 'head-unknown' : 'head-stale', at }
  }

  if (head.blocksBehind > maxBlocksBehind) return { stale: true, why: 'behind-head', at }
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
  /**
   * GRADUATION'A EN YAKIN ONCE.
   *
   * `progress_ppm` MILYONDA PAYDIR ve `search_key` ile paketlenir, tipki
   * market cap ve hacim gibi: paketlenmemis bir imlec iki token ayni ppm'e
   * sahip oldugunda (ki bir bonding curve'de siklikla olur -- ayni miktar
   * toplanmis iki curve ayni yerdedir) sayfa sinirinda birini ATLAR.
   *
   * TAMAMLANMISLAR DISARIDA BIRAKILMAZ. "Graduation'a yakin" listesinin en
   * ustunde %100'e varmis olanin durmasi DOGRUDUR: o, sirada bekleyen ilk
   * adaydir. Onu suzmek, listenin adini "graduation'a yakin ama varmamis"
   * yapardi ve kullanicinin aradigi satiri gizlerdi.
   */
  nearGraduation: { key: 'search_key(progress_ppm::numeric, created_seq)', desc: true },
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
  /**
   * CREATOR TAAHHUDU, LISTE SEVIYESINDE.
   *
   * `buyback_state` YOKSA `false` -- yani "hic olmadi" ile "kapatildi" burada
   * AYNI gorunur, ve bu bilinclidir: ayrim token sayfasina aittir
   * (`getTokenBuyback` biri icin `null`, oteki icin `enabled: false` doner).
   * Bir kart rozetinin tasiyabilecegi nuans "acik mi"dir.
   */
  buybackEnabled: boolean
  /** Kasadaki kumulatif kilit; buyback yoksa `0`. */
  buybackLockedTok: bigint
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
  buyback_enabled: boolean
  buyback_locked_tok: string
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
    buybackEnabled: row.buyback_enabled,
    buybackLockedTok: BigInt(row.buyback_locked_tok),
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
  /**
   * NUMARALI SAYFA ICIN OFFSET -- ve `cursor` ile BIRLIKTE VERILEMEZ.
   *
   * Ikisi ayni soruyu iki farkli garantiyle cevaplar. `cursor` "su anahtardan
   * sonrasi"dir ve araya giren yazimlardan etkilenmez; `offset` "bastan N
   * satir atla"dir ve CANLI bir siralama anahtarinda satir tekrarlatir ya da
   * atlatir -- iki sorgu arasinda bir alim gelirse butun liste bir kayar.
   *
   * Yine de var, cunku urun numarali sayfa istiyor (1 2 3 …) ve numarali
   * sayfa OFFSET'siz dogru yapilamaz. Bedeli su siralamalarda gercektir:
   * `recentBuys`, `marketCap`, `volume`, `nearGraduation`. `newest` ve
   * `oldest`te YOKTUR: `created_seq` bir daha degismez, yani o iki sekmede
   * numarali sayfalama tam olarak dogrudur.
   *
   * Ikisi birden verilirse fonksiyon REDDEDER. Sessizce birini secmek,
   * cagiran tarafin hangi garantiyi aldigini bilmemesi demektir.
   */
  offset?: number
  /**
   * `true` ise sonuc `total` tasir: ayni `WHERE` ile bir `COUNT(*)`.
   *
   * Opsiyonel, cunku bedeli var: sayim TAM tabloyu tarar ve numarali sayfa
   * disinda kimsenin ihtiyaci yok. `KeysetPager` toplami zaten opsiyonel
   * gosteriyordu; simdi onu VEREBILEN bir yol var.
   */
  withTotal?: boolean
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
  /**
   * Filtreye uyan TOPLAM satir sayisi -- yalnizca `withTotal: true` istenmisse.
   *
   * ALANIN VAR OLMAMASI ILE SIFIR OLMASI AYRI SEYLERDIR ve bu yuzden
   * opsiyonel: `0` "filtreye uyan hicbir sey yok"tur, `undefined` ise
   * "sayilmadi". Ikisini birlestirmek, numarali sayfalayiciya sayilmamis bir
   * listeyi "bos" diye gosterirdi.
   */
  total?: number
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
  const offset = options.offset ?? null

  // IKI SAYFALAMA GARANTISI KARISTIRILAMAZ. Bkz. `ListTokensOptions.offset`.
  if (cursor !== null && offset !== null) {
    throw new Error(
      'listTokens: `cursor` and `offset` are different pagination guarantees and cannot be ' +
        'combined. Pick one: `cursor` is stable under concurrent writes, `offset` is what ' +
        'numbered pages need.',
    )
  }
  if (offset !== null && (!Number.isInteger(offset) || offset < 0)) {
    throw new RangeError(`listTokens: offset must be a non-negative integer, got ${offset}`)
  }

  const where: string[] = []
  const params: unknown[] = []
  if (sort === 'recentBuys') where.push('last_buy_seq IS NOT NULL')
  if (options.ageDays !== undefined) {
    params.push(options.ageDays)
    where.push(`created_at >= now() - ($${params.length}::int * interval '1 day')`)
  }
  // SAYIM, `LIMIT`/`OFFSET` PARAMETRELERI EKLENMEDEN ONCE hazirlanir: sayim
  // sorgusu ayni `WHERE`i kullanir ama sayfa parametrelerini KULLANMAZ, ve
  // ikisini ayni dizide biriktirmek sayimi sessizce sayfaya baglardi.
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const whereParams = [...params]

  if (cursor !== null) {
    params.push(cursor.toString())
    where.push(`${key} ${desc ? '<' : '>'} $${params.length}::numeric`)
  }
  const pagedWhere = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  params.push(limit)
  const limitParam = params.length
  let offsetSql = ''
  if (offset !== null) {
    params.push(offset)
    offsetSql = ` OFFSET $${params.length}`
  }

  const [{ rows }, total] = await Promise.all([
    db.query<OverviewRow & { cursor_key: string | null }>(
      `SELECT *, (${key})::text AS cursor_key FROM token_overview
       ${pagedWhere}
       ORDER BY ${order} LIMIT $${limitParam}${offsetSql}`,
      params,
    ),
    options.withTotal === true
      ? db
          .query<{ n: string }>(
            `SELECT count(*)::text AS n FROM token_overview ${whereSql}`,
            whereParams,
          )
          .then((r) => Number(r.rows[0]?.n ?? '0'))
      : Promise.resolve(undefined),
  ])

  // KISA SAYFA SON SAYFADIR (`searchTokens` ile ayni kural, ayni gerekce).
  const last = rows[rows.length - 1]
  const nextCursor =
    rows.length < limit || last === undefined || last.cursor_key === null
      ? null
      : BigInt(last.cursor_key)

  return {
    rows: rows.map(toOverview),
    nextCursor,
    ...(total === undefined ? {} : { total }),
    indexer: await getIndexerStatus(db),
  }
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

/**
 * BIR ISLEMIN MEKANI. `trades.source`un TS karsiligi, ve `CHECK (source IN
 * ('curve','pool'))` ile AYNI iki degeri tasir.
 *
 * Birlik `string` DEGIL: bir tuketici `row.source === 'amm'` yazabilseydi
 * derleyici sussuz gecer ve dal sonsuza kadar olu kalirdi. Iki degerli birlik,
 * `switch`in tam olup olmadigini derleme zamaninda soyler.
 */
export type TradeSource = 'curve' | 'pool'

export interface TradeRow {
  eventSeq: bigint
  txHash: string
  blockTime: Date
  trader: string
  isBuy: boolean
  /**
   * ============ ISLEM HANGI MEKANDA OLDU ============
   *
   * `'curve'` `BondingCurve.Trade`'den, `'pool'` `PoolManager.Swap` +
   * `ArcpadHook.SwapFeeCollected`ten gelir (`applyTrade` / `applyPoolSwap`) --
   * yani alan, satiri UREten cozucu tarafindan satir basina yazilir.
   *
   * NEDEN SECILMESI GEREKTI. Kolon 003'ten beri semada, ama sorgu onu
   * SECMIYORDU: mezuniyet sonrasi bir liste iki mekani tasiyor, satirin
   * kendisi hangisi oldugunu soylemiyor ve tuketici mecburen
   * `event_seq > graduated_seq` turetmesine dusuyordu. O turetme DOGRUdur ama
   * BAGIMSIZ DEGILDIR: yanlis yazilmis tek bir `graduated_seq` butun gecmisi
   * yanlis etiketler, oysa bu kolon her satirda ayri bir olgudur. Ikisinin
   * ayni cevabi verdigi `test/pool-trades.test.ts`te GERCEK satirlar uzerinde
   * kosulur.
   */
  source: TradeSource
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
  options: { cursor?: Cursor; limit?: number; offset?: number } = {},
): Promise<TradeRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const cursor = options.cursor ?? null
  /*
   * ============ NUMARALI SAYFA ICIN OFFSET -- VE BURADA TAM DOGRU ============
   *
   * `ListTokensOptions.offset` bu deponun bu konudaki uzun notunu tasiyor:
   * offset CANLI bir siralama anahtarinda satir tekrarlatir ya da atlatir.
   * BURADA O BEDEL YOKTUR: siralama `event_seq DESC` ve `event_seq` bir daha
   * DEGISMEZ -- yeni islemler listenin BASINA eklenir, ortasina degil. Yani
   * araya giren bir alim, ikinci sayfayi bir satir kaydirir ve o kadar; bir
   * satiri iki kez gostermez.
   *
   * `cursor` ile birlikte verilemez, ayni sebeple: ikisi ayni soruyu iki
   * farkli garantiyle cevaplar ve sessizce birini secmek, cagiranin hangi
   * garantiyi aldigini bilmemesi demektir.
   */
  const offset = options.offset ?? null
  if (cursor !== null && offset !== null) {
    throw new TypeError(
      'listTrades: `cursor` and `offset` are different pagination guarantees and cannot be ' +
        'combined. Pick one.',
    )
  }
  if (offset !== null && (!Number.isInteger(offset) || offset < 0)) {
    throw new RangeError(`listTrades: offset must be a non-negative integer, got ${offset}`)
  }
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
    source: string
  }>(
    `SELECT t.event_seq::text AS event_seq, t.tx_hash, t.block_time, t.trader, t.is_buy,
            t.source,
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
      ORDER BY t.event_seq DESC LIMIT $3 OFFSET $4`,
    [lower(token), cursor === null ? null : cursor.toString(), limit, offset ?? 0],
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
    source: asTradeSource(r.source),
  }))
}

/**
 * `text` -> `TradeSource`, DARALTMA DEGIL DOGRULAMA.
 *
 * `r.source as TradeSource` bir IDDIA olurdu ve yanlis oldugunda SESSIZCE
 * gecerdi -- tam olarak bu deponun `asHex`te reddettigi sekil. Semadaki
 * `CHECK (source IN ('curve','pool'))` bu dalin ulasilamaz olmasini saglar; o
 * yuzden BURAYA dusmek "kisit gitti ya da yeni bir mekan eklendi ve okuma
 * modeli haberdar degil" demektir, ve bu sessiz gecilecek bir gun degildir.
 */
function asTradeSource(value: string): TradeSource {
  if (value === 'curve' || value === 'pool') return value
  throw new Error(
    `trades.source is "${value}", which is neither 'curve' nor 'pool'. The schema CHECK that ` +
      'makes this impossible has changed, or a new venue was added without updating TradeSource.',
  )
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
  options: { after?: HolderCursor | null; limit?: number; offset?: number } = {},
): Promise<HolderRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const after = options.after ?? null
  /*
   * OFFSET, VE BURADA BEDELI GERCEKTIR -- `listTrades`ten farkli olarak.
   * Siralama `balance_tok DESC` ve bir bakiye HER ISLEMDE degisir, yani iki
   * sayfa arasinda bir alim listeyi kaydirabilir. Numarali sayfa yine de
   * isteniyor cunku urun onu istiyor; secim ACIKCA burada yaziyor ki bir
   * sonraki okuyucu bunu bir kusur sanmasin.
   */
  const offset = options.offset ?? null
  if (after !== null && offset !== null) {
    throw new TypeError('listHolders: `after` and `offset` cannot be combined. Pick one.')
  }
  if (offset !== null && (!Number.isInteger(offset) || offset < 0)) {
    throw new RangeError(`listHolders: offset must be a non-negative integer, got ${offset}`)
  }
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
      ORDER BY h.balance_tok DESC, h.holder ASC LIMIT $4 OFFSET $5`,
    [
      lower(token),
      after === null ? null : after.balanceTok.toString(),
      after === null ? null : after.holder,
      limit,
      offset ?? 0,
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
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ BU FONKSIYONUN TOPLAMI, ALICININ ALACAGI DEGILDIR. Bir cagiran cikmadan  │
 * │ once okunmasi gereken kisim burasi -- 2026-08-09 itibariyle SIFIR        │
 * │ cagirani var, ve bu not tam da o yuzden simdi yaziliyor.                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Iki `JOIN` de ICSELDIR: bir `fee_events` satirinin sayilabilmesi icin
 * `from_addr`in bir `curve_state` satiri, onun token'inin de bir `launches`
 * satiri olmak ZORUNDADIR. Escrow ise FACTORY'YE gore degil ALICIYA gore
 * anahtarlidir ve Faz 2 Faz 1'in escrow'unu YENIDEN KULLANDI -- dolayisiyla
 * escrow'da, indexer'in izleme kumesinde HIC launch'i olmayan (superseded
 * fabrikanin) curve'lerinden gelmis depozitolar vardir. Olculdu 2026-08-09:
 * **36496595214216153 wei** bu sekilde disarida kalir.
 *
 * BU BIR HATA DEGILDIR VE `JOIN`i GEVSETEREK "DUZELTILMEZ": o depozitolarin
 * atfedilecek bir launch'i YOKTUR, ve fonksiyonun adi zaten "launch basina"
 * demektedir. Tehlike, cagiranin bu satirlari TOPLAYIP "kazanciniz" diye
 * gostermesidir; o toplam, `FeeEscrow.owed(recipient)`den KUCUK olur ve
 * kullanici hak ettiginden azini gorur.
 *
 * Bir cagiran yazan kisi icin kural: satirlari launch KIRILIMI olarak goster,
 * TOPLAM icin `owed()`u (ya da `fee_balances`i) kaynak al, ve ikisi ayrilirsa
 * farki ATFEDILMEMIS olarak isimlendir -- sessizce yutma.
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

// ===========================================================================
//  FAZ 5 -- /analytics VE /profile/[address]
// ===========================================================================

/**
 * ====================== `protocol_stats_daily` YOKTUR ======================
 *
 * Faz 3 o tabloyu KAPSAM DISI birakti, ve asagidaki sorgular onu KURMAZ; ayni
 * sayilari `trades` ve `launches` uzerinden OKUMA ANINDA turetirler. Karar ve
 * bedeli:
 *
 * 1. BIR ROLLUP TABLOSUNUN YAZARI `indexer/`DIR. Bu paket onu okuyabilir ama
 *    dolduramaz. Yazari olmayan bir tabloyu semaya koymak, ekranda SONSUZA
 *    KADAR bos kalan bir grafik demektir -- bu deponun daha once bir kez
 *    sevkettigi ariza kipi ("olmayan bir seyi varmis gibi gosteren ekran").
 *
 * 2. GUN KOVASI OKUMA ANINDA COZULUR, YAZMA ANINDA COZULMEZ. Arc'ta ardisik
 *    bloklarin %49'u AYNI timestamp'i tasir; bu SIRALAMAYI bozar, KOVALAMAYI
 *    bozmaz -- esit iki timestamp ayni kovaya duser ve bu DOGRUDUR. Yazma
 *    tarafinda ise ayni ozellik zor tarafa duser: at-least-once teslimatta
 *    gec gelen bir olay KAPANMIS bir kovaya dusebilir, yani artimli toplam
 *    `event_seq` basina idempotent olmak ZORUNDADIR. O ispat indexer'in
 *    isidir ve burada taklit edilemez.
 *
 * 3. BEDEL YAZILIYOR: bu sorgular `trades` ve `launches` uzerinde TAM
 *    TOPLAMADIR. Bir indeks bunu KURTARMAZ, cunku sayfa her zaman "all time"
 *    kutucuklarini da cizer ve o toplamaya hicbir pencere indeksi uygulanamaz.
 *    Bugun tabloda alti islem var; sikinti bu degil. `trades` buyudugunde
 *    cozum bir indeks degil TAM OLARAK `protocol_stats_daily`dir, ve o zaman
 *    yazilmasi gereken sey indexer'in artimli guncellemesidir.
 *
 * 4. SAYILARIN KAPSAMI: `trades` yalnizca INDEKSLENEN factory'nin
 *    launch'larini tasir. Superseded (Faz 1) factory'nin curve'lerinden gelen
 *    ucretler ne `trades`te ne `launches`tedir -- yani buradaki "protokol
 *    geliri" escrow defterinden (`fee_balances`) KUCUKTUR. Ikisi ayni sayi
 *    DEGILDIR ve toplanamazlar; bu fonksiyonlarin verdigi sey "indekslenen
 *    launch'larda islemlerden ALINAN ucret"tir.
 */

/** Bir pencerenin (ya da tum zamanin) protokol toplamlari. */
export interface ProtocolStats {
  /** `null` -> tum zaman. Aksi halde `now() - windowHours`. */
  windowHours: number | null
  volumeWei: bigint
  tradeCount: number
  protocolFeeWei: bigint
  creatorFeeWei: bigint
  launchCount: number
  /** `count(DISTINCT launch_creator)` -- spec 6.2'nin "tekil dev sayisi". */
  creatorCount: number
  /**
   * MEKAN AYRIMI. Bugun sifirdir (hicbir token mezun olmadi) ve tam da bu
   * yuzden tasiniyor: sifir olan bir sayaci HIC gostermemek ile sifir
   * GOSTERMEK ayni sey degildir, ve tuketici hangisini yapacagina ancak
   * sayiyi gorerek karar verebilir.
   */
  poolVolumeWei: bigint
  poolTradeCount: number
}

const PROTOCOL_STATS_SQL = `
  WITH bound AS (
    SELECT CASE WHEN $1::int IS NULL THEN NULL
                ELSE now() - make_interval(hours => $1::int) END AS since
  ),
  t AS (
    SELECT quote_amount_wei, protocol_fee_wei, creator_fee_wei, source
      FROM trades, bound
     WHERE bound.since IS NULL OR trades.block_time >= bound.since
  ),
  l AS (
    SELECT launch_creator
      FROM launches, bound
     WHERE bound.since IS NULL OR launches.created_at >= bound.since
  )
  SELECT
    (SELECT coalesce(sum(quote_amount_wei), 0) FROM t)::text          AS volume_wei,
    (SELECT count(*) FROM t)::text                                    AS trade_count,
    (SELECT coalesce(sum(protocol_fee_wei), 0) FROM t)::text          AS protocol_fee_wei,
    (SELECT coalesce(sum(creator_fee_wei), 0) FROM t)::text           AS creator_fee_wei,
    (SELECT count(*) FROM l)::text                                    AS launch_count,
    (SELECT count(DISTINCT launch_creator) FROM l)::text              AS creator_count,
    (SELECT coalesce(sum(quote_amount_wei) FILTER (WHERE source = 'pool'), 0) FROM t)::text
                                                                      AS pool_volume_wei,
    (SELECT count(*) FILTER (WHERE source = 'pool') FROM t)::text     AS pool_trade_count`

/**
 * 24 saat / tum zaman kutucuklari.
 *
 * PENCERE `now()` UZERINDEDIR, YANI VERITABANI SUNUCUSUNUN SAATI -- zincirin
 * degil. `block_time` zincirden gelir; indexer geride kaldiginda "son 24 saat"
 * gercekte "gordugumuz son 24 saat"tir. Bu bir hata degil, ADLANDIRILMASI
 * gereken bir onkosuldur: donen `indexer` alani tam olarak o gecikmeyi tasir
 * ve tuketici onu ekranda gostermek zorundadir.
 *
 * ZAMAN BURADA PENCEREDIR, SIRALAMA DEGIL -- yani esit timestamp'ler zararsiz
 * (bkz. bu dosyanin basi, kural 1).
 */
export async function getProtocolStats(
  db: Queryable,
  options: { windowHours?: number | null } = {},
): Promise<Fresh<ProtocolStats>> {
  const raw = options.windowHours ?? null
  // Negatif ya da sifir bir pencere hicbir zaman "tum zaman" DEGILDIR; `null`a
  // KATLANMAZ, clamp edilir. Aksi halde bir hesaplama hatasi sessizce butun
  // gecmisi "son 24 saat" diye gosterirdi.
  const windowHours = raw === null ? null : Math.min(Math.max(Math.trunc(raw), 1), 24 * 365 * 10)
  const { rows } = await db.query<{
    volume_wei: string
    trade_count: string
    protocol_fee_wei: string
    creator_fee_wei: string
    launch_count: string
    creator_count: string
    pool_volume_wei: string
    pool_trade_count: string
  }>(PROTOCOL_STATS_SQL, [windowHours])
  const row = rows[0]
  if (row === undefined) throw new Error('getProtocolStats: the aggregate returned no row')
  return {
    rows: {
      windowHours,
      volumeWei: BigInt(row.volume_wei),
      tradeCount: Number(row.trade_count),
      protocolFeeWei: BigInt(row.protocol_fee_wei),
      creatorFeeWei: BigInt(row.creator_fee_wei),
      launchCount: Number(row.launch_count),
      creatorCount: Number(row.creator_count),
      poolVolumeWei: BigInt(row.pool_volume_wei),
      poolTradeCount: Number(row.pool_trade_count),
    },
    indexer: await getIndexerStatus(db),
  }
}

export interface ProtocolDay {
  /** `YYYY-MM-DD`, UTC. BIR `Date` DEGIL -- gerekce `listProtocolDaily`de. */
  day: string
  volumeWei: bigint
  tradeCount: number
  protocolFeeWei: bigint
  creatorFeeWei: bigint
  launchCount: number
}

const PROTOCOL_DAILY_SQL = `
  WITH span AS (
    SELECT (date_trunc('day', now() AT TIME ZONE 'UTC')
            - make_interval(days => $1::int - 1))::timestamp AS first_day,
           date_trunc('day', now() AT TIME ZONE 'UTC')::timestamp AS last_day
  ),
  days AS (
    SELECT generate_series(span.first_day, span.last_day, interval '1 day')::date AS day
      FROM span
  ),
  t AS (
    SELECT (trades.block_time AT TIME ZONE 'UTC')::date AS day,
           sum(quote_amount_wei)  AS volume_wei,
           count(*)               AS trade_count,
           sum(protocol_fee_wei)  AS protocol_fee_wei,
           sum(creator_fee_wei)   AS creator_fee_wei
      FROM trades, span
     WHERE trades.block_time >= (span.first_day AT TIME ZONE 'UTC')
     GROUP BY 1
  ),
  l AS (
    SELECT (launches.created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS launch_count
      FROM launches, span
     WHERE launches.created_at >= (span.first_day AT TIME ZONE 'UTC')
     GROUP BY 1
  )
  SELECT to_char(d.day, 'YYYY-MM-DD')              AS day,
         coalesce(t.volume_wei, 0)::text           AS volume_wei,
         coalesce(t.trade_count, 0)::text          AS trade_count,
         coalesce(t.protocol_fee_wei, 0)::text     AS protocol_fee_wei,
         coalesce(t.creator_fee_wei, 0)::text      AS creator_fee_wei,
         coalesce(l.launch_count, 0)::text         AS launch_count
    FROM days d
    LEFT JOIN t ON t.day = d.day
    LEFT JOIN l ON l.day = d.day
   ORDER BY d.day ASC`

/**
 * GUNLUK SERI -- YOGUN (bos gunler DAHIL) ve SAAT DILIMINDEN BAGIMSIZ.
 *
 * ================= IKI TUZAK, IKISI DE OLCULDU, IKISI DE KAPALI =============
 *
 * 1. `date_trunc('day', block_time)` OTURUMUN saat dilimini kullanir.
 *    `block_time` `timestamptz`tir, yani ayni satir `TimeZone='UTC'` ile bir
 *    kovaya, `TimeZone='Pacific/Kiritimati'` (UTC+14) ile BASKA bir kovaya
 *    duser -- ve iki taraf da hicbir hata vermez. `pg` havuzu oturum durumunu
 *    `release()`te SIFIRLAMAZ, dolayisiyla bu, "kimsenin yazmadigi bir
 *    onkosul yuzunden gecen test" sinifinin ta kendisidir. Burada kovalama
 *    ACIKCA `AT TIME ZONE 'UTC'` ile yapilir ve `queries.test.ts` sorguyu iki
 *    ucta (UTC+14 ve UTC-12) kosturup AYNI kovalari IDDIA eder.
 *
 * 2. `day` METINDIR, `date` DEGIL. `pg`nin varsayilan `date` cozucusu bir JS
 *    `Date` uretir ve o `Date` YEREL gece yarisidir; bu makinede (UTC+3)
 *    `toISOString()` ile bicimlendirildiginde BIR ONCEKI gunu yazar. Sunucuda
 *    `to_char` ile metne cevirmek o donusumun tamamini ortadan kaldirir.
 *
 * BOS GUNLER SIFIRLA DOLDURULUR (`generate_series` + `LEFT JOIN`). Doldurmayan
 * bir seri, uc gun hicbir sey olmadiginda uc bitisik cubuk cizdirir ve zaman
 * eksenini SESSIZCE sikistirir -- grafigin okuyucusu bosluktan haberdar olmaz.
 */
export async function listProtocolDaily(
  db: Queryable,
  options: { days?: number } = {},
): Promise<Fresh<ProtocolDay[]>> {
  const days = Math.min(Math.max(Math.trunc(options.days ?? 30), 1), 365)
  const { rows } = await db.query<{
    day: string
    volume_wei: string
    trade_count: string
    protocol_fee_wei: string
    creator_fee_wei: string
    launch_count: string
  }>(PROTOCOL_DAILY_SQL, [days])
  return {
    rows: rows.map((r) => ({
      day: r.day,
      volumeWei: BigInt(r.volume_wei),
      tradeCount: Number(r.trade_count),
      protocolFeeWei: BigInt(r.protocol_fee_wei),
      creatorFeeWei: BigInt(r.creator_fee_wei),
      launchCount: Number(r.launch_count),
    })),
    indexer: await getIndexerStatus(db),
  }
}

/**
 * BIR CUZDANIN POZISYONU.
 *
 * `valueWei` MARJINAL fiyattan hesaplanir (`balance * price / 1e18`, TABANA)
 * ve TAM CIKISTA ELE GECECEK TUTAR DEGILDIR: satis curve'u asagi iter ve
 * ucretler bu sayinin disindadir. Alan adi bu yuzden `valueWei`dir,
 * `proceedsWei` degil, ve tuketicinin etiketi de bunu soylemek zorundadir.
 */
export interface PositionRow {
  token: string
  symbol: string
  name: string
  balanceTok: bigint
  priceWeiPerTok: bigint
  valueWei: bigint
  complete: boolean
  graduated: boolean
}

/**
 * POZISYON IMLECI -- `HolderCursor` ile AYNI SEKIL, AYNI GEREKCE.
 *
 * Tek anahtar `value_wei` OLAMAZ: fiyat token basina AYNIDIR ve hic islem
 * gormemis her token acilis fiyatindadir, yani esit degerler kural disi degil
 * KURALDIR. Ikinci anahtar `token` -- `(token, holder)` birincil anahtarinin
 * yarisi, sabit bir `holder` icin BIREBIR.
 */
export interface PositionCursor {
  valueWei: bigint
  token: string
}

export function encodePositionCursor(row: PositionCursor): string {
  return `${row.valueWei.toString()}:${lower(row.token as Address)}`
}

/** Bicimsiz bir imlec ILK SAYFADIR, hata degil (`parseHolderCursor` ile ayni). */
export function parsePositionCursor(value: string | null | undefined): PositionCursor | null {
  if (value === null || value === undefined || value === '') return null
  const match = /^(\d{1,78}):(0x[0-9a-f]{40})$/.exec(value)
  if (match === null) return null
  return { valueWei: BigInt(match[1] as string), token: match[2] as string }
}

/**
 * Bir adresin TUTTUGU tokenlar. `holders_holder_idx` (kismi, `balance_tok > 0`)
 * tam olarak bu sorgu icin vardir.
 *
 * `token_overview` ile birlestirilir cunku bir bakiyeyi degerlemek fiyat ister
 * ve fiyat SAKLANMAZ, her okumada rezervlerden yeniden hesaplanir (bkz.
 * `migrations/007_views.sql`). Bakiye AYRICA sifirdan buyuk olmak zorundadir:
 * bir zamanlar tutulmus ve tamamen satilmis bir token bir POZISYON DEGILDIR.
 *
 * CURVE'UN KENDISI ELENMEZ, cunku bu sorgu bir TOKEN'in holder listesi degil
 * bir ADRESIN portfoyudur: `holder` parametresi zaten tek bir cuzdandir ve o
 * cuzdan bir curve ise (imkansiza yakin ama semada yasak degil) dogru cevap
 * yine "bu adres su kadar tutuyor"dur.
 */
export async function listPositionsByHolder(
  db: Queryable,
  holder: Address,
  options: { after?: PositionCursor | null; limit?: number } = {},
): Promise<Fresh<PositionRow[]>> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const after = options.after ?? null
  const { rows } = await db.query<{
    token: string
    symbol: string
    name: string
    balance_tok: string
    price_wei_per_tok: string
    value_wei: string
    complete: boolean
    graduated: boolean
  }>(
    // KARISIK YONLU SIRA ACIKCA YAZILIR (`listHolders` ile ayni gerekce):
    // `value DESC, token ASC` bir satir-degeri karsilastirmasiyla ifade
    // EDILEMEZ.
    `WITH p AS (
       SELECT o.token, o.symbol, o.name, h.balance_tok, o.price_wei_per_tok,
              div(h.balance_tok * o.price_wei_per_tok, 1000000000000000000::numeric)::numeric(78,0)
                AS value_wei,
              o.complete, o.graduated
         FROM holders h
         JOIN token_overview o ON o.token = h.token
        WHERE h.holder = $1 AND h.balance_tok > 0
     )
     SELECT token, symbol, name, balance_tok::text AS balance_tok,
            price_wei_per_tok::text AS price_wei_per_tok, value_wei::text AS value_wei,
            complete, graduated
       FROM p
      WHERE ($2::numeric IS NULL
             OR value_wei < $2::numeric
             OR (value_wei = $2::numeric AND token > $3::text))
      ORDER BY value_wei DESC, token ASC LIMIT $4`,
    [
      lower(holder),
      after === null ? null : after.valueWei.toString(),
      after === null ? null : after.token,
      limit,
    ],
  )
  return {
    rows: rows.map((r) => ({
      token: r.token,
      symbol: r.symbol,
      name: r.name,
      balanceTok: BigInt(r.balance_tok),
      priceWeiPerTok: BigInt(r.price_wei_per_tok),
      valueWei: BigInt(r.value_wei),
      complete: r.complete,
      graduated: r.graduated,
    })),
    indexer: await getIndexerStatus(db),
  }
}

/**
 * BIR CUZDANIN ISLEMI -- `TradeRow`DAN AYRI BIR TIP, VE BILEREK.
 *
 * `TradeRow` TEK bir tokenin sayfasi icindir; token kimligi baglamdan gelir.
 * Bir cuzdanin gecmisi TOKENLAR ARASINDADIR, yani her satir kendi tokenini ve
 * sembolunu TASIMAK zorundadir. Ayni tipi genisletmek, token sayfasindaki her
 * satira asla kullanilmayan iki alan eklerdi.
 */
export interface TraderTradeRow {
  eventSeq: bigint
  txHash: string
  blockTime: Date
  token: string
  symbol: string
  isBuy: boolean
  tokenAmountTok: bigint
  quoteAmountWei: bigint
  protocolFeeWei: bigint
  creatorFeeWei: bigint
  source: TradeSource
}

/**
 * `trades_trader_seq_idx (trader, event_seq DESC)` tam olarak bunun icin var.
 * SIRALAMA `event_seq` UZERINDE, `block_time` uzerinde DEGIL.
 *
 * `trader` HAVUZ TARAFINDA `Swap.sender`DIR, yani genellikle ROUTER'dir --
 * kullanicinin cuzdani degil. Yani mezuniyet sonrasi bir islem bu listede
 * kullanicinin adresinde GORUNMEZ; `source` alani her satirin mekanini
 * tasidigi icin bu ayrim ekranda soylenebilir. Duzeltmesi indexer'in
 * `Swap.sender` yerine gercek isteyeni cozmesini gerektirir ve bu paketin
 * disindadir.
 */
export async function listTradesByTrader(
  db: Queryable,
  trader: Address,
  options: { cursor?: Cursor; limit?: number } = {},
): Promise<Fresh<TraderTradeRow[]>> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const cursor = options.cursor ?? null
  const { rows } = await db.query<{
    event_seq: string
    tx_hash: string
    block_time: Date
    token: string
    symbol: string
    is_buy: boolean
    token_amount_tok: string
    quote_amount_wei: string
    protocol_fee_wei: string
    creator_fee_wei: string
    source: TradeSource
  }>(
    `SELECT t.event_seq::text AS event_seq, t.tx_hash, t.block_time, t.token, l.symbol,
            t.is_buy, t.token_amount_tok::text AS token_amount_tok,
            t.quote_amount_wei::text AS quote_amount_wei,
            t.protocol_fee_wei::text AS protocol_fee_wei,
            t.creator_fee_wei::text AS creator_fee_wei, t.source
       FROM trades t
       JOIN launches l ON l.token = t.token
      WHERE t.trader = $1 AND ($2::bigint IS NULL OR t.event_seq < $2::bigint)
      ORDER BY t.event_seq DESC LIMIT $3`,
    [lower(trader), cursor === null ? null : cursor.toString(), limit],
  )
  return {
    rows: rows.map((r) => ({
      eventSeq: BigInt(r.event_seq),
      txHash: r.tx_hash,
      blockTime: r.block_time,
      token: r.token,
      symbol: r.symbol,
      isBuy: r.is_buy,
      tokenAmountTok: BigInt(r.token_amount_tok),
      quoteAmountWei: BigInt(r.quote_amount_wei),
      protocolFeeWei: BigInt(r.protocol_fee_wei),
      creatorFeeWei: BigInt(r.creator_fee_wei),
      source: r.source,
    })),
    indexer: await getIndexerStatus(db),
  }
}

/**
 * ==========================================================================
 *  UCRET KAZANCI -- DOKUM VE TOPLAM AYNI SAYIDAN GELMEZ, VE GELEMEZ.
 * ==========================================================================
 *
 * `listCreatorEarningsByLaunch`in NatSpec'i ilk cagirana bir KURAL birakti:
 * satirlari LAUNCH KIRILIMI olarak goster, TOPLAM icin escrow defterini
 * (`fee_balances`, yani `FeeEscrow.owed + cekilenler`) kaynak al, ve ikisi
 * ayrilirsa farki ATFEDILMEMIS diye isimlendir. Bu fonksiyon o kurali bir
 * BELGEDEN bir TIPE tasir: donen yapida "kazanciniz" diye okunabilecek,
 * satirlarin toplamina esit bir alan YOKTUR. Yanlis toplami gostermek icin
 * cagiranin `byLaunch`i kendisi toplamasi gerekir, ki bu artik goze batan bir
 * satirdir -- eskiden dogal olan seydi.
 *
 * ATFEDILMEYEN PARA IKI KAYNAKTAN GELIR ve ikisi de OLCULDU:
 *
 *   a) PAYLASILAN ESCROW'UN ONEKI. Escrow ALICIYA gore anahtarlidir ve Faz 2
 *      Faz 1'in escrow'unu yeniden kullandi, yani defterde indexer'in izleme
 *      kumesinde HIC launch'i olmayan curve'lerden gelmis depozitolar var.
 *      Olculdu 2026-08-09: **36496595214216153 wei**.
 *   b) HER HAVUZ UCRETI. `ArcpadHook` swap ucretini escrow'a yatirir, yani
 *      `Deposited.from` HOOK'tur, bir curve DEGIL -- `curve_state` JOIN'i onu
 *      dusurur. Bugun sifirdir (hicbir token mezun olmadi) ve mezuniyetten
 *      sonra buyur.
 *
 * TEK BIR IFADEDE OKUNUR, VE BU ZORUNLU. Iki ayri `query()` havuzdan IKI AYRI
 * baglanti alabilir, yani IKI AYRI snapshot: arada inen bir `Deposited`
 * defteri buyutur, dokumu buyutmez, ve `unattributedWei` sessizce siserdi --
 * ya da ters sirada NEGATIF olurdu. Bir ifade, bir snapshot.
 */
export interface CreatorEarnings {
  recipient: string
  /** Launch KIRILIMI. `attributedWei`e esit olmayabilir -- bkz. `byLaunchTruncated`. */
  byLaunch: CreatorEarning[]
  /** `true` -> `byLaunch` kirpildi; `attributedWei` yine de TAM toplamdir. */
  byLaunchTruncated: boolean
  /** Bir launch'a ATFEDILEBILEN toplam, kirpmadan BAGIMSIZ. */
  attributedWei: bigint
  /** `depositedTotalWei - attributedWei`. Yutulmaz, GOSTERILIR. */
  unattributedWei: bigint
  /** ESCROW DEFTERI. `FeeEscrow.owed(recipient) + cekilenler` ile ayni sayi. */
  depositedTotalWei: bigint
  claimedTotalWei: bigint
  /** `FeeEscrow.owed(recipient)`. TEK dogru "su an cekilebilir" sayisi. */
  claimableWei: bigint
  /**
   * `fee_balances`te satir YOK. Depozito hic gorulmemis demektir; dokum de bos
   * OLMALIDIR. Bos degilse defter ile olay tablosu AYRISMISTIR ve bu, bir
   * sifirla gizlenecek bir sey degildir.
   */
  ledgerMissing: boolean
}

export async function getCreatorEarnings(
  db: Queryable,
  recipient: Address,
  options: { limit?: number } = {},
): Promise<Fresh<CreatorEarnings>> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)
  const { rows } = await db.query<{
    token: string | null
    symbol: string | null
    earned_wei: string | null
    attributed_wei: string
    launch_count: string
    deposited_total_wei: string | null
    claimed_total_wei: string | null
    claimable_wei: string | null
  }>(
    `WITH per_launch AS (
       SELECT l.token, l.symbol, sum(f.amount_wei) AS earned_wei
         FROM fee_events f
         JOIN curve_state c ON c.curve = f.from_addr
         JOIN launches l ON l.token = c.token
        WHERE f.kind = 'deposit' AND f.recipient = $1
        GROUP BY l.token, l.symbol
     ),
     totals AS (
       SELECT coalesce(sum(earned_wei), 0) AS attributed_wei, count(*) AS launch_count
         FROM per_launch
     ),
     top AS (
       SELECT * FROM per_launch ORDER BY earned_wei DESC, token ASC LIMIT $2
     ),
     ledger AS (
       SELECT deposited_total_wei, claimed_total_wei, claimable_wei
         FROM fee_balances WHERE recipient = $1
     )
     SELECT p.token, p.symbol, p.earned_wei::text AS earned_wei,
            tt.attributed_wei::text AS attributed_wei, tt.launch_count::text AS launch_count,
            lg.deposited_total_wei::text AS deposited_total_wei,
            lg.claimed_total_wei::text AS claimed_total_wei,
            lg.claimable_wei::text AS claimable_wei
       FROM totals tt
       LEFT JOIN ledger lg ON true
       LEFT JOIN top p ON true
      ORDER BY p.earned_wei DESC NULLS LAST, p.token ASC`,
    [lower(recipient), limit],
  )

  const head = rows[0]
  // `totals` HER ZAMAN bir satir uretir (`count(*)` uzerine kurulu) ve tek
  // satirlik capa odur, yani bu dal ulasilamazdir. Yine de yaziliyor: sessiz
  // bir `undefined` burada butun toplamlari sifir gosterirdi.
  if (head === undefined) throw new Error('getCreatorEarnings: the aggregate returned no row')

  const byLaunch: CreatorEarning[] = rows
    .filter((r) => r.token !== null)
    .map((r) => ({
      token: r.token as string,
      symbol: r.symbol as string,
      earnedWei: BigInt(r.earned_wei as string),
    }))

  const ledgerMissing = head.deposited_total_wei === null
  const depositedTotalWei = ledgerMissing ? 0n : BigInt(head.deposited_total_wei as string)
  const attributedWei = BigInt(head.attributed_wei)

  return {
    rows: {
      recipient: lower(recipient),
      byLaunch,
      byLaunchTruncated: Number(head.launch_count) > byLaunch.length,
      attributedWei,
      // FARK, YONU KORUNARAK. Negatif bir deger defterin ATFEDILENDEN kucuk
      // oldugunu soyler; sifira kirpmak o durumu SILERDI ve ekranda tutarli
      // gorunurdu.
      unattributedWei: depositedTotalWei - attributedWei,
      depositedTotalWei,
      claimedTotalWei: ledgerMissing ? 0n : BigInt(head.claimed_total_wei as string),
      claimableWei: ledgerMissing ? 0n : BigInt(head.claimable_wei as string),
      ledgerMissing,
    },
    indexer: await getIndexerStatus(db),
  }
}

/**
 * ============================================================================
 *  MUMLAR -- VE EKSEN, BASLIKTAKI SAYIYLA AYNI IFADEDEN GELIR
 * ============================================================================
 *
 * Grafik FDV cizer, ve FDV `token_overview.market_cap_wei` ile AYNI ifadeden
 * turetilir: `mulDiv(Vq, N, Vt)`, taban. Bu bir uslup tercihi degil: bir
 * grafigin son mumu ile sayfanin ustundeki rakam farkli formullerden gelseydi,
 * ikisi bir gun ayrisirdi ve hangisinin dogru oldugunu kimse bilemezdi.
 * Formul `migrations/007_views.sql:46`da, burada aynen tekrarlanir ve
 * `test/candles.test.ts` ikisinin AYNI satir icin ayni sayiyi verdigini
 * gercek veriyle tutar.
 *
 * HER ISLEM KENDI ANINDAKI REZERVLERI TASIR (`Trade` olayi dordunu de yayar),
 * yani mumlar zincire tekrar sorulmadan kurulur. Bir "fiyat yeniden oynatma"
 * gerekmez ve bu, gecmisi yeniden hesaplamanin sessizce kayacagi tek yeri
 * kapatir.
 *
 * KOVA SINIRI `floor(epoch / n) * n`: sabit, UTC'ye dayali ve sunucunun saat
 * diliminden BAGIMSIZ. `date_trunc('hour', ...)` yalnizca saatlik icin
 * calisirdi; bes dakikalik ve alti saatlik dilimler ayni ifadeyle cikar.
 */
export interface CandleRow {
  /** Kovanin BASLANGICI, UTC. */
  bucket: Date
  openWei: bigint
  highWei: bigint
  lowWei: bigint
  closeWei: bigint
  /** Kovadaki toplam quote hacmi (ucretler HARIC -- `quote_amount_wei`). */
  volumeWei: bigint
  trades: number
}

export async function listCandles(
  db: Queryable,
  token: Address,
  options: { bucketSeconds: number; limit?: number } = { bucketSeconds: 3_600 },
): Promise<CandleRow[]> {
  /*
   * KOVA SANIYESI BIR SAYIDIR VE DOGRUDAN SQL'E GIRMEZ. Parametre olarak
   * gecer ve once tam sayiya zorlanir: bu deger arayuzden gelen bir zaman
   * dilimi secimidir, yani DISARIDAN gelir.
   */
  const bucket = Math.max(1, Math.floor(options.bucketSeconds))
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1_000)

  const { rows } = await db.query<{
    bucket: Date
    open_wei: string
    high_wei: string
    low_wei: string
    close_wei: string
    volume_wei: string
    trades: string
  }>(
    `WITH marked AS (
       SELECT
         to_timestamp(floor(extract(epoch FROM t.block_time) / $2::bigint) * $2::bigint) AS bucket,
         t.event_seq,
         div(t.virtual_quote_reserves_wei * d.total_supply_tok, t.virtual_token_reserves_tok)
           AS mcap_wei,
         t.quote_amount_wei
       FROM trades t
       CROSS JOIN deployment d
       WHERE t.token = $1
     )
     SELECT
       bucket,
       -- ACILIS VE KAPANIS SIRAYA GORE, min/max DEGIL. event_seq zincir
       -- sirasidir; block_time ayni blokta ESITTIR ve ona gore siralamak
       -- ayni kovadaki iki islemi rastgele sirada birakirdi.
       (array_agg(mcap_wei ORDER BY event_seq ASC))[1]::text  AS open_wei,
       max(mcap_wei)::text                                     AS high_wei,
       min(mcap_wei)::text                                     AS low_wei,
       (array_agg(mcap_wei ORDER BY event_seq DESC))[1]::text AS close_wei,
       coalesce(sum(quote_amount_wei), 0)::text                AS volume_wei,
       count(*)::text                                          AS trades
     FROM marked
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $3`,
    [token.toLowerCase(), String(bucket), limit],
  )

  // EN ESKIDEN YENIYE dondurulur. Sorgu DESC siralar cunku `LIMIT` en SON
  // mumlari almalidir; bir grafik ise soldan saga cizer.
  return rows
    .map((row) => ({
      bucket: row.bucket,
      openWei: BigInt(row.open_wei),
      highWei: BigInt(row.high_wei),
      lowWei: BigInt(row.low_wei),
      closeWei: BigInt(row.close_wei),
      volumeWei: BigInt(row.volume_wei),
      trades: Number(row.trades),
    }))
    .reverse()
}

/**
 * ============================================================================
 *  HACMIN ALIS/SATIS AYRIMI
 * ============================================================================
 *
 * Bir pencerede: toplam hacim, kac alis ve kac satis, KAC AYRI CUZDAN, ve her
 * yonun tutari. Ekrandaki yesil/kirmizi cubuk ile altindaki iki satir bunun
 * TEK bir okumadan gelir -- iki ayri sorgu, aralarinda yeni bir islem
 * gerceklesirse toplamlari tutmayan bir ekran uretirdi.
 *
 * `count(DISTINCT trader)` YONE GORE ayri sayilir ve toplamlari
 * `count(DISTINCT trader)`e ESIT DEGILDIR: hem alip hem satan bir cuzdan iki
 * tarafta da sayilir. Ekranda da oyle sunulur ("73 alan", "99 satan"), cunku
 * soru "kac kisi vardi" degil "her yonde kac cuzdan vardi"dir.
 */
export interface VolumeSplit {
  volumeWei: bigint
  buys: number
  sells: number
  buyers: number
  sellers: number
  buyVolumeWei: bigint
  sellVolumeWei: bigint
}

export async function getVolumeSplit(
  db: Queryable,
  token: Address,
  options: { sinceSeconds?: number } = {},
): Promise<VolumeSplit> {
  /*
   * `sinceSeconds` VERILMEZSE BUTUN GECMIS. `undefined` ile `0` ayni sey
   * degildir: sifir "son sifir saniye", yani bos bir pencere olurdu ve ekran
   * sessizce her yerde sifir gosterirdi.
   */
  const since =
    options.sinceSeconds === undefined ? null : Math.max(1, Math.floor(options.sinceSeconds))

  const { rows } = await db.query<{
    volume_wei: string
    buys: string
    sells: string
    buyers: string
    sellers: string
    buy_volume_wei: string
    sell_volume_wei: string
  }>(
    `SELECT
       coalesce(sum(quote_amount_wei), 0)::text                              AS volume_wei,
       count(*) FILTER (WHERE is_buy)::text                                  AS buys,
       count(*) FILTER (WHERE NOT is_buy)::text                              AS sells,
       count(DISTINCT trader) FILTER (WHERE is_buy)::text                    AS buyers,
       count(DISTINCT trader) FILTER (WHERE NOT is_buy)::text                AS sellers,
       coalesce(sum(quote_amount_wei) FILTER (WHERE is_buy), 0)::text        AS buy_volume_wei,
       coalesce(sum(quote_amount_wei) FILTER (WHERE NOT is_buy), 0)::text    AS sell_volume_wei
     FROM trades
     WHERE token = $1
       AND ($2::bigint IS NULL OR block_time >= now() - make_interval(secs => $2::bigint))`,
    [token.toLowerCase(), since],
  )

  const row = rows[0]
  // Toplamsiz bir tablo bile TEK satir dondurur (aggregate), ama savunma ucuz.
  if (row === undefined) {
    return {
      volumeWei: 0n,
      buys: 0,
      sells: 0,
      buyers: 0,
      sellers: 0,
      buyVolumeWei: 0n,
      sellVolumeWei: 0n,
    }
  }
  return {
    volumeWei: BigInt(row.volume_wei),
    buys: Number(row.buys),
    sells: Number(row.sells),
    buyers: Number(row.buyers),
    sellers: Number(row.sellers),
    buyVolumeWei: BigInt(row.buy_volume_wei),
    sellVolumeWei: BigInt(row.sell_volume_wei),
  }
}

/**
 * ===========================================================================
 * BUYBACK OKUMA MODELI
 * ===========================================================================
 *
 * NE DONDURULMEDIGI, DONDURULENDEN DAHA ONEMLI: "su anda cekilebilir tutar"
 * BU KATMANDAN CIKAMAZ ve cikmamali.
 *
 * `BuybackVestingVault` vesting'i CHECKPOINT'LI hesaplar:
 *
 *     yeni = vestsizKalan * gecenSure / (bitis - sonGuncelleme)
 *
 * `lastUpdate` her kilitte ve her dagitimda YENIDEN yazilir, yani hak edilmis
 * tutar YOL BAGIMLIDIR: ayni `totalLocked`, ayni pencere ve ayni "simdi" ile
 * iki farkli kilit gecmisi FARKLI sonuc verir. Olaylardan yeniden kurmak,
 * her checkpoint'i de saklamayi gerektirirdi.
 *
 * Dogrusal bir yaklasim yazmak kolaydi ve tek kilitli tokenlerde DOGRU cevabi
 * verirdi -- bu yuzden tehlikeli: ekranda dogru gorunen bir sayi, ikinci
 * kilitten sonra sessizce yanlislasirdi. Arayuz canli bir rakam isterse onu
 * `vault.releasable(token)`dan OKUMALI, buradan TURETMEMELIDIR.
 *
 * Buradan cikan her sey bir OLGUDUR: zincirin yaydigi tutarlar ve zamanlar.
 */
export interface BuybackEventRow {
  eventSeq: bigint
  blockTime: Date
  txHash: string
  kind: 'policy' | 'accrued' | 'executed' | 'skipped' | 'locked' | 'released'
  venueAddr: string | null
  /** `released`te cagiran, `policy`de degisikligi yapan. */
  callerAddr: string | null
  reason: string | null
  enabled: boolean | null
  quoteWei: bigint | null
  pendingWei: bigint | null
  tokenAmountTok: bigint | null
  totalLockedTok: bigint | null
  creatorAmountTok: bigint | null
  protocolAmountTok: bigint | null
  vestingStartAt: Date | null
  vestingEndAt: Date | null
}

export interface TokenBuyback {
  /** ZINCIRIN BAYRAGI, toplamlardan TURETILMIS bir tahmin degil. */
  enabled: boolean
  enabledSeq: bigint | null
  enabledByAddr: string | null
  pendingQuoteWei: bigint
  accruedTotalWei: bigint
  spentTotalWei: bigint
  returnedTotalWei: bigint
  boughtTotalTok: bigint
  lockedTotalTok: bigint
  releasedCreatorTok: bigint
  releasedProtocolTok: bigint
  /** EN SON kilidin agirlikli penceresi; kilit yoksa `null`. */
  vestingStartAt: Date | null
  vestingEndAt: Date | null
  lastSeq: bigint
  /** En yeni olaylar once. Bos olabilir (sayfa siniri sifirsa). */
  history: readonly BuybackEventRow[]
}

interface BuybackStateRow {
  enabled: boolean
  enabled_seq: string | null
  enabled_by_addr: string | null
  pending_quote_wei: string
  accrued_total_wei: string
  spent_total_wei: string
  returned_total_wei: string
  bought_total_tok: string
  locked_total_tok: string
  released_creator_tok: string
  released_protocol_tok: string
  vesting_start_at: Date | null
  vesting_end_at: Date | null
  last_seq: string
}

interface BuybackHistoryRow {
  event_seq: string
  block_time: Date
  tx_hash: string
  kind: BuybackEventRow['kind']
  venue_addr: string | null
  caller_addr: string | null
  reason: string | null
  enabled: boolean | null
  quote_wei: string | null
  pending_wei: string | null
  token_amount_tok: string | null
  total_locked_tok: string | null
  creator_amount_tok: string | null
  protocol_amount_tok: string | null
  vesting_start_at: Date | null
  vesting_end_at: Date | null
}

const bigOrNull = (value: string | null): bigint | null => (value === null ? null : BigInt(value))

/** Gecmis sayfasinin ust siniri. Panel bir OZETTIR, bir defter dokumu degil. */
export const BUYBACK_HISTORY_LIMIT = 20

/**
 * Bir token'in buyback durumu + son olaylari.
 *
 * `null` = bu token icin HIC buyback olayi gorulmedi. `enabled: false` ile
 * AYNI SEY DEGILDIR ve arayuz ikisini ayirmalidir: birincisi "bu ozellik bu
 * token'da hic soz konusu olmadi", ikincisi "acilmisti, KAPATILDI".
 */
export async function getTokenBuyback(
  db: Queryable,
  token: Address,
  options: { historyLimit?: number } = {},
): Promise<Fresh<TokenBuyback | null>> {
  const limit = Math.max(0, Math.min(options.historyLimit ?? BUYBACK_HISTORY_LIMIT, 200))
  const key = lower(token)

  const { rows } = await db.query<BuybackStateRow>(
    `SELECT enabled, enabled_seq::text, enabled_by_addr,
            pending_quote_wei::text, accrued_total_wei::text, spent_total_wei::text,
            returned_total_wei::text, bought_total_tok::text, locked_total_tok::text,
            released_creator_tok::text, released_protocol_tok::text,
            vesting_start_at, vesting_end_at, last_seq::text
       FROM buyback_state WHERE token = $1`,
    [key],
  )
  const state = rows[0]
  if (state === undefined) return { rows: null, indexer: await getIndexerStatus(db) }

  const history = await db.query<BuybackHistoryRow>(
    `SELECT event_seq::text, block_time, tx_hash, kind, venue_addr, caller_addr, reason, enabled,
            quote_wei::text, pending_wei::text, token_amount_tok::text, total_locked_tok::text,
            creator_amount_tok::text, protocol_amount_tok::text, vesting_start_at, vesting_end_at
       FROM buyback_events
      WHERE token = $1
      ORDER BY event_seq DESC
      LIMIT $2`,
    [key, limit],
  )

  return {
    rows: {
      enabled: state.enabled,
      enabledSeq: bigOrNull(state.enabled_seq),
      enabledByAddr: state.enabled_by_addr,
      pendingQuoteWei: BigInt(state.pending_quote_wei),
      accruedTotalWei: BigInt(state.accrued_total_wei),
      spentTotalWei: BigInt(state.spent_total_wei),
      returnedTotalWei: BigInt(state.returned_total_wei),
      boughtTotalTok: BigInt(state.bought_total_tok),
      lockedTotalTok: BigInt(state.locked_total_tok),
      releasedCreatorTok: BigInt(state.released_creator_tok),
      releasedProtocolTok: BigInt(state.released_protocol_tok),
      vestingStartAt: state.vesting_start_at,
      vestingEndAt: state.vesting_end_at,
      lastSeq: BigInt(state.last_seq),
      history: history.rows.map((r) => ({
        eventSeq: BigInt(r.event_seq),
        blockTime: r.block_time,
        txHash: r.tx_hash,
        kind: r.kind,
        venueAddr: r.venue_addr,
        callerAddr: r.caller_addr,
        reason: r.reason,
        enabled: r.enabled,
        quoteWei: bigOrNull(r.quote_wei),
        pendingWei: bigOrNull(r.pending_wei),
        tokenAmountTok: bigOrNull(r.token_amount_tok),
        totalLockedTok: bigOrNull(r.total_locked_tok),
        creatorAmountTok: bigOrNull(r.creator_amount_tok),
        protocolAmountTok: bigOrNull(r.protocol_amount_tok),
        vestingStartAt: r.vesting_start_at,
        vestingEndAt: r.vesting_end_at,
      })),
    },
    indexer: await getIndexerStatus(db),
  }
}

/**
 * Bir token'in TOPLAM islem sayisi -- numarali sayfalama icin.
 *
 * AYRI BIR FONKSIYON, `listTrades`in icine gomulu bir `withTotal` DEGIL.
 * Sebep `token_stats.trade_count`: sayim zaten bir yerde tutuluyor ve bu
 * fonksiyon once ORAYA bakar. Listeyi doneni bir `COUNT(*)` yapmaya zorlamak,
 * her sayfa cizimine gereksiz bir tam tarama eklerdi -- oysa numarali sayfa
 * toplami YALNIZCA sayfa listesini cizmek icin ister.
 *
 * `token_stats` satiri yoksa (hic islem gormemis token) sayim `0`dir ve bu
 * `null` DEGILDIR: "hic islem yok" bilinen bir cevaptir.
 */
export async function countTrades(db: Queryable, token: Address): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    'SELECT coalesce(trade_count, 0)::text AS n FROM token_stats WHERE token = $1',
    [lower(token)],
  )
  return rows[0] === undefined ? 0 : Number(rows[0].n)
}

/** Bir token'in holder sayisi. Curve'un KENDISI haric -- `token_overview` ile ayni kural. */
export async function countHolders(db: Queryable, token: Address): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM holders h
       JOIN launches l ON l.token = h.token
      WHERE h.token = $1 AND h.balance_tok > 0 AND h.holder <> l.curve`,
    [lower(token)],
  )
  return rows[0] === undefined ? 0 : Number(rows[0].n)
}
