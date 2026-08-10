import type { SortKey } from '@/components/read/types'

export type ExploreSearchParams = {
  tab?: string | string[] | undefined
  page?: string | string[] | undefined
}

/**
 * DORT SEKME, VE HER BIRI BIR (SIRALAMA, PENCERE) CIFTI.
 *
 * Onceki hal bes siralama ile uc yas filtresini ayri iki serit halinde
 * gosteriyordu: on bes kombinasyon, hicbirinin adi yok. Kullanicinin sordugu
 * soru "hangi kolona gore sirala" degil, "bana neyi goster" -- ve o sorunun
 * dort cevabi var.
 *
 * `sort` ve `ageDays` URL'e YAZILMAZ; yalnizca `tab` yazilir. Iki temsil
 * (sekme adi + turedigi ciftler) ayni sayfayi iki farkli adresten gostermek
 * demektir ve hangisinin kanonik oldugu belirsiz kalir.
 */
export const TABS = {
  /**
   * TRENDING = 24 SAATLIK HACIM.
   *
   * "Islem aktivitesi"nin olculmus hali budur. `recentBuys` (son alimin
   * `event_seq`i) da bir aktivite olcusudur ama YALNIZCA SONLUGU olcer: tek
   * bir 1 USDC'lik alim, bir gunde 40.000 USDC donmus bir curve'un onune
   * gecer. Hacim, "ne kadar" sorusunu cevaplar.
   */
  trending: { sort: 'volume', ageDays: null, label: 'Trending' },
  /**
   * NEW = SON 7 GUN, YENIDEN ESKIYE.
   *
   * Yas bir PENCEREdir, siralama degil: `created_at >= now() - 7 gun` kumeyi
   * daraltir, sira yine `created_seq`tedir. Ikisi ayni olsaydi, ayni saniyede
   * acilan iki launch arasindaki sira belirsiz olurdu -- ve olculdu, ardisik
   * bloklarin yarisi ayni timestamp'i tasiyor.
   */
  new: { sort: 'newest', ageDays: 7, label: 'New' },
  /** TOP = FDV, buyukten kucuge. */
  top: { sort: 'marketCap', ageDays: null, label: 'Top' },
  /**
   * NEAR GRADUATION = ILERLEME YUZDESI, YAKINDAN UZAGA.
   *
   * Tamamlanmislar SUZULMEZ: %100'e varmis bir curve, "graduation'a en yakin"
   * listesinin dogal olarak en ustundedir -- sirada bekleyen ilk adaydir.
   */
  nearGraduation: { sort: 'nearGraduation', ageDays: null, label: 'Near graduation' },
} as const satisfies Record<string, { sort: SortKey; ageDays: number | null; label: string }>

export type TabKey = keyof typeof TABS

export const TAB_KEYS = Object.keys(TABS) as readonly TabKey[]

export const DEFAULT_TAB: TabKey = 'trending'

/**
 * SAYFA BOYUTU, TEK YERDE.
 *
 * `packages/db`'nin 200 satirlik ust siniri altinda olmali: `listTokens`
 * `limit`i `[1, 200]`e kirpar, yani 500 isteyen bir cagiran 200 satir alir ve
 * "daha var mi" sorusunu yanlis cevaplar. 48 hem o sinirin altinda hem de 2,
 * 3, 4 ve 6 sutuna TAM bolunur -- her kirilma noktasinda son satir dolu biter.
 */
export const PAGE_SIZE = 48

export type ExploreQuery = {
  readonly tab: TabKey
  readonly sort: SortKey
  readonly ageDays: number | null
  /** 1 tabanli. */
  readonly page: number
}

/** `?tab=a&tab=b` -> Next dizi verir. Ilk deger baglayicidir. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * URL'DEN GELEN DIZE HICBIR ZAMAN BIR SQL IFADESINE DONUSMEZ.
 *
 * `tab` burada bir ANAHTAR olarak cozulur ve taninmayan her deger sessizce
 * varsayilana duser. Sessizce, cunku bir kullaniciya elle yazdigi URL icin
 * hata sayfasi gostermek bir sey kazandirmaz -- ama beyaz listenin disina
 * cikan bir degerin SORGUYA ULASMAMASI zorunludur. Ifadenin kendisi
 * `packages/db`'de durur; buradan gecen tek sey `SORTS`'un bir anahtaridir.
 *
 * `page` UST SINIRLIDIR, ve bu keyfi degil: `OFFSET` = (page-1) x 48, ve
 * kullanicinin elle yazdigi `?page=999999999` Postgres'i 48 milyar satir
 * atlamaya calisirken oyalardi. Sinir, bu urunun gorebilecegi her listeden
 * buyuk ve bir saldiri yuzeyinden kucuk.
 */
const MAX_PAGE = 10_000

export function parseExploreParams(raw: ExploreSearchParams): ExploreQuery {
  const rawTab = first(raw.tab)
  const tab = (TAB_KEYS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabKey)
    : DEFAULT_TAB

  const rawPage = first(raw.page)
  const parsed = rawPage !== undefined && /^\d{1,6}$/.test(rawPage) ? Number(rawPage) : 1
  const page = Math.min(Math.max(1, parsed), MAX_PAGE)

  const { sort, ageDays } = TABS[tab]
  return { tab, sort, ageDays, page }
}

/** Sekme seridindeki etiketler, URL sirasinda. */
export const TAB_LABELS: ReadonlyArray<{ key: TabKey; label: string }> = TAB_KEYS.map((key) => ({
  key,
  label: TABS[key].label,
}))

/**
 * Bir sekmenin adresi. SAYFA TASINMAZ ve bu bilincli: "Top"un 7. sayfasindan
 * "New"a gecen biri 7. sayfada degil BASTA olmali -- baska bir listenin 7.
 * sayfasi onun icin anlamsiz bir yerdir, ve cogu zaman bos bir sayfadir.
 */
export function tabHref(tab: TabKey): string {
  return tab === DEFAULT_TAB ? '/' : `/?tab=${tab}`
}

/** Numarali sayfalayicinin koruyacagi parametreler (sayfa numarasi HARIC). */
export function tabQuery(query: ExploreQuery): Record<string, string> {
  return query.tab === DEFAULT_TAB ? {} : { tab: query.tab }
}
