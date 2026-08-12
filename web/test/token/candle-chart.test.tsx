import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CandleChart } from '@/components/token/CandleChart'
import { fillCandleGaps } from '@/lib/read'
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

  it('MUMLAR EKSENI DOLDURUR -- az sayidayken sagda kumelenmez', () => {
    /*
     * ILK DUZELTME SLOTU SINIRLIYORDU ve sonucu ikinci dagitimda goruldu:
     * sekiz mum sagda 144 birimlik bir kumeye sikisti, eksenin yedide altisi
     * bos kaldi. Slot artik yayilir, GOVDE sinirlanir -- iki ayri problem,
     * iki ayri cozum.
     */
    const rows = [
      candle({ bucket: new Date('2026-08-11T00:00:00Z') }),
      candle({ bucket: new Date('2026-08-11T01:00:00Z') }),
    ]
    const { container } = render(
      <CandleChart candles={rows} metric="fdv" currentWei={58_000_000_000_000_000_000n} />,
    )
    const xs = bodies(container).map((r) => Number(r.getAttribute('x')))
    expect(xs).toHaveLength(2)
    // Biri solda, biri sagda: eksen bastan sona kullanilir.
    expect(Math.min(...xs)).toBeLessThan(250)
    expect(Math.max(...xs)).toBeGreaterThan(600)
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

/**
 * ============================================================================
 *  BOS KOVALAR -- ZAMAN EKSENININ DOGRU SOYLEMESI
 * ============================================================================
 *
 * `listCandles` yalnizca islem olan kovalari doner. Doldurmadan cizilen bir
 * eksende yan yana duran iki mum uc gun arayla olabilir; grafik "az once islem
 * gordu" der, oysa token uc gundur sessizdir.
 *
 * DOLDURMA BIR TAHMIN DEGIL: bonding curve'de fiyat yalnizca alim/satimla
 * hareket eder, dolayisiyla islem olmayan bir saatte fiyat GERCEKTEN
 * degismemistir. Ayni doldurma bir hisse grafiginde bir varsayim olurdu.
 */
describe('fillCandleGaps', () => {
  const HOUR = 3_600
  const at = (iso: string): Date => new Date(iso)

  it('aradaki bos saatler DUZ mumlarla doldurulur', () => {
    const rows = [
      candle({ bucket: at('2026-08-11T00:00:00Z'), closeWei: 10n }),
      candle({ bucket: at('2026-08-11T03:00:00Z'), openWei: 10n, closeWei: 20n }),
    ]
    const filled = fillCandleGaps(rows, HOUR, at('2026-08-11T03:00:00Z'))

    expect(filled).toHaveLength(4)
    // 01:00 ve 02:00 -- islem yok, fiyat degismedi.
    expect(filled[1]!.openWei).toBe(10n)
    expect(filled[1]!.closeWei).toBe(10n)
    expect(filled[1]!.highWei).toBe(10n)
    expect(filled[1]!.lowWei).toBe(10n)
    expect(filled[1]!.volumeWei).toBe(0n)
    expect(filled[1]!.trades, 'a filled bucket must not claim trades').toBe(0)
  })

  it('EKSEN SIMDIYE KADAR UZAR -- son islemde bitmez', () => {
    // Uc gundur islem gormeyen bir token, son islemde biten bir eksenle
    // "az once islem gordu" gibi gorunurdu.
    const rows = [candle({ bucket: at('2026-08-11T00:00:00Z'), closeWei: 10n })]
    const filled = fillCandleGaps(rows, HOUR, at('2026-08-11T05:30:00Z'))
    expect(filled.length).toBeGreaterThan(1)
    expect(filled[filled.length - 1]!.bucket.toISOString()).toBe('2026-08-11T05:00:00.000Z')
    expect(filled[filled.length - 1]!.closeWei).toBe(10n)
  })

  it('BOS GIRDI BOS KALIR -- sifir dolu bir eksen uydurulmaz', () => {
    expect(fillCandleGaps([], HOUR, at('2026-08-11T05:00:00Z'))).toEqual([])
  })

  it('TAVAN VAR ve EN YENILER tutulur', () => {
    const rows = [candle({ bucket: at('2026-01-01T00:00:00Z'), closeWei: 7n })]
    const filled = fillCandleGaps(rows, HOUR, at('2026-08-11T00:00:00Z'))
    expect(filled.length).toBeLessThanOrEqual(240)
    // Sag kenar korunur: bir fiyat grafiginde onemli olan en yeni mumdur.
    expect(filled[filled.length - 1]!.bucket.toISOString()).toBe('2026-08-11T00:00:00.000Z')
  })
})

/**
 * ============================================================================
 *  BIR MUMUN ACILISI, BIR ONCEKININ KAPANISIDIR
 * ============================================================================
 *
 * OLCULDU, GERCEK ISLEMLERLE (LOCKED, 2026-08-12): her kovada tek islem
 * oldugunda `listCandles`in acilisi ile kapanisi ayni degeri veriyordu -- o
 * islemden SONRAKI market cap -- yani her mum sifir yukseklikte bir DOJI
 * cikiyordu. Fiyat 4.00'dan 5.53'e gitmisti ve grafikte bunu gosteren tek bir
 * govde yoktu.
 *
 * Bir mumun acilisi "bu kovadaki ilk islem" DEGILDIR: fiyat kova sinirinda
 * kaybolmaz, kaldigi yerden devam eder. "Yesil mum = fiyat bu kovada yukseldi"
 * ifadesi ancak boyle dogru olur.
 */
describe('mum zinciri', () => {
  const HOUR = 3_600
  const at = (iso: string): Date => new Date(iso)

  /** Tek islemli kova: `listCandles` acilis = kapanis dondurur. */
  const single = (iso: string, mcap: bigint): CandleRow => ({
    bucket: at(iso),
    openWei: mcap,
    highWei: mcap,
    lowWei: mcap,
    closeWei: mcap,
    volumeWei: 10n ** 18n,
    trades: 1,
  })

  it('ACILIS bir onceki KAPANIS olur -- tek islemli kovalar govde kazanir', () => {
    const filled = fillCandleGaps(
      [single('2026-08-11T00:00:00Z', 100n), single('2026-08-11T01:00:00Z', 150n)],
      HOUR,
      at('2026-08-11T01:00:00Z'),
    )
    expect(filled).toHaveLength(2)
    // Ilk mum kendi acilisini korur -- oncesinde bir fiyat yok.
    expect(filled[0]!.openWei).toBe(100n)
    // Ikincisi 100'den acilir ve 150'de kapanir: GOVDESI VAR.
    expect(filled[1]!.openWei).toBe(100n)
    expect(filled[1]!.closeWei).toBe(150n)
    expect(filled[1]!.closeWei).toBeGreaterThan(filled[1]!.openWei)
  })

  it('YUKSEK VE DUSUK yeni acilisi KAPSAR -- fitil govdeyi kesmez', () => {
    // Dusen bir mum: 200'den acilir, 150'de kapanir. Kovanin kendi ucu
    // degerleri 150'ydi; acilis onun USTUNDE ve yuksek genisletilmeli.
    const filled = fillCandleGaps(
      [single('2026-08-11T00:00:00Z', 200n), single('2026-08-11T01:00:00Z', 150n)],
      HOUR,
      at('2026-08-11T01:00:00Z'),
    )
    const second = filled[1]!
    expect(second.openWei).toBe(200n)
    expect(second.highWei).toBeGreaterThanOrEqual(second.openWei)
    expect(second.lowWei).toBeLessThanOrEqual(second.closeWei)
    // Ve mum GERCEKTEN dusen: kirmizi govde cizilecek.
    expect(second.closeWei).toBeLessThan(second.openWei)
  })

  it('DOLDURULMUS kovalar duz KALIR -- zincirleme onlari bozmaz', () => {
    const filled = fillCandleGaps(
      [single('2026-08-11T00:00:00Z', 100n), single('2026-08-11T03:00:00Z', 100n)],
      HOUR,
      at('2026-08-11T03:00:00Z'),
    )
    // Aradaki iki kovada islem yok: acilis = kapanis = 100, hacim sifir.
    expect(filled[1]!.openWei).toBe(100n)
    expect(filled[1]!.closeWei).toBe(100n)
    expect(filled[1]!.volumeWei).toBe(0n)
  })
})
