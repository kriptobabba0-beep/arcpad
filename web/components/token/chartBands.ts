/**
 * ============================================================================
 *  GRAFIGIN IKI SERIDI -- SAYILAR, CIZIMDEN AYRI
 * ============================================================================
 *
 * Bildirilen kusur (2026-08-19): fiyat mumlari hacim cubuklarinin ICINE
 * giriyordu.
 *
 * SEBEP OLCULDU: hacim `{ top: 0.8 }` ile alt seride yerlestirilmisti, ama
 * FIYAT olceginin `scaleMargins`i HIC AYARLANMAMISTI -- lightweight-charts'in
 * varsayilani `{ top: 0.2, bottom: 0.1 }`, yani mumlarin alt siniri 0.90'di.
 * 0.80 ile 0.90 arasi iki serinin USTUSTE bindigi seritti.
 *
 * IKI SAYININ AYRI YERLERDE DURMASI KUSURUN KENDISIYDI: biri degistiginde
 * otekinin de degismesi gerektigini hicbir sey soylemiyordu. Simdi yan yana
 * duruyorlar ve aralarindaki bosluk `chart-bands.test.ts`te SAYISAL bir iddia.
 *
 *   fiyat  : [0.10, 0.74]   (ust %10 nefes payi, alt sinir 1 - 0.26)
 *   BOSLUK : [0.74, 0.82]
 *   hacim  : [0.82, 1.00]
 *
 * VE BU DOSYA HICBIR SEY CIZMEZ. `TradeCard.tsx`teki ayrimin aynisi: JSX
 * tasimadigi icin bir `.ts` testinden dogrudan okunabilir -- bir gorsel
 * regresyonu ekran goruntusuyle degil SAYIYLA olcmenin yolu buydu.
 */

/** Fiyat seridi: ust marj nefes payi, alt marj hacme birakilan yer. */
export const PRICE_SCALE_MARGINS = { top: 0.1, bottom: 0.26 } as const

/** Hacim seridi: grafigin DIBINE oturur (`bottom: 0`), en altta ince bir band. */
export const VOLUME_SCALE_MARGINS = { top: 0.82, bottom: 0 } as const

/**
 * Iki serit arasinda kalan bosluk, grafik yuksekliginin orani olarak.
 *
 * Sifir ya da negatifse mumlar hacim cubuklarina girer -- kusurun tanimi budur
 * ve testte tam olarak bu deger olculur.
 */
export function bandGap(): number {
  return VOLUME_SCALE_MARGINS.top - (1 - PRICE_SCALE_MARGINS.bottom)
}
