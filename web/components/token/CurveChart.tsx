import { formatPriceWeiPerToken, priceWeiPerToken } from '@arcpad/shared/browser'
import type { TradeRow } from '@/components/read/types'
import { VisuallyHidden } from '@/components/ui/VisuallyHidden'
import { blockOfSeq } from './lifecycle'

/**
 * KUTUPHANE YOK, EL YAZIMI SVG.
 *
 * Bir grafik kutuphanesi paket boyutu, CSP genisligi ve bir bagimlilik daha
 * getirir; ihtiyacimiz IKI SERI ve BIR ISARETCI. `bigint -> number` donusumu
 * YALNIZCA son adimda, piksel hesabinda yapilir -- daha erken yapilsaydi
 * 78 basamakli rezervler IEEE-754'te anlamli basamak kaybederdi.
 */

const VIEW_W = 640
const VIEW_H = 240
const PAD = { left: 8, right: 8, top: 12, bottom: 8 }

export type CurveProfileLike = {
  readonly virtualTokenReserves: bigint
  readonly virtualQuoteReserves: bigint
  readonly saleSupply: bigint
}

export type CurvePoint = { readonly sold: bigint; readonly priceWei: bigint }

/**
 * BONDING CURVE'UN KENDISI: satilan tokena karsi fiyat.
 *
 * Sabit carpim invariant'i `vQ * vT = V * T` ile, `x` kadar token satildiginda
 *   vT = T - x,  vQ = V*T / (T - x),  fiyat = vQ / vT = V*T / (T-x)^2
 * Bu, `priceWeiPerToken`'in tanimiyla AYNI fonksiyondur -- grafik ile panel
 * ayni fiyat tanimini kullanir, iki tanim olsaydi kullanici gordugunden
 * farkli bir islem imzalardi.
 */
export function referenceCurve(profile: CurveProfileLike, samples = 64): CurvePoint[] {
  const T = profile.virtualTokenReserves
  const V = profile.virtualQuoteReserves
  const S = profile.saleSupply
  const points: CurvePoint[] = []

  for (let i = 0; i <= samples; i += 1) {
    const sold = (S * BigInt(i)) / BigInt(samples)
    const vT = T - sold
    // Tam olarak zincirin yaptigi bolme: `mulDiv(vQ, 1e18, vT)`.
    const vQ = (V * T) / vT
    points.push({ sold, priceWei: priceWeiPerToken(vQ, vT) })
  }
  return points
}

/**
 * ISLEMLERDEN GERCEKLESEN FIYAT SERISI.
 *
 * X ekseni `eventSeq >> 20`'den turetilen BLOK numarasidir, duvar saati
 * degil (K4, ve Faz 3'un olcumu: bloklarin ~%49'u ayni timestamp'i tasir --
 * zamana oturtulan bir eksende yarisi ust uste duser).
 *
 * Ornekleme: blok basina SON islem. ORTALAMA ALINMAZ -- ortalama, hicbir
 * zaman gerceklesmemis bir fiyati cizer ve kullanici onu bir islem sanir.
 */
export type RealisedPoint = {
  readonly block: number
  readonly priceWei: bigint
  readonly seq: bigint
  readonly at: Date
  /**
   * O ISLEMIN KENDI real token rezervi -- grafigin X EKSENININ kaynagi.
   *
   * Satilan miktar `saleSupply - realTokenReserves`tir ve cikarma BURADA
   * yapilmaz: paydasi profilden gelir, `realisedSeries`in elinde yoktur.
   * Bugunun rezervinden hesaplansaydi butun noktalar ayni x'e otururdu.
   */
  readonly realTokenReservesTok: bigint
}

export function realisedSeries(trades: readonly TradeRow[]): RealisedPoint[] {
  const lastPerBlock = new Map<number, RealisedPoint>()

  for (const trade of trades) {
    // Rezerv anlik goruntusu YOKSA nokta cizilmez. `listTrades` bu kolonlari
    // henuz secmiyor; olmayan bir rezervden fiyat uydurmak, grafigi gercekmis
    // gibi gosterip yanlis cizmek olurdu.
    if (
      trade.virtualQuoteReservesWei === undefined ||
      trade.virtualTokenReservesTok === undefined
    ) {
      continue
    }
    const block = blockOfSeq(trade.eventSeq)
    const point = {
      block,
      priceWei: priceWeiPerToken(trade.virtualQuoteReservesWei, trade.virtualTokenReservesTok),
      seq: trade.eventSeq,
      at: trade.blockTime,
      realTokenReservesTok: trade.realTokenReservesTok,
    }
    const existing = lastPerBlock.get(block)
    if (existing === undefined || point.seq > existing.seq) {
      lastPerBlock.set(block, point)
    }
  }

  return [...lastPerBlock.values()].sort((a, b) => a.block - b.block)
}

function path(points: ReadonlyArray<{ x: number; y: number }>): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
}

/**
 * DEVIASYON 3 -- BU FAZIN EN BELIRGIN URUN KARARI.
 *
 * Islemi olmayan (ya da iki islemi olan) bir tokenin fiyat grafigi
 * ANLAMSIZDIR: iki nokta, neredeyse dikey bir cizgi, ve hicbir bilgi.
 * arcpad bunun yerine BONDING CURVE'UN KENDISINI cizer -- satilan token
 * miktarina karsi fiyat, profil sabitlerinden hesaplanmis -- ve uzerine
 * mevcut konumu isaretler. Gerceklesen fiyatlar geldikce egrinin USTUNE
 * cizilir, egri solmus bir referans olarak kalir.
 *
 * Hic islem gormemis bir launch YAYGIN DURUMDUR, kenar durum degil: urunun
 * ilk gununde HER token boyledir.
 */
export function CurveChart({
  profile,
  soldTok,
  currentPriceWei,
  trades = [],
  progressPercent,
}: {
  profile: CurveProfileLike
  /** Su ana kadar satilan token (`S - realTokenReserves`). */
  soldTok: bigint
  currentPriceWei: bigint
  trades?: readonly TradeRow[]
  progressPercent: string
}) {
  const curve = referenceCurve(profile)
  const realised = realisedSeries(trades)

  const maxPrice = curve[curve.length - 1]?.priceWei ?? 1n
  const minPrice = curve[0]?.priceWei ?? 0n
  const S = profile.saleSupply

  // bigint -> number YALNIZCA BURADA, piksel hesabinda.
  const innerW = VIEW_W - PAD.left - PAD.right
  const innerH = VIEW_H - PAD.top - PAD.bottom
  const xOf = (sold: bigint) => PAD.left + (Number((sold * 10_000n) / S) / 10_000) * innerW
  const yOf = (price: bigint) => {
    const span = maxPrice - minPrice
    const frac = span === 0n ? 0 : Number(((price - minPrice) * 10_000n) / span) / 10_000
    return PAD.top + (1 - frac) * innerH
  }

  const curvePath = path(curve.map((p) => ({ x: xOf(p.sold), y: yOf(p.priceWei) })))
  const markerX = xOf(soldTok)
  const markerY = yOf(currentPriceWei)

  /*
   * "N ISLEM DRAWN", "N ISLEM SO FAR" DEGIL.
   *
   * Onceki hal `${realised.length} trades so far` yaziyordu. `realised`,
   * sayfaya gelen ILK SAYFADAN (25 satir) turetilir ve blok basina tek noktaya
   * indirgenir; yani dort bin islemi olan bir token icin bu cumle "25 trades
   * so far" derdi. Bir toplam gibi okunan ve toplam OLMAYAN bir sayi, bu
   * projenin tek kirmizi cizgisi. Cizilen nokta sayisi cizilen nokta sayisidir.
   */
  const summary =
    `Bonding curve price from ${formatPriceWeiPerToken(minPrice)} to ` +
    `${formatPriceWeiPerToken(maxPrice)} USDC per token across the sale supply. ` +
    `${realised.length} recent trade${realised.length === 1 ? '' : 's'} drawn on the curve; ` +
    `${progressPercent}% to graduation.`

  return (
    <figure className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        className="h-56 w-full"
        data-testid="curve-chart"
      >
        <defs>
          <linearGradient id="curve-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Referans egri HER ZAMAN cizilir -- islem olsun olmasin. */}
        <path
          d={`${curvePath} L${xOf(S)} ${VIEW_H} L${PAD.left} ${VIEW_H} Z`}
          fill="url(#curve-fill)"
          data-testid="curve-fill"
        />
        <path
          d={curvePath}
          fill="none"
          stroke="var(--color-accent)"
          strokeOpacity={realised.length > 1 ? 0.35 : 0.9}
          strokeWidth="2"
          data-testid="curve-reference"
        />

        {realised.length > 1 ? (
          <path
            d={path(
              realised.map((p) => ({
                /*
                 * X, ISLEMIN KENDI REZERVINDEN -- SIRA NUMARASINDAN DEGIL.
                 *
                 * Buradaki ifade `PAD.left + (i / (n - 1)) * (markerX -
                 * PAD.left)` idi: noktalar esit araliklarla dagitiliyordu ve
                 * ustundeki yorum "islemin kendi rezervine gore konumlariz"
                 * diyordu. Yorum kodun TERSINI soyluyordu.
                 *
                 * Sonucu bir gorsel yalandi. Bir bonding curve'de fiyat
                 * satilan miktarin FONKSIYONUDUR, yani her gerceklesen nokta
                 * referans egrinin USTUNDE olmak ZORUNDA. Esit araliklarla
                 * dagitilinca degildi: yirmi kucuk alim ve bir dev alim,
                 * egriden sapan duzgun bir rampa gibi cizilirdi -- bu curve'de
                 * GERCEKLESMESI IMKANSIZ bir sekil. Gercek eksende ayni veri
                 * egrinin uzerinde bir PARCA olur ve islemlerin nerede
                 * yogunlastigini gosterir.
                 *
                 * Satis SOLA gider ve bu da dogrudur: `realTokenReserves`
                 * artar, yani satilan miktar azalir ve cizgi egri boyunca geri
                 * doner. Sira KRONOLOJIKTIR (blok), x ise konumdur.
                 */
                x: xOf(S - p.realTokenReservesTok),
                y: yOf(p.priceWei),
              })),
            )}
            fill="none"
            stroke="var(--color-text)"
            strokeWidth="2"
            data-testid="curve-realised"
          />
        ) : null}

        <circle cx={markerX} cy={markerY} r="4.5" fill="var(--color-accent)" />
        <circle cx={markerX} cy={markerY} r="9" fill="var(--color-accent)" fillOpacity="0.2" />
      </svg>

      {/*
        BIR CIZGI GRAFIGI EKRAN OKUYUCUYA HICBIR SEY SOYLEMEZ. `aria-label`
        egriyi ozetler; tablo veriyi VERIR. Son 20 nokta, gorsel olarak gizli.
      */}
      <VisuallyHidden>
        <table>
          <caption>Realised trade prices, most recent last</caption>
          <thead>
            <tr>
              <th scope="col">Block</th>
              <th scope="col">Price (USDC per token)</th>
            </tr>
          </thead>
          <tbody>
            {realised.slice(-20).map((point) => (
              <tr key={String(point.seq)}>
                <td>{point.block}</td>
                <td>{formatPriceWeiPerToken(point.priceWei)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </VisuallyHidden>

      <figcaption className="text-[12px] text-muted">
        {realised.length === 0
          ? 'No trades yet — this is the bonding curve itself, with the current position marked.'
          : 'Bonding curve with recent realised prices. The x axis is tokens sold, not time — ' +
            'a sell moves the line back to the left.'}
      </figcaption>
    </figure>
  )
}
