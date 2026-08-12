import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CandleChart } from '@/components/token/CandleChart'
import type { CandleRow } from '@/lib/read'

/**
 * ============================================================================
 *  GRAFIK GEOMETRISI -- ILK DAGITIMDA GORULEN KUSURLARIN TESTI
 * ============================================================================
 *
 * Bu dosyadaki ilk iki test, sunucuya dagitip TARAYICIDA bakinca gorulen iki
 * seyi tutuyor. Ikisi de birim testlerinden gecmisti, cunku ikisi de "cizim
 * dogru mu" degil "cizim NE KADAR BUYUK" sorusuydu:
 *
 *   1. Dort islemi olan bir token'in mumlarinin hepsi ayni saate dustu, yani
 *      tek mum vardi ve `plotW / 1` onu 936 birim genisliginde yapti.
 *      Ekranda dev bir yesil dikdortgen.
 *   2. Su anki deger araligin en ustundeydi, dolayisiyla sagdaki fiyat
 *      etiketi grafigin ustunden TASTI ve rakam yariya kesildi.
 */

function candle(overrides: Partial<CandleRow> = {}): CandleRow {
  return {
    bucket: new Date('2026-08-11T00:00:00Z'),
    openWei: 6_000_000_000_000_000_000n,
    highWei: 60_000_000_000_000_000_000n,
    lowWei: 6_000_000_000_000_000_000n,
    closeWei: 58_000_000_000_000_000_000n,
    volumeWei: 11_000_000_000_000_000_000n,
    trades: 4,
    ...overrides,
  }
}

function bodies(container: HTMLElement): SVGRectElement[] {
  // Mum govdeleri: `<g>` icindeki `<rect>`ler. Hacim cubuklari ayri bir
  // gruptadir ve `class` tasir; govdeler tasimaz.
  return [...container.querySelectorAll('rect')].filter(
    (r) => r.getAttribute('fill') === 'currentColor' && r.getAttribute('class') === null,
  )
}

describe('CandleChart geometry', () => {
  it('TEK MUM BUTUN GENISLIGI KAPLAMAZ', () => {
    const { container } = render(
      <CandleChart candles={[candle()]} metric="fdv" currentWei={58_000_000_000_000_000_000n} />,
    )
    const [body] = bodies(container)
    expect(body).toBeDefined()
    const width = Number(body!.getAttribute('width'))
    // 936 birimlik alanda bir mum. Tavan 18, yani govde en fazla 16.
    expect(width).toBeGreaterThan(0)
    expect(width, 'a single candle stretched across the chart').toBeLessThanOrEqual(16)
  })

  it('EN YENI MUM SAGA OTURUR -- kesikli "su an" cizgisi de oradadir', () => {
    const rows = [
      candle({ bucket: new Date('2026-08-11T00:00:00Z') }),
      candle({ bucket: new Date('2026-08-11T01:00:00Z') }),
    ]
    const { container } = render(
      <CandleChart candles={rows} metric="fdv" currentWei={58_000_000_000_000_000_000n} />,
    )
    const xs = bodies(container).map((r) => Number(r.getAttribute('x')))
    expect(xs).toHaveLength(2)
    // Sagdaki mum, cizim alaninin sag kenarina (936) bir slot mesafesinde.
    expect(Math.max(...xs)).toBeGreaterThan(900)
    // Ve bosluk SOLDA: yeni gelen bir mum butun grafigi kaydirmaz.
    expect(Math.min(...xs)).toBeGreaterThan(880)
  })

  it('FIYAT ETIKETI CIZIM ALANINI TASMAZ -- deger tavandayken bile', () => {
    // Su anki deger mumlarin EN YUKSEGI: `currentY` sifira oturur ve etiket
    // eksi bir y ile ciziliyordu.
    const { container } = render(
      <CandleChart
        candles={[candle()]}
        metric="fdv"
        currentWei={60_000_000_000_000_000_000n}
      />,
    )
    const pill = container.querySelector('[data-testid="current-label"]')?.parentElement
    expect(pill).not.toBeNull()
    const transform = pill!.getAttribute('transform') ?? ''
    const y = Number(/translate\([^,]+,\s*([-\d.]+)\)/.exec(transform)?.[1])
    expect(Number.isFinite(y)).toBe(true)
    expect(y, 'the price pill is clipped off the top of the chart').toBeGreaterThanOrEqual(0)
  })

  it('ISLEMI OLMAYAN TOKEN: bos durum cizilir, sifir dolu bir mum DEGIL', () => {
    const { container } = render(
      <CandleChart candles={[]} metric="fdv" currentWei={4_000_000_000_000_000_000n} />,
    )
    expect(container.querySelector('[data-testid="candle-chart-empty"]')).not.toBeNull()
    expect(container.querySelector('svg')).toBeNull()
  })

  it('TEK ISLEMDE DE CIZER -- duz aralik sifira bolme uretmez', () => {
    // hi === lo: bir launchpad'in ilk saatinde YAYGIN durum, uc durum degil.
    const flat = candle({
      openWei: 4_000_000_000_000_000_000n,
      highWei: 4_000_000_000_000_000_000n,
      lowWei: 4_000_000_000_000_000_000n,
      closeWei: 4_000_000_000_000_000_000n,
      trades: 1,
    })
    const { container } = render(
      <CandleChart candles={[flat]} metric="fdv" currentWei={4_000_000_000_000_000_000n} />,
    )
    const [body] = bodies(container)
    const yValue = Number(body!.getAttribute('y'))
    expect(Number.isFinite(yValue), 'a flat range produced NaN coordinates').toBe(true)
  })

  it('OLCU FIYATA GECINCE EKSEN DEGISIR -- ayni egri, baska birim', () => {
    const asFdv = render(
      <CandleChart candles={[candle()]} metric="fdv" currentWei={58_000_000_000_000_000_000n} />,
    )
    const asPrice = render(
      <CandleChart candles={[candle()]} metric="price" currentWei={58_000_000_000_000_000_000n} />,
    )
    const fdvLabel = asFdv.container.querySelector('[data-testid="current-label"]')?.textContent
    const priceLabel = asPrice.container.querySelector('[data-testid="current-label"]')?.textContent
    // Ilk yazilisinda iki dal AYNI biciimlendiriciyi cagiriyordu, yani secim
    // ekranda hicbir sey yapmiyordu.
    expect(fdvLabel).not.toBe(priceLabel)
  })
})
