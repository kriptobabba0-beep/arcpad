/**
 * SAYFA NUMARALARININ MANTIGI -- `.ts`, `.tsx` DEGIL.
 *
 * `params.ts` ayni sebeple ayri duruyor ve gerekcesi orada olculmus: `unit`
 * test projesi node ortaminda `.ts` kosar ve bir `.tsx`ten import etmek o
 * projede "invalid JS syntax" verir. Saf mantik burada durur, `NumberedPager`
 * yalnizca cizer -- boylece kenar durumlari (pencerenin uca dayanmasi, tek
 * sayfayi gizleyen elips) bir React derleyicisi olmadan test edilebilir.
 */

/** Ekranda en fazla kac numara gorunur (elipsler haric). */
const WINDOW = 5

/**
 * Cizilecek numaralar, ve nerede `…` olacagi.
 *
 * Kural: ILK ve SON her zaman gorunur, mevcut sayfanin etrafinda bir pencere
 * acilir, aradaki bosluklar `null` ile isaretlenir. `null` bir SAYFA DEGILDIR
 * ve tiklanamaz -- eski bir surumde `…` bir <Link>ti ve kullaniciyi
 * hesaplanamayan bir sayfaya goturuyordu.
 */
export function pageNumbers(current: number, pageCount: number): readonly (number | null)[] {
  if (pageCount <= 0) return []
  if (pageCount <= WINDOW + 2) {
    return Array.from({ length: pageCount }, (_, i) => i + 1)
  }

  /*
   * ORTA BANT HER ZAMAN TAM `WINDOW` SAYIDIR.
   *
   * Ilk hal `Math.max(2, current - half)` ile BASLIYORDU ve bu, bandin bir uca
   * dayandiginda kac slot kaybettigi bilgisini YOK EDIYORDU: 1. sayfada bant
   * uce dusuyor, ortada bese cikiyordu. Sonuc, serit her tiklamada genislik
   * degistiriyordu -- ust uste "sonraki"ye basan biri dugmenin yerinden
   * oynadigini gorur ve isabet ettiremez.
   *
   * Dogrusu once TASMAYI hesaplayip oteki uca aktarmak, kirpmayi EN SONA
   * birakmak.
   */
  const half = Math.floor(WINDOW / 2)
  let start = current - half
  let end = current + half

  if (start < 2) {
    end += 2 - start
    start = 2
  }
  if (end > pageCount - 1) {
    start -= end - (pageCount - 1)
    end = pageCount - 1
  }
  start = Math.max(2, start)

  const out: (number | null)[] = [1]
  // Elips YALNIZCA gercekten gizlenen sayfa varsa. Tek bir sayfayi gizleyen
  // bir `…`, o sayfanin numarasindan genistir ve tiklanabilir bir hedefi
  // tiklanamaz bir isaretle degistirir.
  if (start > 2) out.push(null)
  for (let n = start; n <= end; n++) out.push(n)
  if (end < pageCount - 1) out.push(null)
  out.push(pageCount)
  return out
}
