import { SORT_KEYS, type SortKey } from '@/components/read/types'

export type ExploreSearchParams = {
  sort?: string | string[] | undefined
  age?: string | string[] | undefined
  after?: string | string[] | undefined
}

export type ExploreQuery = {
  readonly sort: SortKey
  /** `null` = butun zamanlar. Aksi halde gun sayisi. */
  readonly ageDays: number | null
  readonly cursor: string | null
}

export const DEFAULT_SORT: SortKey = 'recentBuys'

/** Ekran gorutulerindeki yas filtresi: All / 24h / 7d. */
const AGE_DAYS: Record<string, number | null> = { all: null, '1': 1, '7': 7 }

/** `?sort=a&sort=b` -> Next dizi verir. Ilk deger baglayicidir. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * URL'DEN GELEN DIZE HICBIR ZAMAN BIR SQL IFADESINE DONUSMEZ.
 *
 * `sort` burada bir ANAHTAR olarak cozulur ve taninmayan her deger sessizce
 * varsayilana duser. Sessizce, cunku bir kullaniciya elle yazdigi URL icin
 * hata sayfasi gostermek bir sey kazandirmaz -- ama beyaz listenin disina
 * cikan bir degerin SORGUYA ULASMAMASI zorunludur. Ifadenin kendisi
 * `packages/db`'de durur; buradan gecen tek sey `SORTS`'un bir anahtaridir.
 *
 * `after` cursor'u opak bir dizedir ve DOGRULANIR: keyset cursor'u bir
 * `eventSeq`tir, yani ondalik basamaklardan olusur. Bunu kontrol etmek
 * cursor'un sorguya bir parametre olarak baglanmasindan ayri bir savunma
 * degil, ONUN ONUNDEKI savunmadir.
 */
export function parseExploreParams(raw: ExploreSearchParams): ExploreQuery {
  const rawSort = first(raw.sort)
  const sort = (SORT_KEYS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as SortKey)
    : DEFAULT_SORT

  const rawAge = first(raw.age)
  const ageDays = rawAge !== undefined && rawAge in AGE_DAYS ? (AGE_DAYS[rawAge] ?? null) : null

  /*
   * AYNI GENISLETME, AYNI SEBEP -- ve burada da sessizce kiriliyordu.
   *
   * Explore'un imleci her zaman bir `eventSeq` DEGILDIR: `marketCap` sirasinda
   * `market_cap_wei`, `volume` sirasinda `volume_24h_wei`, ikisi de
   * `numeric(78,0)`. Graduation civarindaki bir market cap zaten 20 basamagi
   * asar, ve asan her imlec `null`a dusup kullaniciyi birinci sayfaya geri
   * atardi. Ust sinir `numeric(78,0)`in kendi genisligidir; sinirsiz degil.
   */
  const rawCursor = first(raw.after)
  const cursor = rawCursor !== undefined && /^\d{1,78}$/.test(rawCursor) ? rawCursor : null

  return { sort, ageDays, cursor }
}

/**
 * `?seen=a.b.c` -> ziyaret edilen cursor yigini.
 *
 * BURADA, `KeysetPager.tsx`'te DEGIL: saf bir ayristirici ve `unit` test
 * projesi (node ortami, `.ts`) onu React derleyicisi olmadan calistirabilmeli.
 * Bir `.tsx` dosyasindan import etmek o projede "invalid JS syntax" verir --
 * olculdu.
 */
export function parseCursorStack(
  seen: string | string[] | undefined,
  after: string | null,
): string[] {
  const raw = Array.isArray(seen) ? seen[0] : seen
  const stack = raw === undefined || raw === '' ? [] : raw.split('.').filter((s) => /^\d+$/.test(s))
  if (after !== null) stack.push(after)
  return stack
}

/** Filtre seridindeki etiketler. Deger = URL'e yazilan sey. */
export const SORT_LABELS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'recentBuys', label: 'Recent buys' },
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'marketCap', label: 'Market cap' },
  { key: 'volume', label: 'Volume' },
]

export const AGE_LABELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: '1', label: '24h' },
  { value: '7', label: '7d' },
]

/** Mevcut sorguyu koruyarak tek bir anahtari degistiren bir href uretir. */
export function exploreHref(
  current: ExploreQuery,
  patch: { sort?: SortKey; age?: string },
): string {
  const params = new URLSearchParams()
  const sort = patch.sort ?? current.sort
  if (sort !== DEFAULT_SORT) params.set('sort', sort)

  const age = patch.age ?? (current.ageDays === null ? 'all' : String(current.ageDays))
  if (age !== 'all') params.set('age', age)

  // Bir filtre degistiginde cursor DUSURULUR. Tasinsaydi, yeni siralamada
  // anlami olmayan bir anahtardan devam edilirdi -- kullanici "Market cap"e
  // tikladiginda listenin ortasindan basliyor olurdu.
  const query = params.toString()
  return query === '' ? '/' : `/?${query}`
}
