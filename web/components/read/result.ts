import type { FreshIndexer, IndexerStatus, StaleIndexer } from '@arcpad/db'
import type { ReadFailure, ReadResult } from '@/lib/read'

/**
 * `ReadResult`'I COZEN ISTEMCI-GUVENLI YARDIMCILAR.
 *
 * NEDEN `web/lib/read.ts`'ten IMPORT EDILMIYOR: o dosya `import 'server-only'`
 * ve `pg` tasiyor. `fold`/`valueOf`'u oradan DEGER olarak yeniden ihrac etmek,
 * onlari kullanan her istemci bileşeni uzerinden `pg`'yi tarayici paketine
 * sokar. Olculdu -- `next build` tam olarak boyle kirildi:
 *
 *   An error occurred while generating the chunk item
 *   [project]/web/lib/read.ts [app-client] (ecmascript)
 *
 * Tip `import type` ile geliyor (calisma zamaninda silinir), gerceklestirim
 * burada duruyor. Ayni desen `@arcpad/shared/browser`'in var olma sebebiyle
 * aynidir ve ayni sebeple bir kopya degil bir SINIRDIR: bu dosya yalnizca
 * `ReadResult`'in dallarini acar, baska hicbir sey bilmez.
 *
 * On dokuz satirlik saf mantik iki yerde duruyor; alternatif, veritabani
 * surucusunu tarayiciya gondermekti.
 */
export function fold<T, R>(
  result: ReadResult<T>,
  handlers: {
    fresh: (data: T, indexer: FreshIndexer) => R
    stale: (data: T, indexer: StaleIndexer) => R
    missing: (reason: ReadFailure, indexer: IndexerStatus | null) => R
  },
): R {
  if (!result.ok) return handlers.missing(result.reason, result.indexer)
  return result.stale
    ? handlers.stale(result.staleData, result.indexer)
    : handlers.fresh(result.data, result.indexer)
}

/** Deger, ve elde olmayabilecegi cagri yerinde ACIKCA gorunur. */
export function valueOf<T>(result: ReadResult<T>): T | undefined {
  return fold(result, {
    fresh: (data) => data,
    stale: (data) => data,
    missing: () => undefined,
  })
}

/**
 * Bayat DALI ise durum, degilse `null`. Uyari cizimi buna bakar.
 *
 * Donen tip `StaleIndexer`, `IndexerStatus` DEGIL: `<StaleNotice>` NEDEN bayat
 * oldugunu (`why`) ve varsa ne kadar geride oldugunu (`at.blocksBehind`) yazar,
 * ve genis birlesim tipi bunlarin ikisini de her cizimde yeniden daraltmayi
 * gerektirirdi.
 */
export function stalenessOf<T>(result: ReadResult<T>): StaleIndexer | null {
  return result.ok && result.stale ? result.indexer : null
}
