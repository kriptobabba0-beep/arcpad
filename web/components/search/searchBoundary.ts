import type { Page, ReadResult, SearchSortKey, TokenOverview } from '@/components/read/types'

/**
 * ARAMANIN OKUMA SINIRI -- ve tek basina kalmasinin sebebi var.
 *
 * Task 7'nin geri kalani indi (`web/lib/read.ts`, `canonical.ts`,
 * `metadata.ts`) ama `searchTokens` INMEDI: brief'in Adim 2(a) maddesi
 * (`pg_trgm`, `migration 008`, `SORTS.relevance`) `packages/db`'ye ait ve o
 * paket baska bir izin sahibinde.
 *
 * Bu yuzden arama tek basina `unavailable` doner. Bu bir yer tutucu degil
 * BUGUNUN DOGRUSU: arama arkasinda bir sorgu yok. Route bunu 503 ve
 * `{ error: 'unavailable' }` olarak gecirir, modal da acik bir mesaj cizer --
 * yani bos bir sonuc listesi gostermek yerine, arama yapamadigini soyler.
 *
 * Silinmesi: `searchTokens` indiginde bu dosya gider ve route `@/lib/read`'ten
 * `readSearch` import eder. Imza bilerek `web/lib/read.ts`'in oteki
 * okuyucularindan biriymis gibi yazildi.
 */
export type SearchParams = {
  readonly q: string
  readonly sort: SearchSortKey
  readonly ageDays: number | null
  readonly cursor: string | null
  readonly limit: number
}

export async function readSearch(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _params: SearchParams,
): Promise<ReadResult<Page<TokenOverview>>> {
  return { ok: false, reason: 'unavailable', indexer: null }
}
