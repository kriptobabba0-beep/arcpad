/**
 * UC DURUM (S6, K5).
 *
 * `BondingCurve` iki bayrak tasir ve IKISI DE AYRI durumlardir:
 *   `complete`  -> satis arzi tukendi, curve kapandi, HAVUZ HENUZ ACILMADI.
 *   `graduated` -> `R` ve `D` hedefe odendi, havuz acildi.
 * Spec'in dort fazli yasam dongusu (`NotGraduated/Swept/PoolCreated/Rescued`)
 * kontratta YOKTUR ve yazilmayacaktir.
 *
 * ==========================================================================
 *  `graduated` ZORUNLU BIR ALAN, VE OPSIYONEL OLMASI OLCULEN BIR KUSURDU.
 * ==========================================================================
 *
 * Bu dosyanin eski yorumu "`graduated` dali BUGUN ULASILAMAZ" diyordu ve
 * gerekce olarak Faz 2'nin gelmemis olmasini gosteriyordu. GEREKCE YANLISTI.
 * Olculdu (2026-08-09): `packages/db/src/queries.ts` satirinda `graduated`,
 * `graduatedSeq`, `graduationTargetAddr`, `graduationBaseTok` ve
 * `graduationQuoteWei` ZATEN vardi ve `TokenOverview` ile sayfaya kadar
 * geliyordu; zincirde de `graduated()` gercek bir slot. Dal ulasilamazdi cunku
 * `app/token/[address]/page.tsx` alani GECMIYORDU:
 *
 *     resolveLifecycle({ complete: overview.complete })     // `graduated` yok
 *
 * `graduated` opsiyonel oldugu icin bu cagri DERLENIYORDU. Yani mezun olan ilk
 * token sonsuza kadar "Curve complete" olarak cizilecekti, arkasinda canli bir
 * havuzla, ve `test/token/token-page.test.tsx` elle kurdugu bir nesneyle
 * `{complete:true, graduated:true}` gecirip "Graduated" gordugu icin YESIL
 * kalacakti. BESLENEMEYEN BIR DAL DUSEMEZ; bileşenin testi, o dalin
 * URETILEBILIR oldugunu soylemez.
 *
 * DUZELTME BIR TEST DEGIL BIR TIP: alan artik ZORUNLU, dolayisiyla unutmak bir
 * DERLEME HATASI. Bu depoda `web/test/typecheck.test.ts` `tsc`yi gercekten
 * KOSTURUR, yani bu kapi iddia edilmis degil YURUTULMUS bir kapidir --
 * bugunku iki cagri yeri icin degil, YARIN yazilacak ucuncu icin de.
 * (`test/token/lifecycle-feed.test.ts` bunu ayrica bir kontrol projesiyle
 * olcer: alani atlayan bir cagri TS2345 verir.)
 */
export type Lifecycle =
  | { readonly kind: 'trading' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'graduated'; readonly poolNote: string }

export function resolveLifecycle(source: {
  complete: boolean
  /**
   * ZORUNLU. Cagiran bunu bilmiyorsa OKUMALIDIR -- indexer satirinda
   * (`TokenOverview.graduated`) ya da zincirde (`BondingCurve.graduated()`)
   * hazir duruyor. `false` yazip gecmek de bir karardir ama artik GORUNUR bir
   * karardir; atlamak mumkun degildir.
   */
  graduated: boolean
  poolNote?: string | undefined
}): Lifecycle {
  // SIRA: `graduated` ONCE. Zincirde `graduated => complete` her zaman dogrudur
  // (`graduate()` `!complete` ise `NotComplete()` ile doner), ama bayat bir
  // indexer satiri ikisini bir an icin ayrik gosterebilir ve o anda gosterilmesi
  // gereken sey DAHA ILERI olan durumdur.
  if (source.graduated) {
    return { kind: 'graduated', poolNote: source.poolNote ?? 'Trading has moved to the pool.' }
  }
  return source.complete ? { kind: 'complete' } : { kind: 'trading' }
}

/**
 * ARC'IN BLOK SURESI, ve grafik aralik pill'lerinin TEK KAYNAGI.
 *
 * Olculdu: ~350 ms. BLOK SURESI DEGISIRSE BURASI DEGISIR -- asagidaki dort
 * pencere bu sabitten turetilir, hicbiri elle yazilmaz. Elle yazilsalardi
 * blok suresi degistiginde "1H" etiketi bir saati gostermemeye baslar ve
 * hicbir test bunu fark etmezdi.
 */
export const BLOCKS_PER_SECOND = 1000 / 350

export type RangeKey = '5M' | '1H' | '6H' | '1D' | 'ALL'

/** Pencerenin BLOK cinsinden genisligi. `ALL` sinirsizdir. */
export function rangeToBlocks(range: RangeKey): number | null {
  const seconds: Record<Exclude<RangeKey, 'ALL'>, number> = {
    '5M': 5 * 60,
    '1H': 60 * 60,
    '6H': 6 * 60 * 60,
    '1D': 24 * 60 * 60,
  }
  if (range === 'ALL') return null
  return Math.round(seconds[range] * BLOCKS_PER_SECOND)
}

export const RANGE_KEYS: readonly RangeKey[] = ['5M', '1H', '6H', '1D', 'ALL']

/**
 * `eventSeq` -> blok numarasi.
 *
 * Faz 3'un kodlamasi: `eventSeq = (block << 20) | logIndex` (LOG_INDEX_BITS
 * = 20). X ekseni BUNDAN turetilir, duvar saatinden DEGIL: olculdu, 553
 * ardisik blok ciftinin 271'i (%49,0) ayni timestamp'i tasiyor, yani zamana
 * oturtulan bir eksende bloklarin yarisi UST USTE duser.
 */
export const LOG_INDEX_BITS = 20n

export function blockOfSeq(eventSeq: bigint): number {
  return Number(eventSeq >> LOG_INDEX_BITS)
}
