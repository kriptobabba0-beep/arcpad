import { describe, expect, it } from 'vitest'
import { bandGap, PRICE_SCALE_MARGINS, VOLUME_SCALE_MARGINS } from '@/components/token/chartBands'

/**
 * ============================================================================
 *  MUMLAR HACMIN ICINE GIREMEZ -- VE BU BIR SAYIDIR, BIR IZLENIM DEGIL
 * ============================================================================
 *
 * Bildirilen kusur (2026-08-19): fiyat mumlari hacim cubuklariyla ic ice
 * giriyordu.
 *
 * SEBEP: hacim `{ top: 0.8 }` ile alt seride yerlestirilmisti, ama fiyat
 * olceginin `scaleMargins`i hic ayarlanmamisti -- kutuphanenin varsayilani
 * `{ top: 0.2, bottom: 0.1 }`, yani mumlarin alt siniri 0.90'di. 0.80-0.90
 * arasi iki serinin ustuste bindigi seritti.
 *
 * Bu dosya iki seridin ARALIKLARINI karsilastirir. Bir gorsel regresyonu
 * ekran goruntusuyle kovalamak yerine, cakismanin TANIMINI olcer: fiyat
 * seridinin alt siniri, hacim seridinin ust sinirindan KUCUK olmali.
 */
describe('grafik seritleri: fiyat ile hacim ayri durur', () => {
  /** Fiyat seridinin alt siniri (0 = tepe, 1 = dip). */
  const priceBottom = 1 - PRICE_SCALE_MARGINS.bottom
  const volumeTop = VOLUME_SCALE_MARGINS.top

  it('fiyat seridi hacim seridine GIRMEZ', () => {
    expect(
      priceBottom,
      `mumlarin alt siniri ${priceBottom}, hacmin ust siniri ${volumeTop} -- ustuste biniyorlar`,
    ).toBeLessThan(volumeTop)
  })

  it('aralarinda GORULEBILIR bir bosluk vardir', () => {
    // Sifir bir bosluk teknik olarak "cakismiyor"dur ama iki serit bitisik
    // cizilir ve kullanicinin sikayeti tam olarak buydu. Alt sinir olculu:
    // yuksekligin %5'i, 300px'lik bir grafikte ~15px.
    expect(bandGap(), 'iki serit bitisik').toBeGreaterThanOrEqual(0.05)
  })

  it('AYIRT EDICI: eski degerler bu kontrolu GECEMEZ', () => {
    // Anti-vakumluk. Kusurun kendisi -- varsayilan `bottom: 0.1` ile
    // `top: 0.8` -- burada ACIKCA reddedilir, yoksa ustteki iddialarin
    // gercekten bir sey yakalayip yakalamadigi bilinmezdi.
    const eskiPriceBottom = 1 - 0.1
    const eskiVolumeTop = 0.8
    expect(eskiPriceBottom).toBeGreaterThan(eskiVolumeTop)
  })

  it('hacim seridi grafigin DIBINE oturur', () => {
    // `bottom: 0` olmazsa hacim havada asili kalir ve altinda anlamsiz bir
    // bosluk olusur -- serit bir taban degil, ikinci bir yuzer kutu olurdu.
    expect(VOLUME_SCALE_MARGINS.bottom).toBe(0)
  })

  it('fiyat seridi tepede de nefes payi birakir', () => {
    // Ust marj sifir olsaydi en yuksek mum eksen etiketine yapisirdi.
    expect(PRICE_SCALE_MARGINS.top).toBeGreaterThan(0)
  })
})
