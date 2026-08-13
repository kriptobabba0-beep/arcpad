import { LiveNumber } from '@/components/ui/LiveNumber'
import type { VolumeSplit } from '@/lib/read'
import { TimeframePicker, type TimeframeKey } from './ChartControls'

/**
 * ============================================================================
 *  HACIM VE YONU -- TEK BAKISTA "KIM AGIR BASIYOR"
 * ============================================================================
 *
 * Buyuk sayi toplam hacim; altindaki cubuk onu ALIS ve SATIS olarak boler;
 * cubugun altindaki iki satir her yonu acar: kac islem, kac cuzdan, ne kadar.
 *
 * CUBUK TUTARA GORE BOLUNUR, ISLEM SAYISINA GORE DEGIL. Yuz kucuk alis ile
 * bir buyuk satis, sayiya gore "alicilar kazaniyor" der; tutara gore
 * bakildiginda tam tersi olabilir ve o, bir traderin sordugu sorudur. Islem
 * sayisi da gosterilir ama cubukta degil, altindaki satirda.
 *
 * SIFIR HACIMDE CUBUK NOTR CIZILIR. `0/0` bir oran degildir; yesil ya da
 * kirmizi bir cubuk, hic islem olmamis bir token icin bir yon IMA EDERDI.
 */
export function VolumePanel({
  split,
  timeframe,
  params,
}: {
  split: VolumeSplit
  timeframe: TimeframeKey
  params: Readonly<Record<string, string | undefined>>
}) {
  const total = split.volumeWei
  /*
   * YUZDE `bigint` UZERINDE, ONDA BIRLIK OLCEKLE. `Number(a)/Number(b)` bu
   * araliklarda (1e18 tabanli tutarlar) hassasiyet kaybeder; burada bolum
   * once 1000 ile olceklenir, sonra ekrana dusen tek sayi `number` olur.
   */
  const buyPermille = total === 0n ? 0 : Number((split.buyVolumeWei * 1_000n) / total)
  const buyPercent = buyPermille / 10
  const sellPercent = total === 0n ? 0 : 100 - buyPercent

  return (
    <section data-testid="volume-panel" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">Volume</h2>
        <TimeframePicker active={timeframe} params={params} ariaLabel="Volume timeframe" />
      </div>

      <p className="text-[26px] font-medium leading-none tabular-nums" data-testid="volume-total">
        <LiveNumber value={total} format="usdc" />
      </p>

      {/*
        CUBUK BIR `<div>` CIFTI, `<progress>` DEGIL: bu bir ilerleme degil bir
        BOLUNME. `<progress>` ekran okuyucuya "su kadari tamamlandi" der ve
        burada tamamlanan bir sey yok.
      */}
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-pill bg-white/8"
        role="img"
        aria-label={
          total === 0n
            ? 'No trades in this window'
            : `${buyPercent.toFixed(1)}% buys, ${sellPercent.toFixed(1)}% sells by value`
        }
        data-testid="volume-bar"
      >
        {total === 0n ? null : (
          <>
            <span className="bg-[#4ade80]" style={{ width: `${buyPercent}%` }} />
            <span className="flex-1 bg-[#f87171]" />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <Side
          tone="buy"
          count={split.buys}
          wallets={split.buyers}
          valueWei={split.buyVolumeWei}
          percent={total === 0n ? null : buyPercent}
        />
        <Side
          tone="sell"
          count={split.sells}
          wallets={split.sellers}
          valueWei={split.sellVolumeWei}
          percent={total === 0n ? null : sellPercent}
          align="right"
        />
      </div>
    </section>
  )
}

function Side({
  tone,
  count,
  wallets,
  valueWei,
  percent,
  align = 'left',
}: {
  tone: 'buy' | 'sell'
  count: number
  wallets: number
  valueWei: bigint
  percent: number | null
  align?: 'left' | 'right'
}) {
  const colour = tone === 'buy' ? 'text-[#4ade80]' : 'text-[#f87171]'
  const word = tone === 'buy' ? 'buys' : 'sells'
  return (
    <div className={`flex flex-col gap-1 ${align === 'right' ? 'items-end text-right' : ''}`}>
      <span className={`text-[13px] font-medium tabular-nums ${colour}`}>
        <LiveNumber value={BigInt(count)} format="count" /> {word}
      </span>
      <span className="flex items-center gap-1.5 text-[12px] text-muted tabular-nums">
        {/*
          CUZDAN IKONU: "kac islem" ile "kac cuzdan" ayni satirda duruyor ve
          ikisi ayni sey degil -- tek bir cuzdan kirk islem yapmis olabilir.
          Isaret, hangi sayinin hangisi oldugunu etiketsiz belli eder.
        */}
        <span aria-hidden="true">&#128100;</span>
        <span className="sr-only">wallets:</span>
        <LiveNumber value={BigInt(wallets)} format="count" />
        <span aria-hidden="true" className="text-white/20">
          ·
        </span>
        <LiveNumber value={valueWei} format="usdc" />
        {percent === null ? null : (
          <>
            <span aria-hidden="true" className="text-white/20">
              ·
            </span>
            <LiveNumber value={BigInt(Math.round(percent * 10))} format="percent1" />
          </>
        )}
      </span>
    </div>
  )
}
