import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SlippageRow, DEFAULT_SLIP_BPS } from '@/components/token/SlippageRow'
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

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => ({
    addSeries,
    removeSeries,
    subscribeCrosshairMove,
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('<PriceChart>', () => {
  it('MUM secildiginde mum serisi, CIZGI secildiginde alan serisi kurulur', () => {
    const rows = [candle(0, 10n * USDC, 12n * USDC), candle(5, 12n * USDC, 11n * USDC)]

    const { unmount } = render(<PriceChart candles={rows} metric="fdv" shape="candles" />)
    expect(addSeries.mock.calls.map((c) => c[0])).toContain('candles-series')
    unmount()

    vi.clearAllMocks()
    render(<PriceChart candles={rows} metric="fdv" shape="line" />)
    const kinds = addSeries.mock.calls.map((c) => c[0])
    expect(kinds).toContain('area-series')
    expect(kinds, 'the line chart still drew candles').not.toContain('candles-series')
  })

  it('WEI DEGIL USDC gecirilir -- ham wei `number`da sessizce yuvarlanirdi', () => {
    /*
     * Kutuphane `number` ister. `Number(4_820_000_000_000_000_000n)` hala
     * guvenli araligin (9.007e15) COK uzerinde; olcegi once dusurmeden
     * gecirmek, kucuk mumlarin acilis ve kapanisini AYNI sayiya yuvarlar --
     * yani her mum yeniden bir doji olurdu.
     */
    render(
      <PriceChart
        candles={[candle(0, 4n * USDC + USDC / 2n, 5n * USDC)]}
        metric="fdv"
        shape="candles"
      />,
    )
    const points = setData.mock.calls.map((c) => c[0]).find((d) => d[0]?.['open'] !== undefined)
    expect(points?.[0]).toMatchObject({ open: 4.5, close: 5 })
  })

  it('FIYAT MODU degerleri 1e9`a boler -- eksen ile baslik ayni seyi okumali', () => {
    /*
     * Fiyat, market cap`in tam olarak 1e9`da biri (`007_views.sql`: N = 1e27).
     * Bolme yapilmasaydi grafik "fiyat" yazip market cap cizerdi.
     */
    render(
      <PriceChart candles={[candle(0, 2n * USDC, 2n * USDC)]} metric="price" shape="candles" />,
    )
    const points = setData.mock.calls.map((c) => c[0]).find((d) => d[0]?.['open'] !== undefined)
    expect(points?.[0]?.['open']).toBeCloseTo(2 / 1e9, 12)
  })

  it('AYNI SANIYE IKI KEZ GECMEZ -- tekrar eden damga grafigi komple dusururdu', () => {
    /*
     * `lightweight-charts` artan ve BENZERSIZ zaman ister; tekrar eden bir
     * damga "data must be asc ordered by time" ile ATAR ve o hata bir mumu
     * degil GRAFIGIN TAMAMINI kaybettirir. Bir veri hatasi en fazla bir mum
     * kaybettirmeli.
     */
    const dupe = [candle(0, USDC, USDC), candle(0, 2n * USDC, 2n * USDC), candle(5, USDC, USDC)]
    render(<PriceChart candles={dupe} metric="fdv" shape="candles" />)
    const points = setData.mock.calls.map((c) => c[0]).find((d) => d[0]?.['open'] !== undefined)
    expect(points).toHaveLength(2)
  })

  it('HACIM KENDI OLCEGINDE -- fiyat olcegini paylassaydi mumlari ezerdi', () => {
    render(<PriceChart candles={[candle(0, USDC, USDC)]} metric="fdv" shape="candles" />)
    const histogram = addSeries.mock.calls.find((c) => c[0] === 'histogram-series')
    expect(histogram?.[1]).toMatchObject({ priceScaleId: '' })
  })

  it('BOS VERI grafigi kurmaz, bir metin yazar', () => {
    render(<PriceChart candles={[]} metric="fdv" shape="candles" emptyLabel="No trades yet." />)
    expect(screen.getByTestId('price-chart-empty')).toHaveTextContent('No trades yet.')
    expect(screen.queryByTestId('price-chart')).toBeNull()
  })

  it('IMLEC ABONELIGI BIR KEZ KURULUR -- veri yenilendikce cogalmaz', () => {
    /*
     * `LiveRefresh` on saniyede bir yeni bir `candles` dizisi getiriyor.
     * Abonelik veriye bagli olsaydi her yenilemede bir yenisi eklenir ve
     * dinleyiciler birikirdi.
     */
    const { rerender } = render(
      <PriceChart candles={[candle(0, USDC, USDC)]} metric="fdv" shape="candles" />,
    )
    rerender(<PriceChart candles={[candle(0, USDC, 2n * USDC)]} metric="fdv" shape="candles" />)
    rerender(<PriceChart candles={[candle(5, USDC, 3n * USDC)]} metric="fdv" shape="candles" />)
    expect(subscribeCrosshairMove).toHaveBeenCalledTimes(1)
  })

  it('OHLCV BASLIGI son mumu okur ve OLCUYU izler', () => {
    const rows = [candle(0, USDC, USDC), candle(5, 3n * USDC, 7n * USDC)]
    const { rerender } = render(<PriceChart candles={rows} metric="fdv" shape="candles" />)
    expect(screen.getByTestId('candle-summary')).toHaveTextContent('C $7.00')

    // Fiyat modunda ayni mum 1e9`da bir okunur; baslik eksenle ayni dili
    // konusmali, yoksa iki sayi arasinda bir milyar kat fark gorunur.
    rerender(<PriceChart candles={rows} metric="price" shape="candles" />)
    expect(screen.getByTestId('candle-summary')).not.toHaveTextContent('C $7.00')
  })

  it('ICERIGE SIGDIRIR -- kutuphane cubuk genisligini SABIT tutar', () => {
    /*
     * `lightweight-charts` icerige gore yaymaz: on uc mum, genislik ne olursa
     * olsun sagda dar bir seride durur. Kullanicinin "mumlar bir kosede
     * sikismis" sikayeti, mum VERISI duzeldikten sonra bile bu yuzden devam
     * etti.
     */
    render(<PriceChart candles={[candle(0, USDC, USDC)]} metric="fdv" shape="candles" />)
    expect(fitContent).toHaveBeenCalled()
  })

  it('AMA HER YENILEMEDE SIFIRLAMAZ -- yoksa zoom on saniyede bir kaybolur', () => {
    /*
     * `LiveRefresh` sunucu bilesenlerini on saniyede bir yeniden calistiriyor.
     * Her veri degisiminde sigdirmak, kullanicinin yakinlastirmasini surekli
     * geri alirdi. Yeni bir islem dizinin SONUNU degistirir; gorus alani
     * yalnizca dizinin BASI degisince sifirlanir.
     */
    const first = candle(0, USDC, 2n * USDC)
    const { rerender } = render(<PriceChart candles={[first]} metric="fdv" shape="candles" />)
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

  it('KONTROLLER BASLIGIN ICINDE cizilir', () => {
    render(
      <PriceChart
        candles={[candle(0, USDC, USDC)]}
        metric="fdv"
        shape="candles"
        controls={<button type="button">1H</button>}
      />,
    )
    expect(screen.getByRole('button', { name: '1H' })).toBeInTheDocument()
  })
})

/* ========================================================================== */

describe('<SlippageRow>', () => {
  it('VARSAYILAN %2.5 -- %1 bir bonding curve`de gereksiz yere reddettiriyordu', () => {
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

  it('AUTO`dayken donus dugmesi YOK -- zaten oradasin', () => {
    render(<SlippageRow value={DEFAULT_SLIP_BPS} auto onChange={() => {}} />)
    expect(screen.queryByTestId('slippage-auto-reset')).toBeNull()
    expect(screen.getByTestId('slippage-auto-badge')).toBeInTheDocument()
  })

  it('GENIS TOLERANS UYARIR -- ve uyari bir metin, bir renk degil', () => {
    render(<SlippageRow value={900} auto={false} onChange={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent(/far from the quote/i)
  })
})
