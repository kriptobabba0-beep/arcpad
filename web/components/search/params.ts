import type { WireTokenOverview } from '@/components/read/wire'
import {
  SEARCH_SORT_KEYS,
  type Canonicity,
  type HexAddress,
  type SearchSortKey,
} from '@/components/read/types'

/**
 * ⌘K'NIN SORGU SOZLESMESI -- rotanin ve modalin ORTAK dosyasi.
 *
 * Neden burada ve `app/api/search/route.ts` icinde degil: modal bir istemci
 * bileseni, rota ise sunucuda kosar. Tipleri rota modulunden import etmek,
 * `export const dynamic`/`runtime` tasiyan bir sunucu modulunu istemci
 * paketine surukler. Ayni sozlesmeyi iki yere yazmak ise ikisinin sessizce
 * ayrisması demektir: bir alan adi degistiginde derleyici yalnizca bir tarafi
 * kirar.
 */

/** `0x` + 40 hex. `HexAddress`'in kendisi bu sekli tarif eder. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * SORGU BIR ADRES MI?
 *
 * Kucuk harfe cevrilir, cunku veritabani `HexAddress`'i CHECK ile kucuk harf
 * zorunlu tutuyor ve EIP-55 saglama toplamı yalnizca bir GORUNUM'dur: ayni
 * adresin buyuk/kucuk harfli iki yazimi ayni hesaptir. Kullanicinin
 * yapistirdigi harflendirmeyi korumak, ekranda "senin yazdiginla BIREBIR
 * eslestik" izlenimi verirdi -- oysa eslesme kucuk harfli bicim uzerinden
 * yapiliyor.
 */
export function asAddressQuery(q: string): HexAddress | null {
  const value = q.trim()
  return ADDRESS_RE.test(value) ? (value.toLowerCase() as HexAddress) : null
}

/**
 * YAPISTIRILAN ADRESIN HUKMU.
 *
 * `refused` dalinin YALNIZCA adres tasimasi bir kaza degil, bu gorevin
 * guvenlik ozelligi: sunucu o dalda isim/sembol HIC OKUMAZ, dolayisiyla
 * istemciye gonderilecek bir isim YOKTUR. Gonderilseydi, hatali tek bir
 * kosul ekrana gercek bir launch'in adini yazdirabilirdi -- sahtekarligin
 * isleyis bicimi tam olarak budur.
 *
 * `indexed` dalinda `verifyCanonical` HIC CAGRILMAZ: veritabanindaki her satir
 * `LaunchFactory`'nin `Launched` olayindan gelir ve Faz 3 kabulde kanonikligi
 * ayrica dogrular (plan, Task 7 Adim 4). Bir eth_call daha yapmak ayni
 * gercegi ikinci kez, dugumun gazi pahasina sorardi.
 */
export type PastedVerdict =
  | { readonly kind: 'indexed'; readonly address: HexAddress }
  | { readonly kind: 'notIndexed'; readonly address: HexAddress }
  | { readonly kind: 'refused'; readonly address: HexAddress; readonly canonicity: Canonicity }

export type SearchPayload = {
  readonly rows: readonly WireTokenOverview[]
  readonly nextCursor: string | null
  readonly total: number
  /** Metin aramasi yapildiysa `null`. Adres yapistirildiysa hukum. */
  readonly pasted: PastedVerdict | null
}

export type SearchResponse = SearchPayload | { readonly error: 'unavailable' }

export type SearchQuery = {
  readonly q: string
  readonly sort: SearchSortKey
  readonly ageDays: number | null
  readonly cursor: string | null
}

/**
 * `q` UZUNLUGU SINIRLIDIR ve sinir SUNUCUDA konur.
 *
 * Istemci 128 karakterden uzun bir sey gondermez ama istemci sozlesmeyi
 * zorlayan taraf degildir: `/api/search?q=<1 MB>` elle yazilabilir ve o dize
 * bir metin arama ifadesine parametre olarak baglanir. Parametre baglama
 * enjeksiyonu keser, MALIYETI kesmez -- 1 MB'lik bir desenle yapilan tarama
 * yine de veritabanini mesgul eder.
 */
const MAX_Q_LENGTH = 128

/** Bir sayfa. URL'den OKUNMAZ: sinirsiz `limit` bir ucuz DoS kolu olurdu. */
export const SEARCH_LIMIT = 20

/** Ekrandaki yas filtresi: All / 24h / 7d. `explore/params.ts` ile ayni tablo. */
const AGE_DAYS: Record<string, number | null> = { all: null, '1': 1, '7': 7 }

/**
 * URL'DEN GELEN DIZE HICBIR ZAMAN BIR SQL IFADESINE DONUSMEZ.
 *
 * `sort` burada bir ANAHTAR olarak cozulur; ifadenin kendisi `packages/db`'de
 * durur. `q` ise bir anahtar DEGIL bir DEGERDIR ve oldugu gibi tasinir --
 * kacislanmaz, `%` ile sarilmaz, tirnaklanmaz. Bunlarin hepsi "dizeyi SQL'e
 * hazirlamak" demektir ve dizeyi SQL'e HIC sokmamak varken yapilan her
 * hazirlik, bir gun eksik kalabilecek bir hazirliktir.
 *
 * `relevance` YALNIZCA `q` doluyken secilebilir. Bos bir sorguda "alaka"
 * siralayacak bir sey yoktur; istek onu isterse sessizce `recentBuys`'a duser.
 */
export function parseSearchParams(params: URLSearchParams): SearchQuery {
  const q = (params.get('q') ?? '').trim().slice(0, MAX_Q_LENGTH)

  const rawSort = params.get('sort')
  const whitelisted = (SEARCH_SORT_KEYS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as SearchSortKey)
    : null

  // Varsayilan sorguya BAGLIDIR: metin varsa alaka, yoksa son alimlar.
  const fallback: SearchSortKey = q === '' ? 'recentBuys' : 'relevance'
  const sort =
    whitelisted === null || (whitelisted === 'relevance' && q === '') ? fallback : whitelisted

  const rawAge = params.get('age')
  const ageDays = rawAge !== null && rawAge in AGE_DAYS ? (AGE_DAYS[rawAge] ?? null) : null

  // Keyset cursor'u bir `eventSeq`tir: ondalik basamaklar. Bu kontrol,
  // parametre baglamasinin YERINE gecmez, ONUNDE durur.
  const rawCursor = params.get('after')
  const cursor = rawCursor !== null && /^\d{1,20}$/.test(rawCursor) ? rawCursor : null

  return { q, sort, ageDays, cursor }
}

/** Istemcinin cagirdigi adres. Bos degerler YAZILMAZ -- URL okunabilir kalir. */
export function searchRequestUrl(input: {
  q: string
  sort: SearchSortKey
  age: string
  cursor?: string | null
}): string {
  const params = new URLSearchParams()
  params.set('q', input.q)
  params.set('sort', input.sort)
  if (input.age !== 'all') params.set('age', input.age)
  if (input.cursor) params.set('after', input.cursor)
  return `/api/search?${params.toString()}`
}

/**
 * Pill seridi. `recentBuys` BILEREK YOK: bos `q`'nun dustugu yer odur ve bos
 * `q` ile zaten hicbir sonuc cizilmez ("Type to search"), yani secilebilir bir
 * pill olarak gostermek olmayan bir listeyi siralatirdi.
 */
export const SEARCH_SORT_LABELS: ReadonlyArray<{ key: SearchSortKey; label: string }> = [
  { key: 'relevance', label: 'Relevance' },
  { key: 'marketCap', label: 'Market cap' },
  { key: 'volume', label: 'Volume' },
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
]

export const SEARCH_AGE_LABELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: '1', label: '24h' },
  { value: '7', label: '7d' },
]

/** Bir sonucun gidecegi yer. Tek yerde durur; iki cagiran da bunu kullanir. */
export function tokenHref(address: string): string {
  return `/token/${address}`
}
