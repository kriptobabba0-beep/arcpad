/**
 * ============================================================================
 *  FIYAT VE HACIM IKI AYRI PANE -- SAYILAR, CIZIMDEN AYRI
 * ============================================================================
 *
 * Bildirilen kusur (2026-08-19): fiyat mumlari hacim cubuklarinin ICINE
 * giriyordu.
 *
 * SEBEP OLCULDU. Hacim `{ top: 0.8 }` ile AYNI pane'in alt seridine
 * sikistirilmisti, ama FIYAT olceginin `scaleMargins`i hic ayarlanmamisti --
 * kutuphanenin varsayilani `{ top: 0.2, bottom: 0.1 }`, yani mumlarin alt
 * siniri 0.90'di. 0.80 ile 0.90 arasi iki serinin USTUSTE bindigi seritti.
 *
 * ILK DUZELTME MARJLA YAPILDI VE YETMEDI. Fiyat olcegine bir alt marj vermek
 * cakismayi bitirdi ama yeni bir sey uretti: bos marj da olcekte yer kapladigi
 * icin fiyat ekseni NEGATIFE indi (canli grafikte `-10.00` okundu). Bir fiyat
 * ekseninin negatif degeri, cozdugu seyden daha kotu bir yanlistir.
 *
 * DOGRU AYRIM PANE'DIR. lightweight-charts v5 `addSeries(..., paneIndex)`
 * veriyor: hacim KENDI pane'inde, KENDI ekseniyle durur ve fiyat ekseni
 * yalnizca fiyati olcer. Referans olarak bakilan arayuz de bunu yapiyor.
 *
 * Bu dosya HICBIR SEY CIZMEZ -- `TradeCard.tsx`teki ayrimin aynisi. JSX
 * tasimadigi icin bir `.ts` testinden dogrudan okunabilir, ve bir gorsel
 * regresyonu ekran goruntusuyle degil SAYIYLA olcmenin yolu buydu.
 */

/** Fiyat mumlari her zaman ilk pane'de. */
export const PRICE_PANE_INDEX = 0

/** Hacim AYRI bir pane'de; cakismanin yapisal olarak imkansiz oldugu yer. */
export const VOLUME_PANE_INDEX = 1

/**
 * Pane yukseklikleri ORAN olarak verilir, piksel olarak degil.
 *
 * Sabit bir piksel yuksekligi kucuk ekranda hacmi ezer, buyuk ekranda ise
 * grafigin yarisini bos birakir. `setStretchFactor` orani korur.
 */
export const PRICE_PANE_STRETCH = 4
export const VOLUME_PANE_STRETCH = 1

/** Hacim pane'inin toplam yukseklikteki payi. */
export function volumeShare(): number {
  return VOLUME_PANE_STRETCH / (PRICE_PANE_STRETCH + VOLUME_PANE_STRETCH)
}

/**
 * Fiyat olceginin marjlari -- artik YALNIZCA nefes payi.
 *
 * Hacim baska bir pane'de oldugu icin alt marjin ona yer acmak gibi bir isi
 * KALMADI; bu sayilar sadece en yuksek/en dusuk mumun eksen kenarina
 * yapismasini onler.
 */
export const PRICE_SCALE_MARGINS = { top: 0.1, bottom: 0.1 } as const

/** Hacim olcegi kendi pane'inin dibine oturur. */
export const VOLUME_SCALE_MARGINS = { top: 0.15, bottom: 0 } as const
