import Link from 'next/link'
import { TokenArtwork } from '@/components/layout/TokenArtwork'
import type { TokenOverview } from '@/components/read/types'
import { Money } from '@/components/ui/Money'
import { Pill } from '@/components/ui/Pill'

/**
 * `progress_ppm` MILYONDA PAYDIR. Yuzdeye cevirmek 10.000'e bolmektir.
 *
 * Bir ondalik tutuluyor (`25.3%`) cunku graduation'a giden yol bu urunun tek
 * ilerleme cubugudur ve tam sayiya yuvarlamak son %1'i tek bir sicramaya
 * cevirir -- tam da kullanicinin en cok baktigi yerde.
 */
export function progressPercent(ppm: number): string {
  return (Math.round(ppm / 1_000) / 10).toFixed(1)
}

/**
 * KART UC METRIK TASIR: market cap, graduation ilerlemesi, yas.
 *
 * `holder_count`, `volume_24h_wei` ve `is_dev` BILEREK YOK. Kart yogunlugu
 * bir kaynaktir: bes metrik, hicbirinin okunmamasi demektir. Kullanici bir
 * izgarayi tararken satin alma karari icin bu ucune bakar, otekiler token
 * sayfasinda durur.
 *
 * DEVIASYON 3: referans arayuz kartta CIPLAK bir yuzde gosteriyor. arcpad'de
 * graduation TANIMLI bir bitis cizgisidir (testnet'te 12,161433 USDC toplanir),
 * bu yuzden yuzdenin yaninda neyin yuzdesi oldugu yazar. Ciplak bir yuzde,
 * neyin yuzdesi oldugunu saklar -- ve bu urunde iki farkli yuzde var
 * (ilerleme ve arz payi), yani saklamak gercekten yaniltir.
 */
export function TokenCard({
  overview,
  imageUrl,
}: {
  overview: TokenOverview
  /** Task 7'nin `resolveMetadata`'sindan cozulmus gorsel. Yoksa gradyana duser. */
  imageUrl?: string | null
}) {
  const percent = progressPercent(overview.progress_ppm)

  /*
   * KARTIN TAMAMI TEK BIR <a>, ve icinde IKINCI bir etkilesimli oge yok.
   * Ic ice tiklanabilir oge klavye ve ekran okuyucu icin kiriktir: Tab iki
   * durak yapar, ekran okuyucu ikisini ayri ayri duyurur ve kullanici hangi
   * hedefe gittigini bilemez.
   *
   * Erisilebilir ad TEK bir dizedir ve gorseli ICERMEZ (`alt=""`): gorsel
   * dekoratiftir, ad zaten isim + sembol + iki metrigi tasir.
   */
  const label =
    `${overview.name} (${overview.symbol}), ` +
    `market cap ${overview.market_cap_wei} wei, ${percent}% to graduation`

  return (
    <Link
      href={`/token/${overview.token}`}
      aria-label={label}
      className="group flex flex-col overflow-hidden rounded-card border border-border bg-surface transition-colors duration-150 hover:border-white/18 hover:bg-surface-2"
    >
      <TokenArtwork
        address={overview.token}
        uri={imageUrl ?? null}
        size="fill"
        symbol={overview.symbol}
        className="rounded-none border-0 border-b border-border"
      />

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-medium">{overview.name}</span>
          <span className="shrink-0 text-[13px] text-muted">${overview.symbol}</span>
        </div>

        <div className="flex items-baseline justify-between gap-2 text-[13px]">
          <span className="text-muted">MC</span>
          <Money native={BigInt(overview.market_cap_wei)} rounding="down" />
        </div>

        {overview.complete ? (
          <Pill tone="accent">Curve complete</Pill>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">
              <span className="tabular-nums text-text">{percent}%</span> to graduation
            </span>
            {/*
              Ilerleme cizgisi `aria-hidden`: ayni sayi bir ustteki metinde
              zaten okunuyor ve bir `progressbar` rolu onu ikinci kez
              duyururdu. Cizgi burada gorsel bir ozet, bagimsiz bir bilgi
              degil.
            */}
            <span aria-hidden="true" className="block h-1 overflow-hidden rounded-pill bg-white/8">
              <span
                className="block h-full rounded-pill bg-accent"
                style={{ width: `${Math.min(100, overview.progress_ppm / 10_000)}%` }}
              />
            </span>
          </div>
        )}
      </div>
    </Link>
  )
}
