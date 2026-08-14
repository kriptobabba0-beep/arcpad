import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { VolumePanel } from '@/components/token/VolumePanel'
import {
  CHART_TF_PARAM,
  MetricPicker,
  TIMEFRAMES,
  TimeframePicker,
  timeframeKey,
  timeframeSeconds,
  VOLUME_TF_PARAM,
} from '@/components/token/ChartControls'

/**
 * ============================================================================
 *  GRAFIK KONTROLLERI -- IKI FILTRE, IKI PARAMETRE
 * ============================================================================
 *
 * Bildirilen kusur: "Volume bolumunun yanindaki 5m/1h/6h/24h filtrelerinden
 * birini secince mum grafiginin de filtresi degisiyor." Dogruydu -- ikisi tek
 * bir `?tf=` okuyordu.
 *
 * Bir birim testi burada ZORUNLU ve sebebi sudur: ayrim GORSEL DEGIL. Ekranda
 * iki ayri secici hep vardi; degisen tek sey her birinin hangi anahtari
 * yazdigi. Yani gozle bakan biri "duzeldi" der ve bir regresyonu goremez.
 * Uretilen `href` ise tam olarak o anahtari tasir.
 */
describe('zaman dilimi secicileri', () => {
  const params = { [CHART_TF_PARAM]: '1h', [VOLUME_TF_PARAM]: '24h', tab: 'holders' }

  function hrefs(): string[] {
    return screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href') ?? '')
      .sort()
  }

  it('GRAFIK SECICISI yalnizca `tf` yazar -- `vf` oldugu gibi kalir', () => {
    render(<TimeframePicker active="1h" params={params} param={CHART_TF_PARAM} />)
    for (const href of hrefs()) {
      expect(href).toContain('vf=24h')
    }
    expect(hrefs().some((h) => h.includes('tf=5m'))).toBe(true)
    // Hicbir baglanti hacim anahtarini DEGISTIRMEZ.
    expect(hrefs().some((h) => h.includes('vf=5m'))).toBe(false)
  })

  it('HACIM SECICISI yalnizca `vf` yazar -- `tf` oldugu gibi kalir', () => {
    render(<TimeframePicker active="24h" params={params} param={VOLUME_TF_PARAM} />)
    for (const href of hrefs()) {
      expect(href).toContain('tf=1h')
    }
    expect(hrefs().some((h) => h.includes('vf=5m'))).toBe(true)
    expect(hrefs().some((h) => h.includes('tf=5m'))).toBe(false)
  })

  it('SEKME KORUNUR -- dilim degistirmek acik sekmeyi kapatmamali', () => {
    render(<TimeframePicker active="1h" params={params} param={CHART_TF_PARAM} />)
    for (const href of hrefs()) expect(href).toContain('tab=holders')
  })

  /*
   * ============ DILIMLER: 5M / 1H / 4H / 24H ============
   *
   * `6h` `4h` ile degistirildi. Etiket ve saniye AYNI SATIRDA durur, cunku
   * ikisini iki dosyada tutmak "4H yazip alti saatlik kova cizen" bir grafigin
   * yoludur -- ve o hata ekranda DOGRU gorunur.
   */
  it('dort dilim, ve her etiket kendi saniyesini tasir', () => {
    expect(TIMEFRAMES.map((t) => t.key)).toEqual(['5m', '1h', '4h', '24h'])
    expect(TIMEFRAMES.map((t) => t.seconds)).toEqual([300, 3_600, 14_400, 86_400])
    // `as readonly string[]` ZORUNLU: `6h` artik BIRLESIM TIPINDE YOK, yani
    // dogrudan karsilastirma `TS2367` verir. Iddia yine de duruyor cunku
    // belgeledigi sey bir tip degil bir KARAR -- 6H kaldirildi, 4H geldi.
    expect((TIMEFRAMES.map((t) => t.key) as readonly string[]).includes('6h')).toBe(false)
  })

  it('BILINMEYEN dilim sayfayi dusurmez, varsayilana doner', () => {
    expect(timeframeKey('banana')).toBe('1h')
    expect(timeframeSeconds('banana')).toBe(3_600)
    expect(timeframeKey('6h')).toBe('1h')
    expect(timeframeSeconds('4h')).toBe(14_400)
  })
})

/**
 * FDV ARTIK SECIM DEGIL.
 *
 * Fiyat, FDV'nin tam olarak 1e9'da biri oldugu icin iki secenek AYNI mumlari
 * ayni oranlarda ciziyordu. Hicbir sey degistirmeyen bir dugme, kullanicinin
 * urune guvenini tam olarak boyle asindirir.
 */
describe('metrik etiketi', () => {
  it('FDV yazar ve BASILAMAZ -- gidilecek ikinci bir gorunum yok', () => {
    render(<MetricPicker />)
    const label = screen.getByTestId('metric-picker')
    expect(label).toHaveTextContent('FDV')
    expect(label.tagName).toBe('SPAN')
    expect(screen.queryByRole('link')).toBeNull()
    expect(label).not.toHaveTextContent('Price')
  })
})

/**
 * ============================================================================
 *  CAGRI YERI TESTI -- VE NICIN YUKARIDAKILER YETMEDI
 * ============================================================================
 *
 * Yukaridaki testler `TimeframePicker`i DOGRUDAN, `param` vererek cagiriyor ve
 * hepsi yesildi. Canli sayfada ise hacim dugmeleri hala `?tf=` yaziyordu:
 * `VolumePanel` bileseni `param`SIZ cagiriyordu ve varsayilan `tf`dir.
 *
 * Yani hata bilesende degil, ONU KULLANAN SATIRDAYDI -- ve o satiri hicbir
 * test okumuyordu. Bu blok tam olarak orayi okur.
 */
describe('VolumePanel kendi anahtarini yazar', () => {
  const split = {
    volumeWei: 1_000_000_000_000_000_000n,
    buyVolumeWei: 600_000_000_000_000_000n,
    sellVolumeWei: 400_000_000_000_000_000n,
    buys: 3,
    sells: 2,
    buyers: 2,
    sellers: 2,
  }

  it('hacim dugmeleri `vf` yazar ve `tf`ye DOKUNMAZ', () => {
    render(
      <VolumePanel
        split={split}
        timeframe="24h"
        params={{ [CHART_TF_PARAM]: '1h', [VOLUME_TF_PARAM]: '24h' }}
      />,
    )
    const links = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href') ?? '')
    expect(links.length).toBe(4)
    for (const href of links) expect(href).toContain('tf=1h')
    expect(links.some((h) => h.includes('vf=5m'))).toBe(true)
    // KRITIK IDDIA: hicbir hacim dugmesi grafigin dilimini degistirmez.
    expect(links.some((h) => h.includes('tf=5m'))).toBe(false)
  })
})
