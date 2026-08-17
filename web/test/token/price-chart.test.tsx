import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SLIP_BPS,
  HIGH_SLIP_BPS,
  slipSeverity,
  SlippageRow,
  VERY_HIGH_SLIP_BPS,
} from '@/components/token/SlippageRow'
import type { CandleRow } from '@/lib/read'

/**
 * ============================================================================
 *  FIYAT GRAFIGI VE SLIPAJ SATIRI
 * ============================================================================
 *
 * `lightweight-charts` bir `<canvas>` cizer ve jsdom'da canvas yoktur. Bu
 * yuzden kutuphane SAHTELENIR ve olculen sey piksel degil, KUTUPHANEYE NE
 * VERILDIGI: hangi seri turu, hangi noktalar, hangi olcek.
 *
 * Bu, elle yazilmis SVG surumunden daha zayif bir test degil -- daha DOGRU
 * bir test. Onceki surumde SVG'nin `d` niteligini okuyorduk ve o testler,
 * "her mum bir doji" ve "sekiz mum grafigin yedide birine sikismis" gibi
 * kusurlarin HIC BIRINI yakalamamisti; cunku hepsi gecerli birer `d` uretiyor.
 * Cizimin dogrulugu artik TradingView'in sorunu; bizim sorunumuz ona dogru
 * sayilari vermek.
 */

/*
 * SAHTELERIN IMZASI ACIKCA YAZILIR. `vi.fn(() => …)` bagimsiz degisken almayan
 * bir fonksiyon uretir ve `mock.calls` o zaman `[]` (bos demet) olarak
 * tiplenir -- yani `calls[0][0]` DERLENMEZ. Imzayi yazmak, testin okudugu
 * seyin gercekten kutuphaneye giden bagimsiz degisken oldugunu tipte de
 * sabitler.
 */
const setData = vi.fn<(data: readonly Record<string, number>[]) => void>()
const addSeries = vi.fn<(kind: string, options?: Record<string, unknown>) => unknown>(() => ({
  setData,
  priceScale: () => ({ applyOptions: vi.fn() }),
}))
const removeSeries = vi.fn()
const subscribeCrosshairMove = vi.fn()
const fitContent = vi.fn()
/*
 * GRAFIK DUZEYINDE `applyOptions`. Eksen bicimlendirici (`tickMarkFormatter`)
 * yalnizca burada yasar -- `timeScale().applyOptions` tipinde YOKTUR. Sahte
 * onu tasimazsa bilesen `undefined`i cagirir ve on test birden duser; ilk
 * eklendiginde tam olarak bu oldu.
 */
const applyOptions = vi.fn<(options: Record<string, unknown>) => void>()

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => ({
    addSeries,
    removeSeries,
    subscribeCrosshairMove,
    applyOptions,
    timeScale: () => ({ fitContent }),
    remove: vi.fn(),
  })),
  // Seri turleri kimlik olarak ayirt edilsin diye birer isaretci.
  CandlestickSeries: 'candles-series',
  AreaSeries: 'area-series',
  HistogramSeries: 'histogram-series',
}))

const { PriceChart } = await import('@/components/token/PriceChart')

/** 1 USDC = 1e18 wei; market cap wei olceginde tasinir. */
const USDC = 10n ** 18n

function candle(minute: number, open: bigint, close: bigint): CandleRow {
  return {
    bucket: new Date(Date.UTC(2026, 7, 13, 12, minute)),
    openWei: open,
    highWei: open > close ? open : close,
    lowWei: open > close ? close : open,
    closeWei: close,
    volumeWei: 5n * USDC,
    trades: 2,
  }
}

/**
 * ============ GRAFIK ARTIK ASENKRON KURULUR ============
 *
 * `PriceChart` `lightweight-charts`i `await import(...)` ile TEMBEL yukler
 * (gerekce o dosyanin basinda: kutuphane token rotasinin %27'siydi ve JS
 * butcesini asiyordu). Efekt artik senkron bitmiyor: import bir mikro gorevde
 * cozulur, grafik ondan SONRA kurulur.
 *
 * Yani `render(...)` donduginde `createChart` HENUZ CAGRILMAMISTIR. Bu
 * yardimci o bekleyisi TEK YERDE tutar; her testin kendi `waitFor`unu yazmasi
 * biri unuttugunda sessizce yaris kazanan bir test uretirdi.
 */
async function renderChart(ui: React.ReactElement) {
  const result = render(ui)
  await waitFor(() => {
    expect(addSeries).toHaveBeenCalled()
  })
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('<PriceChart>', () => {
  it('MUM secildiginde mum serisi, CIZGI secildiginde alan serisi kurulur', async () => {
    const rows = [candle(0, 10n * USDC, 12n * USDC), candle(5, 12n * USDC, 11n * USDC)]

    const { unmount } = await renderChart(
      <PriceChart candles={rows} metric="fdv" shape="candles" />,
    )
    expect(addSeries.mock.calls.map((c) => c[0])).toContain('candles-series')
    unmount()

    vi.clearAllMocks()
    await renderChart(<PriceChart candles={rows} metric="fdv" shape="line" />)
    const kinds = addSeries.mock.calls.map((c) => c[0])
    expect(kinds).toContain('area-series')
    expect(kinds, 'the line chart still drew candles').not.toContain('candles-series')
  })

  it('WEI DEGIL USDC gecirilir -- ham wei `number`da sessizce yuvarlanirdi', async () => {
    /*
     * Kutuphane `number` ister. `Number(4_820_000_000_000_000_000n)` hala
     * guvenli araligin (9.007e15) COK uzerinde; olcegi once dusurmeden
     * gecirmek, kucuk mumlarin acilis ve kapanisini AYNI sayiya yuvarlar --
     * yani her mum yeniden bir doji olurdu.
     */
    await renderChart(
      <PriceChart
        candles={[candle(0, 4n * USDC + USDC / 2n, 5n * USDC)]}
        metric="fdv"
        shape="candles"
      />,
    )
    const points = setData.mock.calls.map((c) => c[0]).find((d) => d[0]?.['open'] !== undefined)
    expect(points?.[0]).toMatchObject({ open: 4.5, close: 5 })
  })

  it('FIYAT MODU degerleri 1e9`a boler -- eksen ile baslik ayni seyi okumali', async () => {
    /*
     * Fiyat, market cap`in tam olarak 1e9`da biri (`007_views.sql`: N = 1e27).
     * Bolme yapilmasaydi grafik "fiyat" yazip market cap cizerdi.
     */
    await renderChart(
      <PriceChart candles={[candle(0, 2n * USDC, 2n * USDC)]} metric="price" shape="candles" />,
    )
    const points = setData.mock.calls.map((c) => c[0]).find((d) => d[0]?.['open'] !== undefined)
    expect(points?.[0]?.['open']).toBeCloseTo(2 / 1e9, 12)
  })

  it('AYNI SANIYE IKI KEZ GECMEZ -- tekrar eden damga grafigi komple dusururdu', async () => {
    /*
     * `lightweight-charts` artan ve BENZERSIZ zaman ister; tekrar eden bir
     * damga "data must be asc ordered by time" ile ATAR ve o hata bir mumu
     * degil GRAFIGIN TAMAMINI kaybettirir. Bir veri hatasi en fazla bir mum
     * kaybettirmeli.
     */
    const dupe = [candle(0, USDC, USDC), candle(0, 2n * USDC, 2n * USDC), candle(5, USDC, USDC)]
    await renderChart(<PriceChart candles={dupe} metric="fdv" shape="candles" />)
    const points = setData.mock.calls.map((c) => c[0]).find((d) => d[0]?.['open'] !== undefined)
    expect(points).toHaveLength(2)
  })

  it('HACIM KENDI OLCEGINDE -- fiyat olcegini paylassaydi mumlari ezerdi', async () => {
    await renderChart(<PriceChart candles={[candle(0, USDC, USDC)]} metric="fdv" shape="candles" />)
    const histogram = addSeries.mock.calls.find((c) => c[0] === 'histogram-series')
    expect(histogram?.[1]).toMatchObject({ priceScaleId: '' })
  })

  it('BOS VERI grafigi kurmaz, bir metin yazar', async () => {
    render(<PriceChart candles={[]} metric="fdv" shape="candles" emptyLabel="No trades yet." />)
    expect(screen.getByTestId('price-chart-empty')).toHaveTextContent('No trades yet.')
    expect(screen.queryByTestId('price-chart')).toBeNull()
  })

  it('IMLEC ABONELIGI BIR KEZ KURULUR -- veri yenilendikce cogalmaz', async () => {
    /*
     * `LiveRefresh` on saniyede bir yeni bir `candles` dizisi getiriyor.
     * Abonelik veriye bagli olsaydi her yenilemede bir yenisi eklenir ve
     * dinleyiciler birikirdi.
     */
    const { rerender } = await renderChart(
      <PriceChart candles={[candle(0, USDC, USDC)]} metric="fdv" shape="candles" />,
    )
    rerender(<PriceChart candles={[candle(0, USDC, 2n * USDC)]} metric="fdv" shape="candles" />)
    rerender(<PriceChart candles={[candle(5, USDC, 3n * USDC)]} metric="fdv" shape="candles" />)
    expect(subscribeCrosshairMove).toHaveBeenCalledTimes(1)
  })

  it('OHLCV BASLIGI son mumu okur ve OLCUYU izler', async () => {
    const rows = [candle(0, USDC, USDC), candle(5, 3n * USDC, 7n * USDC)]
    const { rerender } = await renderChart(
      <PriceChart candles={rows} metric="fdv" shape="candles" />,
    )
    expect(screen.getByTestId('candle-summary')).toHaveTextContent('C $7.00')

    // Fiyat modunda ayni mum 1e9`da bir okunur; baslik eksenle ayni dili
    // konusmali, yoksa iki sayi arasinda bir milyar kat fark gorunur.
    rerender(<PriceChart candles={rows} metric="price" shape="candles" />)
    expect(screen.getByTestId('candle-summary')).not.toHaveTextContent('C $7.00')
  })

  it('ICERIGE SIGDIRIR -- kutuphane cubuk genisligini SABIT tutar', async () => {
    /*
     * `lightweight-charts` icerige gore yaymaz: on uc mum, genislik ne olursa
     * olsun sagda dar bir seride durur. Kullanicinin "mumlar bir kosede
     * sikismis" sikayeti, mum VERISI duzeldikten sonra bile bu yuzden devam
     * etti.
     */
    await renderChart(<PriceChart candles={[candle(0, USDC, USDC)]} metric="fdv" shape="candles" />)
    expect(fitContent).toHaveBeenCalled()
  })

  it('AMA HER YENILEMEDE SIFIRLAMAZ -- yoksa zoom on saniyede bir kaybolur', async () => {
    /*
     * `LiveRefresh` sunucu bilesenlerini on saniyede bir yeniden calistiriyor.
     * Her veri degisiminde sigdirmak, kullanicinin yakinlastirmasini surekli
     * geri alirdi. Yeni bir islem dizinin SONUNU degistirir; gorus alani
     * yalnizca dizinin BASI degisince sifirlanir.
     */
    const first = candle(0, USDC, 2n * USDC)
    const { rerender } = await renderChart(
      <PriceChart candles={[first]} metric="fdv" shape="candles" />,
    )
    const afterMount = fitContent.mock.calls.length

    rerender(
      <PriceChart
        candles={[first, candle(5, 2n * USDC, 3n * USDC)]}
        metric="fdv"
        shape="candles"
      />,
    )
    rerender(
      <PriceChart
        candles={[first, candle(5, 2n * USDC, 4n * USDC)]}
        metric="fdv"
        shape="candles"
      />,
    )
    expect(fitContent.mock.calls.length, 'the zoom was reset by a refresh').toBe(afterMount)

    // Zaman araligi degisince (5M -> 1H) dizinin BASI degisir: yeniden sigdirilir.
    rerender(
      <PriceChart candles={[candle(60, 5n * USDC, 6n * USDC)]} metric="fdv" shape="candles" />,
    )
    expect(fitContent.mock.calls.length).toBeGreaterThan(afterMount)
  })

  it('KONTROLLER BASLIGIN ICINDE cizilir', async () => {
    await renderChart(
      <PriceChart
        candles={[candle(0, USDC, USDC)]}
        metric="fdv"
        shape="candles"
        controls={<button type="button">1H</button>}
      />,
    )
    expect(screen.getByRole('button', { name: '1H' })).toBeInTheDocument()
  })

  /*
   * ============ EKSEN ETIKETI AY BILGISI TASIR ============
   *
   * Kutuphanenin varsayilani gun sinirinda YALNIZCA gun numarasini yazar --
   * "12", "13". Bildirilen kusur buydu: iki gun once mi iki ay once mi
   * oldugu okunamiyordu.
   *
   * Test bicimlendiriciyi GRAFIGE GIDERKEN yakalar, kendi kopyasini
   * cagirmaz: boylece hem etiketin dogrulugunu hem de kutuphaneye gercekten
   * BAGLANDIGINI olcer. Ikincisi olmadan, dogru bir fonksiyonu hic
   * baglamayan bir surum yesil kalirdi.
   */
  function lastFormatter(): (time: number) => string {
    const calls = applyOptions.mock.calls
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      const scale = calls[i]?.[0]?.['timeScale'] as
        { tickMarkFormatter?: (time: number) => string } | undefined
      if (scale?.tickMarkFormatter) return scale.tickMarkFormatter
    }
    throw new Error('grafige hic tickMarkFormatter gecilmedi')
  }

  // 2026-03-09T14:30:00Z
  const MARCH = Date.UTC(2026, 2, 9, 14, 30) / 1000

  it('EKSEN AYI YAZAR -- ciplak gun numarasi iki ay onceyi dunden ayirmaz', async () => {
    await renderChart(
      <PriceChart
        candles={[candle(0, USDC, USDC)]}
        metric="fdv"
        shape="candles"
        bucketSeconds={3_600}
      />,
    )
    const label = lastFormatter()(MARCH)
    expect(label).toMatch(/Mar/)
    expect(label).toMatch(/9/)
    // Saatlik kovada saat de gerekli: gun degisimi ekranda gorunmeli.
    expect(label).toMatch(/\d{2}:\d{2}/)
  })

  it('GUNLUK KOVADA SAAT YOK -- her etiket "00:00" ise saat bilgi tasimaz', async () => {
    await renderChart(
      <PriceChart
        candles={[candle(0, USDC, USDC)]}
        metric="fdv"
        shape="candles"
        bucketSeconds={86_400}
      />,
    )
    const label = lastFormatter()(MARCH)
    expect(label).toMatch(/Mar/)
    expect(label).not.toMatch(/\d{2}:\d{2}/)
  })

  /*
   * ============ "UC DUGME AYNI GRAFIGI GOSTERIYOR" ============
   *
   * Bildirilen kusur gercekti ama sorgu DOGRUYDU: o tokenin butun islemleri
   * iki kumede toplanmisti ve her kume 1H kovasina da 24H kovasina da tek
   * basina siğiyordu. Veriyi uydurmak yerine ekran bunu SOYLER.
   */
  it('IKI MUMDAN AZKEN SEBEBINI SOYLER', async () => {
    await renderChart(<PriceChart candles={[candle(0, USDC, USDC)]} metric="fdv" shape="candles" />)
    expect(screen.getByTestId('candle-scarcity')).toHaveTextContent(/1 candle at this timeframe/i)
  })

  it('UC VE UZERINDE NOT YOK -- surekli bir dipnot gurultudur', async () => {
    await renderChart(
      <PriceChart
        candles={[candle(0, USDC, USDC), candle(60, USDC, USDC), candle(120, USDC, USDC)]}
        metric="fdv"
        shape="candles"
      />,
    )
    expect(screen.queryByTestId('candle-scarcity')).toBeNull()
  })
})

/* ========================================================================== */

describe('<SlippageRow>', () => {
  it('VARSAYILAN %2.5 -- %1 bir bonding curve`de gereksiz yere reddettiriyordu', async () => {
    /*
     * Fiyat HER islemle hareket eder ve rezervler iki saniyede bir yenilenir;
     * kullanicinin gordugu kota, imzaladigi an birkac blok eskimis olabilir.
     */
    expect(DEFAULT_SLIP_BPS).toBe(250)
    render(<SlippageRow value={DEFAULT_SLIP_BPS} auto onChange={() => {}} />)
    expect(screen.getByTestId('slippage-value')).toHaveTextContent('2.5%')
  })

  it('AUTO`YA DONUS YOLU VAR -- kullanicinin bildirdigi kusur buydu', async () => {
    /*
     * Onceki hal: `auto` iken bir rozet, degilse HICBIR SEY. Kalemle bir sayi
     * girildikten sonra Auto`ya donmenin tek yolu SAYFAYI YENILEMEKTI. Bir
     * modun cikisi, girisi kadar gorunur olmali.
     */
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<SlippageRow value={800} auto={false} onChange={onChange} />)

    const back = screen.getByTestId('slippage-auto-reset')
    await user.click(back)
    expect(onChange).toHaveBeenCalledWith(DEFAULT_SLIP_BPS, true)
  })

  it('AUTO`dayken donus dugmesi YOK -- zaten oradasin', async () => {
    render(<SlippageRow value={DEFAULT_SLIP_BPS} auto onChange={() => {}} />)
    expect(screen.queryByTestId('slippage-auto-reset')).toBeNull()
    expect(screen.getByTestId('slippage-auto-badge')).toBeInTheDocument()
  })

  it('GENIS TOLERANS UYARIR -- ve uyari bir metin, bir renk degil', async () => {
    render(<SlippageRow value={900} auto={false} onChange={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent(/high slippage/i)
  })

  /*
   * ============ IKI KADEME, VE ARALARINDAKI SINIR ============
   *
   * Tek esikli halde %5 ile %50 ayni kirmizi ile yaziliyordu, yani kirmizi
   * anlamini kaybediyordu. Bu blok sinirin HER IKI yanini da olcer: esigin
   * KENDISI uyarir (`>=`), bir bps altisi UYARMAZ. Bir `>` yazim hatasi
   * ekranda dogru gorunur ve yalnizca boyle bir cift yakalar.
   */
  it.each([
    { bps: 0, severity: 'ok' },
    { bps: DEFAULT_SLIP_BPS, severity: 'ok' },
    { bps: HIGH_SLIP_BPS - 1, severity: 'ok' },
    { bps: HIGH_SLIP_BPS, severity: 'high' },
    { bps: VERY_HIGH_SLIP_BPS - 1, severity: 'high' },
    { bps: VERY_HIGH_SLIP_BPS, severity: 'very-high' },
    { bps: 10_000, severity: 'very-high' },
  ])('slipSeverity($bps) -> $severity', ({ bps, severity }) => {
    expect(slipSeverity(bps)).toBe(severity)
  })

  it('%5 KEHRIBAR "High slippage" -- bir tercih, bir kaza degil', async () => {
    render(<SlippageRow value={HIGH_SLIP_BPS} auto={false} onChange={() => {}} />)
    const warning = screen.getByTestId('slippage-warning')
    expect(warning).toHaveTextContent('High slippage')
    expect(warning).not.toHaveTextContent('Very high slippage')
    expect(warning.className).toContain('text-caution')
    expect(warning.className).not.toContain('text-negative')
  })

  it('%20 KIRMIZI "Very high slippage"', async () => {
    render(<SlippageRow value={VERY_HIGH_SLIP_BPS} auto={false} onChange={() => {}} />)
    const warning = screen.getByTestId('slippage-warning')
    expect(warning).toHaveTextContent('Very high slippage')
    expect(warning.className).toContain('text-negative')
    expect(warning.className).not.toContain('text-caution')
  })

  it('VARSAYILANDA HIC UYARI YOK -- her acilista bir unlem, unlemi degersizlestirir', async () => {
    render(<SlippageRow value={DEFAULT_SLIP_BPS} auto onChange={() => {}} />)
    expect(screen.queryByTestId('slippage-warning')).toBeNull()
    expect(screen.getByTestId('slippage-value').className).not.toContain('text-caution')
  })

  it('DEGERIN KENDISI DE RENKLENIR -- goz once sayiya gider', async () => {
    render(<SlippageRow value={HIGH_SLIP_BPS} auto={false} onChange={() => {}} />)
    expect(screen.getByTestId('slippage-value').className).toContain('text-caution')
  })
})
