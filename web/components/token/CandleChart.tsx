import { formatPriceWeiPerToken, formatUsdcCompact } from '@arcpad/shared/browser'
import type { CandleRow } from '@/lib/read'

/**
 * ============================================================================
 *  MUM GRAFIGI -- SUNUCUDA CIZILIR, ISTEMCIDE HICBIR SEY HESAPLANMAZ
 * ============================================================================
 *
 * Bir `<svg>`, ve icindeki her sayi sunucuda `bigint` ile hesaplanir. Bunun
 * iki sebebi var ve ikincisi bu depoda defalarca odendi:
 *
 *   1. Grafik ILK BOYAMADA dolu gelir. Bir fiyat grafiginin once bos cizilip
 *      sonra dolmasi, bir launchpad'de "veri yok" ile "henuz yuklenmedi"yi
 *      ayirt edilemez kilar.
 *   2. OLCEKLEME `bigint` UZERINDE. Bir memecoin'in market cap'i 4e18 ile
 *      5e24 arasinda gezer; bu araligi `number`a cevirip olceklemek, kucuk
 *      degerlerde IEEE-754 yuvarlamasiyla mumlarin ustuste binmesi demektir.
 *      Yalnizca EKRAN KOORDINATI `number`a duser, ve o zaten piksel.
 *
 * MUM MU CIZGI MI: mum. Referans tasarim OHLC gosterir ve bir OHLC mumu, tek
 * bir kapanis cizgisinin gizledigi seyi -- ayni kova icindeki oynakligi --
 * gosterir. Bir memecoin'de o oynaklik bilginin kendisidir.
 */

/** Cizim alani. `viewBox` sabit; kap responsive olarak olceklenir. */
const W = 1_000
const H = 340
const VOL_H = 64
const PAD_R = 64 // sag fiyat ekseni
const PAD_B = 26 // tarih ekseni
const GAP = 2 // mumlar arasi bosluk, piksel
/**
 * BIR MUMUN AZAMI GENISLIGI.
 *
 * OLCULDU, ILK DAGITIMDA: dort islemi olan bir token'in mumlarinin hepsi ayni
 * saate dustu, yani grafikte TEK mum vardi ve `plotW / 1` onu 936 birim
 * genisliginde yapti -- ekranda dev bir yesil dikdortgen. Bir mum bir OLAYDIR;
 * genisligi kac tane oldugundan bagimsiz olmali.
 */
const MAX_BODY = 16

export type ChartMetric = 'fdv' | 'price'

export function CandleChart({
  candles,
  metric,
  currentWei,
  bucketSeconds = 3_600,
  emptyLabel = 'No trades yet.',
}: {
  candles: readonly CandleRow[]
  metric: ChartMetric
  /** Su ANKI deger -- kesikli cizgi ve sagdaki etiket bunu gosterir. */
  currentWei: bigint
  /** Kova boyutu -- tarih ekseninin BICIMINI belirler, verisini degil. */
  bucketSeconds?: number
  emptyLabel?: string
}) {
  if (candles.length === 0) {
    return (
      <div
        data-testid="candle-chart-empty"
        className="flex h-[280px] items-center justify-center rounded-card border border-border bg-surface text-[13px] text-muted"
      >
        {emptyLabel}
      </div>
    )
  }

  /*
   * OLCEK, MUMLARIN UCLARINDAN VE SU ANKI DEGERDEN. Su anki degeri araliga
   * KATMAK zorunlu: kesikli cizgi grafigin disinda kalirsa, kullanici fiyati
   * grafikte GOREMEDEN bir islem yapar.
   */
  let lo = candles[0]!.lowWei
  let hi = candles[0]!.highWei
  for (const c of candles) {
    if (c.lowWei < lo) lo = c.lowWei
    if (c.highWei > hi) hi = c.highWei
  }
  if (currentWei < lo) lo = currentWei
  if (currentWei > hi) hi = currentWei

  /*
   * DUZ BIR ARALIK CIZILEMEZ. Tek islemli bir token'da hi === lo olur ve
   * sifira bolme cikar; aralik yapay olarak %2 acilir, yani mum tam ortada
   * durur. Bir launchpad'in ilk saatinde bu YAYGIN durumdur, uc durum degil.
   */
  if (hi === lo) {
    const pad = hi / 50n === 0n ? 1n : hi / 50n
    hi = hi + pad
    lo = lo > pad ? lo - pad : 0n
  }
  const span = hi - lo

  const plotH = H - VOL_H - PAD_B
  const plotW = W - PAD_R
  /*
   * ============ SLOT YAYILIR, GOVDE SINIRLANIR ============
   *
   * Mumlar ekseni TAM olarak doldurur (slot = genislik / adet), ama GOVDE
   * `MAX_BODY` ile sinirlidir ve slotun ortasina cizilir.
   *
   * Ikisi ayri problemi cozuyor ve ilk yazilista biri otekini bozdu:
   *
   *   - Govde sinirsiz olsaydi, tek mumlu bir token'da o mum 936 birim
   *     genisliginde bir dikdortgen olurdu (olculdu, ilk dagitimda).
   *   - Slot sinirli olsaydi -- ilk duzeltmede oyleydi -- sekiz mum sagda
   *     144 birimlik bir kumeye sikisir ve eksenin yedide altisi bos kalirdi
   *     (bu da olculdu, ikinci dagitimda).
   *
   * Slotun yayilmasi zaman orantisini BOZMAZ: kovalar sureklidir (bkz.
   * `fillCandleGaps`), yani esit araliklarla yerlestirmek zaten dogru olan.
   */
  const slot = plotW / candles.length
  const body = Math.max(1, Math.min(slot - GAP, MAX_BODY))
  /** Govde slotun ORTASINDA: fitil ile govde ayni eksende olsun. */
  const inset = (slot - body) / 2

  /** Wei -> y pikseli. `bigint` olcekleme, yalnizca sonuc `number`. */
  const y = (wei: bigint): number => {
    const t = ((hi - wei) * 100_000n) / span
    return (Number(t) / 100_000) * plotH
  }

  let maxVol = 0n
  for (const c of candles) if (c.volumeWei > maxVol) maxVol = c.volumeWei
  const volY = (wei: bigint): number => {
    if (maxVol === 0n) return VOL_H
    const t = (wei * 100_000n) / maxVol
    return VOL_H - (Number(t) / 100_000) * VOL_H
  }

  const currentY = y(currentWei)

  /*
   * ============ EKSEN NE OKUR: FDV MI FIYAT MI ============
   *
   * MUMLARIN SEKLI DEGISMEZ ve bu bir eksiklik degil bir OLGU: fiyat, market
   * cap'in tam olarak 1e9'da biridir (`migrations/007_views.sql` -- N = 1e27,
   * olcek 1e18), yani ikisi ayni egrinin iki OLCUSU. Degisen sey ekseni ve
   * etiketi okuyan birim.
   *
   * Ilk yazilisinda iki dal da ayni biciimlendiriciyi cagiriyordu -- yani
   * secim EKRANDA HICBIR SEY yapmiyordu ve "iki grafik ayni" diye bir kusur
   * bildirilirdi. Fark artik gercek.
   */
  const label = (wei: bigint): string =>
    metric === 'fdv' ? formatUsdcCompact(wei) : `$${formatPriceWeiPerToken(wei / 1_000_000_000n)}`

  // DORT EKSEN ETIKETI: ustte, altta ve arada iki. Daha fazlasi bu yukseklikte
  // ust uste biner, daha azi olcegi okunamaz kilar.
  const ticks = [0, 1, 2, 3, 4].map((i) => {
    const wei = hi - (span * BigInt(i)) / 4n
    return { wei, y: y(wei) }
  })

  return (
    <div data-testid="candle-chart" className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[280px] w-full sm:h-[340px]"
        role="img"
        aria-label={`Price history, ${candles.length} candles`}
        preserveAspectRatio="none"
      >
        {/* YATAY IZGARA -- cok soluk. Bir okuma yardimcisi, bir desen degil. */}
        {ticks.map((t) => (
          <line
            key={`grid-${t.y}`}
            x1={0}
            x2={plotW}
            y1={t.y}
            y2={t.y}
            stroke="currentColor"
            strokeWidth={1}
            className="text-white/5"
          />
        ))}

        {/* MUMLAR */}
        {candles.map((c, i) => {
          const x = i * slot + inset
          const up = c.closeWei >= c.openWei
          const colour = up ? 'text-[#4ade80]' : 'text-[#f87171]'
          const yHigh = y(c.highWei)
          const yLow = y(c.lowWei)
          const yOpen = y(c.openWei)
          const yClose = y(c.closeWei)
          const top = Math.min(yOpen, yClose)
          // DOJI GORUNUR KALIR: acilis ve kapanis esitse govde sifir yuksekligi
          // olurdu ve mum ekrandan kaybolurdu. Bir piksel taban konur.
          const height = Math.max(1, Math.abs(yClose - yOpen))
          return (
            <g key={`c-${c.bucket.getTime()}`} className={colour}>
              <line
                x1={x + body / 2}
                x2={x + body / 2}
                y1={yHigh}
                y2={yLow}
                stroke="currentColor"
                strokeWidth={1}
              />
              <rect x={x} y={top} width={body} height={height} fill="currentColor" />
            </g>
          )
        })}

        {/* HACIM CUBUKLARI -- mumlarin ALTINDA, ayni x izgarasinda. */}
        <g transform={`translate(0, ${plotH + 8})`}>
          {candles.map((c, i) => {
            const x = i * slot + inset
            const up = c.closeWei >= c.openWei
            const top = volY(c.volumeWei)
            return (
              <rect
                key={`v-${c.bucket.getTime()}`}
                x={x}
                y={top}
                width={body}
                height={Math.max(0, VOL_H - top)}
                fill="currentColor"
                className={up ? 'text-[#4ade80]/45' : 'text-[#f87171]/45'}
              />
            )
          })}
        </g>

        {/*
          SU ANKI DEGER: kesikli cizgi + sagda kirmizi etiket.
          Referans tasarimda bu kirmizi, YONDEN BAGIMSIZ -- "su an burasi"
          demektir, "dusuyor" demez. Ayni rengi kullanmak, satis renginin
          anlamini bulandirmaz cunku etiket her zaman ayni yerde ve ayni
          bicimde durur.
        */}
        <line
          x1={0}
          x2={plotW}
          y1={currentY}
          y2={currentY}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="4 4"
          className="text-[#f87171]"
          data-testid="current-line"
        />

        {/* SAG FIYAT EKSENI */}
        {ticks.map((t) => (
          <text
            key={`tick-${t.y}`}
            x={plotW + 8}
            y={Math.min(Math.max(t.y, 9), plotH)}
            className="fill-muted text-[11px]"
            dominantBaseline="middle"
          >
            {label(t.wei)}
          </text>
        ))}

        {/*
          ETIKET CIZIM ALANININ ICINDE TUTULUR. Su anki deger araligin en
          ustundeyse `currentY` sifira yaklasir ve etiket yukaridan KIRPILIR --
          ilk dagitimda tam olarak bu oldu ve rakam yariya kesildi.
        */}
        <g transform={`translate(${plotW + 4}, ${Math.min(Math.max(currentY - 9, 0), plotH - 18)})`}>
          <rect width={PAD_R - 8} height={18} rx={3} className="fill-[#f87171]" />
          <text
            x={(PAD_R - 8) / 2}
            y={9}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-black text-[11px] font-medium"
            data-testid="current-label"
          >
            {label(currentWei)}
          </text>
        </g>

        {/* TARIH EKSENI -- en fazla alti etiket, esit araliklarla. */}
        <g transform={`translate(0, ${H - 6})`}>
          {dateTicks(candles, bucketSeconds).map((tick) => (
            <text
              key={`d-${tick.index}`}
              x={tick.index * slot + slot / 2}
              textAnchor="middle"
              className="fill-muted text-[11px]"
            >
              {tick.text}
            </text>
          ))}
        </g>
      </svg>
    </div>
  )
}

/**
 * Tarih ekseni etiketleri.
 *
 * `toLocaleDateString`e LOCALE ACIKCA VERILIR (`en-US`). Verilmeseydi etiket
 * sunucunun locale'ine gore degisir, SSR ile istemci ciziminin FARKLI metin
 * uretmesi mumkun olurdu -- React bunu bir hidrasyon uyusmazligi olarak
 * bildirir. Bu depoda ayni kural bir eslint kuraliyla zorlaniyor.
 */
function dateTicks(
  candles: readonly CandleRow[],
  bucketSeconds: number,
): Array<{ index: number; text: string }> {
  if (candles.length === 0) return []

  /*
   * ============ KAC ETIKET SIGAR: GENISLIKTEN, SAYIDAN DEGIL ============
   *
   * OLCULDU, DAGITTIKTAN SONRA: "Aug 8, 2 AM" gibi bir etiket ~70 birim yer
   * kaplar ve alti tanesi 936 birimlik eksende UST USTE BINIYORDU. Sabit bir
   * "en fazla alti" kurali yanlis soruyu cevapliyor -- dogru soru "bu metin
   * bu eksende kac kez YAN YANA sigar".
   *
   * Saatli etiketler gunluklerden genistir, dolayisiyla tavan da bicime gore
   * degisir. Sayi degil GENISLIK sayilir.
   */
  const sameDay = bucketSeconds < 86_400
  const labelWidth = sameDay ? 78 : 52
  const fits = Math.max(2, Math.floor((W - PAD_R) / labelWidth))
  const want = Math.min(fits, candles.length)
  const step = Math.max(1, Math.ceil(candles.length / want))

  /*
   * ============ ETIKET, KOVA BOYUTUNA GORE ============
   *
   * OLCULDU, DAGITTIKTAN SONRA: alti saatlik kovalarda eksen
   * "Aug 8  Aug 8  Aug 9  Aug 9  Aug 10  Aug 10" yaziyordu -- her gun iki kez,
   * ve hangi etiketin hangi mumu gosterdigi belirsiz. Gun adi, gunden KISA
   * kovalar icin yeterli bir etiket degil.
   *
   * Bir gunden kisa kovalarda saat de yazilir; gunluk ve ustunde yalnizca
   * tarih. Ve ardisik AYNI etiketler elenir: ayni metni iki kez yazmak, ekseni
   * daha yogun degil daha okunmaz yapar.
   */
  const format = (d: Date): string =>
    sameDay
      ? d.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          timeZone: 'UTC',
        })
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

  const out: Array<{ index: number; text: string }> = []
  for (let i = 0; i < candles.length; i += step) {
    const text = format(candles[i]!.bucket)
    if (out[out.length - 1]?.text === text) continue
    out.push({ index: i, text })
  }
  return out
}

/**
 * Grafigin ustundeki OHLCV satiri -- SON mumun degerleri.
 *
 * Referans tasarimda bu satir grafigin sol ustunde durur ve son mumu okur;
 * bir fare-uzerinde degeri yoktur, cunku bu bir sunucu bileseni. Fareyle
 * gezinme eklenirse bu satir onun hedefidir.
 */
export function CandleSummary({ candle }: { candle: CandleRow | undefined }) {
  if (candle === undefined) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted tabular-nums">
      <Pair k="O" v={formatUsdcCompact(candle.openWei)} />
      <Pair k="H" v={formatUsdcCompact(candle.highWei)} />
      <Pair k="L" v={formatUsdcCompact(candle.lowWei)} />
      <Pair k="C" v={formatUsdcCompact(candle.closeWei)} />
      <Pair k="V" v={formatUsdcCompact(candle.volumeWei)} />
    </div>
  )
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <span>
      {k} <span className="text-text">{v}</span>
    </span>
  )
}
