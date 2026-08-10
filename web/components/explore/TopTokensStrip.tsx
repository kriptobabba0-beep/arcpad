import { formatUsdcCompact } from '@arcpad/shared/browser'
import Link from 'next/link'
import { TokenArtwork } from '@/components/layout/TokenArtwork'
import type { TokenOverview } from '@/components/read/types'
import { relativeAge, relativeAgeLabel } from '@/components/ui/relativeAge'
import { GraduatedBadge } from './GraduatedBadge'

/**
 * TOP TOKENS -- FDV'YE GORE, YATAY KAYDIRILABILIR, EN COK 16.
 *
 * IZGARADAN FARKLI BIR KART TASIR, ve bu bir tekrar degil. Izgara TARANIR:
 * orada okunan sey isim ve bir buyukluktur. Bu serit ise KARSILASTIRILIR --
 * dort token yan yana durur ve aralarindaki fark hacim ile tutucu sayisinda
 * gorunur. Bu yuzden buradaki kart ticker, FDV, 24 saatlik hacim ve tutucu
 * sayisini birlikte tasir; izgara karti tasisaydi bes metrik olur ve hicbiri
 * okunmazdi.
 *
 * NEDEN "FDV" VE "MARKET CAP" DEGIL. Sayi ayni sayidir -- `marketCapWei`
 * fiyati TOPLAM arzla carpar (`marketCap(v, t, TOTAL_SUPPLY_TOK)`), ki bunun
 * tanimi zaten FDV'dir. "Market cap" adi dolasimdaki arzi ima eder ve bu
 * urunde dolasimdaki arz toplam arzin altindadir (satis arzi + havuz tohumu +
 * kalici artik). Yani "FDV" DAHA DOGRU ad, kisaltma degil.
 *
 * KAYDIRMA GERCEK BIR KAYDIRMADIR, JS DEGIL: `overflow-x-auto` ve
 * `snap-x`. Bir ok dugmesi klavyeyle erisilemez bir kaydirma yaratirdi;
 * tarayicinin kendi kaydirmasi tekerlek, dokunma, Shift+tekerlek ve klavye
 * ile zaten calisir.
 */

/**
 * Seritteki en fazla kart. Sorguyu yapan SAYFA oldugu icin burada durur:
 * sayfa 16 isteyip serit 12 cizseydi, dort token okunur ve atilirdi.
 */
export const TOP_TOKENS_COUNT = 16
export function TopTokensStrip({
  tokens,
  images,
  now,
}: {
  tokens: readonly TokenOverview[]
  /** token adresi -> cozulmus gorsel. Yoksa gradyana duser. */
  images?: Readonly<Record<string, string | null>>
  now?: number
}) {
  if (tokens.length === 0) return null
  const at = now ?? Date.now()

  return (
    <section aria-labelledby="top-tokens-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="top-tokens-heading" className="font-serif text-2xl leading-none">
          Top tokens
        </h2>
        <p className="text-[12px] text-muted">by FDV</p>
      </div>

      {/*
        `<ul>` + `overflow-x-auto`. Liste anlamsal olarak bir listedir ve
        ekran okuyucu "16 ogeli liste" der; kaydirma yalnizca gorsel bir
        kisitlamadir ve iceriği DEGISTIRMEZ -- gorunmeyen kartlar DOM'da
        durur ve klavyeyle Tab'lanarak gezilebilir.

        `tabIndex={0}`: kaydirilabilir bir bolgenin klavyeyle kaydirilabilmesi
        icin odaklanabilir olmasi gerekir (WCAG 2.1.1). Aksi halde fare
        olmadan saga gitmenin tek yolu kartlari tek tek Tab'lamaktir.
      */}
      <ul
        tabIndex={0}
        aria-label="Top tokens by FDV"
        className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/30"
      >
        {tokens.map((t) => (
          <li key={t.token} className="snap-start">
            <TopTokenCard overview={t} imageUrl={images?.[t.token] ?? null} now={at} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function TopTokenCard({
  overview,
  imageUrl,
  now,
}: {
  overview: TokenOverview
  imageUrl: string | null
  now: number
}) {
  const label =
    `${overview.symbol} — ${overview.name}, FDV ${overview.marketCapWei} wei, ` +
    `24 hour volume ${overview.volume24hWei} wei, ${overview.holderCount} holders, ` +
    relativeAgeLabel(overview.createdAt, now) +
    (overview.graduated ? ', graduated' : '')

  return (
    <Link
      href={`/token/${overview.token}`}
      aria-label={label}
      className="flex w-[320px] shrink-0 overflow-hidden rounded-card border border-border bg-surface transition-colors duration-150 hover:border-white/18 hover:bg-surface-2"
    >
      <div className="relative w-[104px] shrink-0">
        <TokenArtwork
          address={overview.token}
          uri={imageUrl}
          size="fill"
          symbol={overview.symbol}
          className="h-full rounded-none border-0"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1.5 top-1.5 rounded-pill bg-black/65 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white/85 backdrop-blur-sm"
        >
          {relativeAge(overview.createdAt, now)}
        </span>
        {overview.graduated ? <GraduatedBadge /> : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3 py-2.5">
        <p className="truncate text-[15px] font-semibold leading-tight">{overview.symbol}</p>
        <p className="truncate text-[12px] leading-tight text-muted">{overview.name}</p>
        <p className="text-[15px] font-medium tabular-nums leading-tight">
          {formatUsdcCompact(overview.marketCapWei)}
        </p>

        {/*
          IKI METRIK, IKISI DE ETIKETLI. Referans arayuz burada iki ikon
          kullaniyor ve etiketsiz birakiyor; `$425.9K` ile `5,466` yan yana
          durdugunda hangisinin hacim hangisinin tutucu oldugu ikondan
          anlasilmali. Ikon bir dil degildir -- iki harflik etiket ayni yeri
          kaplar ve tahmin gerektirmez.
        */}
        <dl className="flex items-baseline gap-3 text-[11px] text-muted">
          <div className="flex min-w-0 items-baseline gap-1">
            <dt>Vol</dt>
            <dd className="truncate tabular-nums text-text">
              {formatUsdcCompact(overview.volume24hWei)}
            </dd>
          </div>
          <div className="flex min-w-0 items-baseline gap-1">
            <dt>Holders</dt>
            <dd className="truncate tabular-nums text-text">
              {overview.holderCount.toLocaleString('en-US')}
            </dd>
          </div>
        </dl>
      </div>
    </Link>
  )
}
