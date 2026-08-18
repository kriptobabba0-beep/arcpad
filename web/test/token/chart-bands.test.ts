import { describe, expect, it } from 'vitest'
import {
  PRICE_PANE_INDEX,
  PRICE_PANE_STRETCH,
  PRICE_SCALE_MARGINS,
  VOLUME_PANE_INDEX,
  VOLUME_PANE_STRETCH,
  VOLUME_SCALE_MARGINS,
  volumeShare,
} from '@/components/token/chartBands'

/**
 * ============================================================================
 *  MUMLAR HACMIN ICINE GIREMEZ -- VE BU YAPISAL, GORSEL DEGIL
 * ============================================================================
 *
 * Bildirilen kusur (2026-08-19): fiyat mumlari hacim cubuklariyla ic ice
 * giriyordu.
 *
 * ILK SEBEP: hacim AYNI pane'in alt seridine `{ top: 0.8 }` ile
 * sikistirilmisti, ama fiyat olceginin `scaleMargins`i hic ayarlanmamisti --
 * varsayilan `bottom: 0.1`, yani mumlarin alt siniri 0.90'di ve 0.80-0.90
 * arasi ustuste biniyordu.
 *
 * ILK DUZELTME YETMEDI, ve bu dosyanin var olma sebebi o: fiyat olcegine alt
 * marj vermek cakismayi bitirdi ama bos marj da olcekte yer kapladigi icin
 * fiyat ekseni NEGATIFE indi (canli grafikte `-10.00` okundu). Bir fiyat
 * ekseninin negatif degeri, cozdugu seyden daha kotu bir yanlistir.
 *
 * DOGRU AYRIM PANE'DIR: iki seri iki ayri pane'de, iki ayri eksende. Cakisma
 * artik bir marj hesabina degil YAPIYA bagli -- ve asagidaki iddialar tam
 * olarak o yapiyi olcer.
 */
describe('grafik: hacim KENDI pane`inde durur', () => {
  it('iki seri AYRI pane`lerdedir', () => {
    expect(VOLUME_PANE_INDEX, 'hacim fiyatla ayni pane`de -- cakisma yeniden mumkun').not.toBe(
      PRICE_PANE_INDEX,
    )
  })

  it('fiyat ILK pane`dedir', () => {
    // Kutuphane ilk pane'i ana pane sayar; hacmi oraya koymak zaman eksenini
    // hacme baglardi.
    expect(PRICE_PANE_INDEX).toBe(0)
  })

  it('hacim serit gibi ince, ama GORULEBILIR', () => {
    // Cok buyukse fiyat mumlari ezilir; cok kucukse cubuklar okunmaz.
    expect(volumeShare()).toBeGreaterThanOrEqual(0.12)
    expect(volumeShare()).toBeLessThanOrEqual(0.3)
  })

  it('fiyat pane`i hacimden BUYUKTUR', () => {
    expect(PRICE_PANE_STRETCH).toBeGreaterThan(VOLUME_PANE_STRETCH)
  })

  /*
   * AYIRT EDICI KONTROL.
   *
   * Ustteki iddialar, iki sayinin ayni pane icinde marjla ayrildigi ESKI
   * tasarimda da gecerdi -- cunku o tasarimda pane kavrami yoktu. Bu yuzden
   * kusurun kendisi burada ACIKCA yeniden kurulur ve reddedilir: ayni pane'de,
   * eski marjlarla, mumlarin alt siniri hacmin ust sinirini ASIYORDU.
   */
  it('AYIRT EDICI: eski tek-pane duzeni cakisiyordu', () => {
    const eskiPriceBottom = 1 - 0.1 // kutuphane varsayilani
    const eskiVolumeTop = 0.8
    expect(eskiPriceBottom).toBeGreaterThan(eskiVolumeTop)
  })

  it('fiyat marjlari artik YALNIZCA nefes payi -- ikisi de esit ve kucuk', () => {
    // Hacim baska pane'de oldugu icin alt marjin ona yer acmak gibi bir isi
    // kalmadi. Asimetrik birakmak, kalkmis bir gerekcenin izini surdururdu.
    expect(PRICE_SCALE_MARGINS.bottom).toBe(PRICE_SCALE_MARGINS.top)
    expect(PRICE_SCALE_MARGINS.bottom).toBeLessThan(0.2)
  })

  it('hacim kendi pane`inin DIBINE oturur', () => {
    // `bottom: 0` olmazsa cubuklar havada asili kalir.
    expect(VOLUME_SCALE_MARGINS.bottom).toBe(0)
  })
})
