'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { formatUsdcCompact } from '@arcpad/shared/browser'
import type { IChartApi, ISeriesApi, Time, UTCTimestamp } from 'lightweight-charts'
import type { CandleRow } from '@/lib/read'
import {
  PRICE_PANE_STRETCH,
  PRICE_SCALE_MARGINS,
  VOLUME_PANE_INDEX,
  VOLUME_PANE_STRETCH,
  VOLUME_SCALE_MARGINS,
} from './chartBands'

/**
 * ============ KUTUPHANE TEMBEL YUKLENIR, TIPLER STATIK KALIR ============
 *
 * `import type` DERLEMEDE SILINIR, yani bu satir paket boyutuna hicbir sey
 * eklemez; asagidaki `await import('lightweight-charts')` ise kutuphaneyi
 * KENDI parcasina alir ve ilk yukte GONDERMEZ.
 *
 * OLCULDU, VE SEBEP TAM OLARAK BUYDU (2026-08-17, `e2e:audit`): token rotasi
 * 340,3 kB gz gonderiyordu, butce 300 kB. Parca dokumu -- ki o dokumu
 * `budget.spec.ts`e bu turda EKLEDIK, cunku esik kirildiginda NEYIN kirdigini
 * soylemiyordu -- en agir parcanin **92,3 kB gz** oldugunu ve icinde
 * `lightweight-charts` bulundugunu gosterdi: tek basina rotanin %27'si.
 *
 * NICIN `next/dynamic` ILE BUTUN BILESEN DEGIL. `ssr: false` ile sarmak
 * baslikta duran OHLCV satirlarini, `controls`u ve bos-durum kutusunu da
 * sunucu ciziminden CIKARIRDI -- yani hem token sayfasinin JS'siz/dogrudan
 * cizim yolunu zayiflatir hem de yer ayirmayan bir yer tutucuyla CLS
 * uretirdi (`perf.spec.ts` CLS butcesi 0,05). Bilesenin ISKELETI sunucuda
 * kalir; yalnizca CIZIM MOTORU sonradan gelir, ve kutunun yuksekligi
 * (`h-[320px] sm:h-[380px]`) zaten sabit oldugu icin hicbir sey kaymaz.
 */
type ChartModule = typeof import('lightweight-charts')

/**
 * ============================================================================
 *  FIYAT GRAFIGI -- TRADINGVIEW'IN KENDI KUTUPHANESIYLE
 * ============================================================================
 *
 * Elle yazilmis SVG grafik UC TUR ile degistirildi ve sebep durust: her biri
 * ayri ayri duzeltildikten sonra bile grafik hala bir grafik gibi
 * DAVRANMIYORDU. Yakinlastirma, kaydirma, imlecin altindaki degeri okuma,
 * eksenin kendini seyreltmesi, mumun uzerine gelince degerleri gormek --
 * bunlarin hepsi ayri ayri yazilmasi gereken seyler ve hicbiri "bir dikdortgen
 * ciz" kadar basit degil. `lightweight-charts` (Apache-2.0, ~45 kB) bunlarin
 * tamamini TradingView'in kendi uygulamasindaki davranisla getiriyor.
 *
 * ============ NEDEN `number`, VE NEDEN BU GUVENLI ============
 *
 * Kutuphane `number` ister; bu depo ise her para degerini `bigint` tasir,
 * cunku market cap 4e18 ile 5e24 arasinda gezer ve `Number.MAX_SAFE_INTEGER`
 * 9e15'tir. Cevirim WEI'DEN DEGIL, USDC'DEN yapilir: `wei / 1e18` sonucu
 * 4.82 gibi bir sayidir ve orada `number` fazlasiyla yeterli.
 *
 * Yani `bigint` -> `number` gecisi olcek DEGISTIRDIKTEN SONRA olur. Ham wei'yi
 * `Number()`e vermek, kucuk degerlerde sessiz yuvarlama demekti -- bu dosyanin
 * tek gercek riski buydu ve tek satirda kapatildi.
 *
 * TAM DEGERLER TABLODA. Grafik bir SEKILDIR; bir kullanicinin kopyalayacagi
 * rakam islem tablosundadir ve o hala `bigint`ten biciimlendirilir.
 */

/** Grafigin cizecegi sekil. */
export type ChartShape = 'candles' | 'line'

/** Eksenin NEYI okudugu. Fiyat, market cap'in tam olarak 1e9'da biridir. */
export type ChartMetric = 'fdv' | 'price'

export type PriceChartProps = {
  candles: readonly CandleRow[]
  metric: ChartMetric
  shape: ChartShape
  /**
   * Baslik satirinin sagina konan sunucu-tarafi kontroller (sekil/olcu/zaman
   * seciciler). BIR `ReactNode` OLARAK GECER, bir fonksiyon olarak degil:
   * sunucu bileşenleri istemci bileşenlerine cocuk/prop olarak verilebilir --
   * onceden cizilmis olarak gelirler ve sinirdan gecen sey JSX'in kendisi
   * degil, cizilmis ciktisidir.
   */
  controls?: ReactNode
  emptyLabel?: string
  /**
   * SECILI KOVA GENISLIGI, SANIYE. Grafik veriden cikaramaz: bir kovanin bos
   * olmasi onu diziden DUSURUR (`chainCandles` bosluk doldurmaz), yani
   * ardisik iki mumun arasi kova genisligini SOYLEMEZ. Eksen bicimlendirici
   * ve "kac mum" notu ikisi de buna bakar.
   */
  bucketSeconds?: number
}

/**
 * EKSEN ETIKETI -- VE NICIN VARSAYILAN YETMEDI.
 *
 * `lightweight-charts`in kendi bicimlendiricisi gun sinirinda YALNIZCA gun
 * numarasini yazar: "12", "13". Kullanicinin bildirdigi kusur buydu ve
 * hakliydi -- ay bilgisi olmadan iki gun once mi iki ay once mi oldugu
 * okunamiyor. Ayrica saatlik kovalarda saat yazip gunu hic soylemiyordu, yani
 * gun degisimi ekranda GORUNMUYORDU.
 *
 * Kural KOVA GENISLIGINE gore: gunluk kovalarda tarih yeter, daha kisa
 * kovalarda gun+ay VE saat gerekir. `en-US` her yerde oldugu gibi acikca
 * verilir.
 */
function tickLabel(seconds: number, bucketSeconds: number): string {
  const at = new Date(seconds * 1000)
  const day = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (bucketSeconds >= 86_400) return day
  const time = at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}

/** 18 ondalikli wei -> USDC. Grafik olcegine gecisin TEK yeri. */
function toUsdc(wei: bigint, metric: ChartMetric): number {
  const scaled = metric === 'fdv' ? wei : wei / 1_000_000_000n
  // Once tam sayi kismi, sonra ondalik: dogrudan Number(wei)/1e18 buyuk
  // degerlerde tam sayi kismini bozardi.
  const whole = scaled / 10n ** 18n
  const frac = scaled % 10n ** 18n
  return Number(whole) + Number(frac) / 1e18
}

export function PriceChart({
  candles,
  metric,
  shape,
  controls,
  emptyLabel = 'No trades yet.',
  bucketSeconds = 3_600,
}: PriceChartProps) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  /**
   * Tembel yuklenen kutuphane. Seri kurucularina (`CandlestickSeries`,
   * `AreaSeries`) IKINCI efekt de ihtiyac duyar, o yuzden modul bir ref'te
   * saklanir -- ikinci kez `import` etmek gerekmez, ES modulleri onbelleklidir
   * ama bir ref niyeti de acikca yazar.
   */
  const modRef = useRef<ChartModule | null>(null)
  const priceRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Area'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  /*
   * IMLECIN ALTINDAKI MUM, ZAMAN DAMGASIYLA ARANIR.
   *
   * `subscribeCrosshairMove` bir kez baglanir; eger bagi `candles`e
   * baglasaydik `LiveRefresh`in her yenilemesinde abonelik sokulup yeniden
   * takilirdi. Bu yuzden satirlar bir REF'te durur ve abone o ref'e bakar --
   * kapanis (closure) hep guncel veriyi gorur.
   */
  const rowsRef = useRef(new Map<number, CandleRow>())
  /* Ayni gerekce `rowsRef` ile: eksen bicimlendirici bir kez baglanir. */
  const bucketRef = useRef(bucketSeconds)
  bucketRef.current = bucketSeconds
  /*
   * GORUS ALANINI NE ZAMAN SIFIRLAMALI.
   *
   * `lightweight-charts` cubuk genisligini SABIT tutar ve icerige gore
   * yaymaz: on uc mum, genisligi ne olursa olsun sagda dar bir seride durur.
   * Olculdu -- ve "mumlar grafigin bir kosesine sikismis" sikayeti, mum
   * verisi duzeldikten SONRA bile bu yuzden devam etti. Care
   * `timeScale().fitContent()`.
   *
   * AMA HER YENILEMEDE DEGIL. `LiveRefresh` on saniyede bir yeni veri
   * getiriyor; her seferinde sigdirmak, kullanicinin yakinlastirmasini on
   * saniyede bir SIFIRLARDI. Bu yuzden yalnizca dizinin BASI degistiginde
   * sigdirilir: zaman araligi degistiginde (5M -> 1H) ya da grafik ilk kez
   * dolduğunda olan sey budur; bir islem eklenmesi ise dizinin SONUNU
   * degistirir ve gorusa dokunulmaz.
   */
  const fittedFrom = useRef<number | null>(null)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [ready, setReady] = useState(false)

  /*
   * GRAFIK BIR KEZ KURULUR, VERI AYRI BIR EFEKTTE GUNCELLENIR.
   *
   * `LiveRefresh` sunucu bilesenlerini on saniyede bir yeniden calistiriyor,
   * yani `candles` sik sik yeni bir dizi olarak geliyor. Grafigi her seferinde
   * yeniden kursaydik kullanicinin yakinlastirmasi ve kaydirmasi her on
   * saniyede bir SIFIRLANIRDI -- elle yazilmis surumde bu ayri bir efektle
   * cozulmustu; burada da ayni ayrim geciyor.
   */
  const hasData = candles.length > 0

  useEffect(() => {
    const node = boxRef.current
    // Kutu ancak veri varken cizilir; ilk islem geldiginde bu efekt
    // `hasData` degistigi icin YENIDEN calisir ve grafigi o an kurar.
    if (node === null || !hasData) return

    /*
     * EFEKT ASENKRON BIR GOVDE SARAR, VE IPTAL BAYRAGI ZORUNLUDUR: import
     * cozulmeden once bilesen sokulebilir (`hasData` degisir ya da kullanici
     * sayfadan cikar) ve o durumda grafigi kurmak, temizligi hic kosmayacak
     * bir grafik birakmak olurdu.
     */
    let chart: IChartApi | null = null
    let cancelled = false

    void (async () => {
      const mod: ChartModule = await import('lightweight-charts')
      if (cancelled || boxRef.current === null) return
      modRef.current = mod

      chart = mod.createChart(node, {
        autoSize: true,
        layout: {
          background: { color: 'transparent' },
          textColor: '#8a8a8a',
          fontFamily: 'inherit',
          attributionLogo: false,
        },
        grid: {
          // Cok soluk: bir okuma yardimcisi, bir desen degil.
          vertLines: { color: 'rgba(255,255,255,0.04)' },
          horzLines: { color: 'rgba(255,255,255,0.04)' },
        },
        rightPriceScale: {
          borderColor: 'rgba(255,255,255,0.08)',
          // Mumlarin inebilecegi ALT SINIR -- bkz. `PRICE_SCALE_MARGINS`.
          scaleMargins: PRICE_SCALE_MARGINS,
        },
        timeScale: {
          borderColor: 'rgba(255,255,255,0.08)',
          timeVisible: true,
          secondsVisible: false,
          // `bucketRef` uzerinden okunur, dogrudan `bucketSeconds` DEGIL: bu
          // efekt yalnizca `hasData` degistiginde kosar, yani zaman dilimi
          // degistiginde kapanis (closure) eski degeri tasirdi.
          tickMarkFormatter: (time: number) => tickLabel(time, bucketRef.current),
        },
        crosshair: {
          // `Magnet`: imlec en yakin mumun degerine YAPISIR. Bir fiyat
          // grafiginde kullanici bir NOKTAYA degil bir MUMA bakar.
          mode: 1,
          vertLine: { color: 'rgba(255,255,255,0.25)', labelBackgroundColor: '#2a2a2a' },
          horzLine: { color: 'rgba(255,255,255,0.25)', labelBackgroundColor: '#2a2a2a' },
        },
        localization: {
          // LOCALE ACIKCA VERILIR -- bu depodaki her tarih/sayi bicimi gibi.
          locale: 'en-US',
        },
      })
      chartRef.current = chart

      /*
       * HACIM KENDI OLCEGINDE, ALTTA.
       *
       * AYRI BIR PANE, ayni pane'in alt seridi DEGIL. Marjla ayirmak cakismayi
       * bitiriyordu ama fiyat eksenini NEGATIFE indiriyordu (bos marj da olcekte
       * yer kaplar; canli grafikte `-10.00` okundu). Kendi pane'inde hacmin
       * kendi ekseni olur ve fiyat ekseni yalnizca fiyati olcer. Ayni olcegi paylassalardi hacim cubuklari fiyat eksenini
       * ezer ve mumlar ekranin ustunde bir seride sikisirdi.
       */
      const volume = chart.addSeries(
        mod.HistogramSeries,
        { priceFormat: { type: 'volume' } },
        VOLUME_PANE_INDEX,
      )
      volume.priceScale().applyOptions({ scaleMargins: VOLUME_SCALE_MARGINS })

      // PANE YUKSEKLIKLERI ORAN OLARAK. Sabit bir piksel degeri kucuk ekranda
      // hacmi ezer, buyuk ekranda grafigin yarisini bos birakir.
      const panes = chart.panes()
      panes[0]?.setStretchFactor(PRICE_PANE_STRETCH)
      panes[VOLUME_PANE_INDEX]?.setStretchFactor(VOLUME_PANE_STRETCH)
      volumeRef.current = volume

      /*
       * OHLCV BASLIGI IMLECI TAKIP EDER -- TradingView'de oldugu gibi.
       *
       * Onceki hal baslikta HER ZAMAN son mumu gosteriyordu; yani grafikte
       * geriye bakan biri gordugu mumun degerlerini OKUYAMIYORDU. Imlec
       * grafikten cikinca (`param.time === undefined`) baslik son muma doner.
       */
      chart.subscribeCrosshairMove((param) => {
        setHoverTime(typeof param.time === 'number' ? param.time : null)
      })

      setReady(true)
    })()

    return () => {
      cancelled = true
      // `chart` asenkron govdede atanir; import cozulmeden sokulursa hala
      // `null`dur ve kaldirilacak bir sey yoktur.
      if (chart !== null) chart.remove()
      chartRef.current = null
      priceRef.current = null
      volumeRef.current = null
      setReady(false)
    }
  }, [hasData])

  /* SEKIL DEGISINCE seri degisir -- mum ile cizgi ayri seri turleri. */
  useEffect(() => {
    const chart = chartRef.current
    // `mod` `ready` ile BIRLIKTE dolar (ikisi de ilk efektin asenkron
    // govdesinde yazilir), ama kontrol acikca yapilir: tip guvenligi bir
    // sıralama varsayimina dayanmamali.
    const mod = modRef.current
    if (chart === null || mod === null || !ready) return

    if (priceRef.current !== null) {
      chart.removeSeries(priceRef.current)
      priceRef.current = null
    }

    priceRef.current =
      shape === 'candles'
        ? chart.addSeries(mod.CandlestickSeries, {
            upColor: '#4ade80',
            downColor: '#f87171',
            borderUpColor: '#4ade80',
            borderDownColor: '#f87171',
            wickUpColor: '#4ade80',
            wickDownColor: '#f87171',
          })
        : chart.addSeries(mod.AreaSeries, {
            lineColor: '#c6f24e',
            topColor: 'rgba(198,242,78,0.28)',
            bottomColor: 'rgba(198,242,78,0.02)',
            lineWidth: 2,
          })
  }, [shape, ready])

  /* VERI. Seri kurulduktan sonra, her `candles` degisiminde. */
  useEffect(() => {
    const series = priceRef.current
    const volume = volumeRef.current
    if (series === null || volume === null || !ready) return

    const times = new Set<number>()
    const rows = candles
      .map((c) => ({ c, time: Math.floor(c.bucket.getTime() / 1_000) }))
      /*
       * AYNI SANIYE IKI KEZ GECEMEZ. `lightweight-charts` artan ve BENZERSIZ
       * zaman ister; tekrar eden bir damga "Assertion failed: data must be
       * asc ordered by time" ile grafigi komple dusurur. Kovalar zaten
       * benzersiz, ama bir veri hatasi grafigi degil yalnizca bir mumu
       * kaybettirmeli.
       */
      .filter(({ time }) => (times.has(time) ? false : (times.add(time), true)))

    rowsRef.current = new Map(rows.map(({ c, time }) => [time, c]))

    if (shape === 'candles') {
      ;(series as ISeriesApi<'Candlestick'>).setData(
        rows.map(({ c, time }) => ({
          time: time as UTCTimestamp,
          open: toUsdc(c.openWei, metric),
          high: toUsdc(c.highWei, metric),
          low: toUsdc(c.lowWei, metric),
          close: toUsdc(c.closeWei, metric),
        })),
      )
    } else {
      ;(series as ISeriesApi<'Area'>).setData(
        rows.map(({ c, time }) => ({
          time: time as UTCTimestamp,
          value: toUsdc(c.closeWei, metric),
        })),
      )
    }

    volume.setData(
      rows.map(({ c, time }) => ({
        time: time as UTCTimestamp,
        value: toUsdc(c.volumeWei, 'fdv'),
        color: c.closeWei >= c.openWei ? 'rgba(74,222,128,0.35)' : 'rgba(248,113,113,0.35)',
      })),
    )

    /*
     * EKSENI YENIDEN BICIMLENDIRMEYE ZORLA. Bicimlendirici `bucketRef`i okur
     * ve o guncel, ama kutuphane etiketleri ONBELLEKLER: zaman dilimi
     * degistiginde ayni fonksiyon yeniden CAGRILMAZ ve eksende bir onceki
     * dilimin etiketleri kalir. `applyOptions` onbellegi gecersiz kilar.
     */
    // `chart.applyOptions({ timeScale })`, `timeScale().applyOptions()` DEGIL:
    // ikincisinin tipi `HorzScaleOptions`tir ve `tickMarkFormatter` orada
    // yoktur -- o secenek yalnizca grafik duzeyinde yasar.
    chartRef.current?.applyOptions({
      timeScale: { tickMarkFormatter: (time: number) => tickLabel(time, bucketRef.current) },
    })

    const firstTime = rows[0]?.time ?? null
    if (firstTime !== fittedFrom.current) {
      fittedFrom.current = firstTime
      chartRef.current?.timeScale().fitContent()
    }
  }, [candles, metric, shape, ready, bucketSeconds])

  /*
   * BASLIK: imlecin altindaki mum, yoksa SONUNCUSU.
   *
   * `hoverTime` bir zaman damgasi tutar, bir dizin degil: dizin, veri her
   * yenilendiginde BASKA bir muma kayardi ve imlec durdugu halde basliktaki
   * sayilar degisirdi.
   */
  const shown =
    (hoverTime === null ? undefined : rowsRef.current.get(hoverTime)) ?? candles[candles.length - 1]

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {shown === undefined ? (
          <span />
        ) : (
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] tabular-nums text-muted"
            data-testid="candle-summary"
          >
            <Pair k="O" v={formatUsdcCompact(scale(shown.openWei, metric))} />
            <Pair k="H" v={formatUsdcCompact(scale(shown.highWei, metric))} />
            <Pair k="L" v={formatUsdcCompact(scale(shown.lowWei, metric))} />
            <Pair k="C" v={formatUsdcCompact(scale(shown.closeWei, metric))} />
            <Pair k="V" v={formatUsdcCompact(shown.volumeWei)} />
          </div>
        )}
        {controls}
      </div>

      {candles.length === 0 ? (
        <div
          data-testid="price-chart-empty"
          className="flex h-[320px] items-center justify-center rounded-card border border-border bg-surface text-[13px] text-muted"
        >
          {emptyLabel}
        </div>
      ) : (
        <>
          <div
            ref={boxRef}
            data-testid="price-chart"
            className="h-[320px] w-full sm:h-[380px]"
            aria-label={`Price history, ${candles.length} points`}
            role="img"
          />
          {/*
            NICIN IKI DILIM AYNI GORUNUYOR -- SORULMADAN CEVAPLANIR.

            Bildirilen kusur suydu: "1H, 6H ve 24H ayni grafigi gosteriyor."
            Olculdu ve sorgu DOGRUYDU -- o tokenin butun islemleri iki sikiya
            kumede toplanmis, ve her kume 1 saatlik kovaya da 24 saatlik
            kovaya da TEK BASINA sigiyor. Yani uc dugme gercekten ayni iki
            mumu uretiyordu.

            Bunu "duzeltmek" veri uydurmak olurdu. Dogru olan, ekranin bunu
            SOYLEMESI: uc mumdan azken kullanici hem sayiyi hem sebebini
            gorur, ve daha kisa bir dilimin ise yarayacagini anlar. Esik
            UCTUR cunku iki mum bir grafik degildir, uc mum bir sekildir.
          */}
          {candles.length < 3 ? (
            <p className="text-[12px] leading-relaxed text-muted" data-testid="candle-scarcity">
              {candles.length === 1 ? '1 candle' : `${candles.length} candles`} at this timeframe —
              every trade so far falls inside{' '}
              {candles.length === 1 ? 'a single bucket' : `${candles.length} buckets`}. A shorter
              timeframe splits them further.
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

/**
 * BASLIK OLCUYU IZLER. Grafik fiyat modundayken eksen fiyati okur; baslik
 * market cap'i okumaya devam etseydi iki sayi arasinda 1e9 kat fark olur ve
 * kullanici hangisine bakacagini bilemezdi.
 */
function scale(wei: bigint, metric: ChartMetric): bigint {
  return metric === 'fdv' ? wei : wei / 1_000_000_000n
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <span>
      {k} <span className="text-text">{v}</span>
    </span>
  )
}

/** Zaman tipini disari veren yardimci -- testlerin `Time`i elle kurmasi icin. */
export type { Time }
