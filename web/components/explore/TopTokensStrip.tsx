'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { TokenArtwork } from '@/components/layout/TokenArtwork'
import type { TokenOverview } from '@/components/read/types'
import { cx } from '@/components/ui/cx'
import { InfoTip } from '@/components/ui/InfoTip'
import { LiveNumber } from '@/components/ui/LiveNumber'
import { relativeAge, relativeAgeLabel } from '@/components/ui/relativeAge'
import { GraduatedBadge } from './GraduatedBadge'

/**
 * TOP TOKENS -- FDV'YE GORE, OK DUGMELERIYLE KAYDIRILIR, EN COK 16.
 *
 * IZGARADAN FARKLI BIR KART TASIR, ve bu bir tekrar degil. Izgara TARANIR:
 * orada okunan sey isim ve bir buyukluktur. Bu serit ise KARSILASTIRILIR --
 * kartlar yan yana durur ve aralarindaki fark hacim ile tutucu sayisinda
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
 * ============ KAYDIRMA OK DUGMELERIYLE, TEKERLEKLE DEGIL ============
 *
 * `overflow-x: hidden` ile tekerlek/trackpad bu bolgede yatay kaydirma YAPMAZ,
 * ve sebebi olculebilir: yatay kaydiran bir serit, dikey kaydirmaya calisan
 * kullanicinin tekerlegini yakalar -- ozellikle trackpad'de -- ve sayfa asagi
 * inmek yerine serit saga kayar. Kullanicinin okumak istedigi sey sayfaydi.
 *
 * Ok dugmeleri gercek `<button>`lardir: klavyeyle odaklanilir, ekran okuyucuya
 * duyurulur, ve UCLARDA DEVRE DISI olur -- bir sey yapmayan etkin bir dugme,
 * arayuzun bozuk oldugunu dusundurur. Uclar OLCULUR (`scrollWidth`), kart
 * sayisindan TAHMIN EDILMEZ: kart genisligi ekrana, yazi tipine ve zoom
 * seviyesine baglidir.
 *
 * Gorunmeyen kartlar DOM'da durur ve Tab ile gezilebilir; tarayici odaklanan
 * karti kendiliginden goruse getirir.
 */

/** Bir ok basisinin kaydirdigi mesafe: bir kart + bosluk. */
const CARD_STEP = 372

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
  const railRef = useRef<HTMLUListElement | null>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)

  const measure = useCallback(() => {
    const el = railRef.current
    if (el === null) return
    // 1px pay: tarayicilar kesirli piksel yuvarlar ve onsuz sag ok, serit
    // sonuna varmisken bile etkin kalabilir.
    setAtStart(el.scrollLeft <= 1)
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    measure()
    const el = railRef.current
    if (el === null) return
    // Pencere yeniden boyutlandiginda uclar degisir: dar bir ekranda
    // kaydirilabilen bir serit, genisleyince tek ekrana sigabilir.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure, tokens.length])

  const scrollRail = (direction: -1 | 1): void => {
    railRef.current?.scrollBy({ left: direction * CARD_STEP, behavior: 'smooth' })
  }

  if (tokens.length === 0) return null
  const at = now ?? Date.now()

  return (
    <section aria-labelledby="top-tokens-heading" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 id="top-tokens-heading" className="font-serif text-[28px] leading-none">
            Top tokens
          </h2>
          {/*
            "by FDV" ONCEDEN SERIDIN SAG UCUNDAYDI ve pratikte okunmuyordu:
            baslikla arasinda bin piksel vardi, yani baslikla iliskisi
            gorunmuyordu. Bilgi balonu onu basligin YANINA getirir ve
            yalnizca soran kisiye gosterir.
          */}
          <InfoTip label="How Top tokens is ordered">
            The sixteen largest launches by FDV — the price on the curve times the whole
            1,000,000,000 supply. Volume is the last 24 hours.
          </InfoTip>
        </div>

        <div className="flex items-center gap-2">
          <ArrowButton direction="left" disabled={atStart} onClick={() => scrollRail(-1)} />
          <ArrowButton direction="right" disabled={atEnd} onClick={() => scrollRail(1)} />
        </div>
      </div>

      <ul
        ref={railRef}
        onScroll={measure}
        aria-label="Top tokens by FDV"
        className="-mx-1 flex gap-4 overflow-x-hidden px-1 pb-1"
      >
        {tokens.map((t) => (
          <li key={t.token}>
            <TopTokenCard overview={t} imageUrl={images?.[t.token] ?? null} now={at} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function ArrowButton({
  direction,
  disabled,
  onClick,
}: {
  direction: 'left' | 'right'
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === 'left' ? 'Scroll left' : 'Scroll right'}
      className={cx(
        'inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface-2',
        'text-muted transition-colors duration-150',
        'hover:border-white/25 hover:text-text',
        'disabled:pointer-events-none disabled:opacity-30',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40',
      )}
    >
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d={direction === 'left' ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
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
    `$${overview.symbol} — ${overview.name}, FDV ${overview.marketCapWei} wei, ` +
    `24 hour volume ${overview.volume24hWei} wei, ${overview.holderCount} holders, ` +
    relativeAgeLabel(overview.createdAt, now) +
    (overview.graduated ? ', graduated' : '')

  return (
    <Link
      href={`/token/${overview.token}`}
      aria-label={label}
      className="flex w-[356px] shrink-0 overflow-hidden rounded-card border border-border bg-surface transition-colors duration-150 hover:border-white/18 hover:bg-surface-2"
    >
      <div className="relative w-[124px] shrink-0">
        <TokenArtwork
          address={overview.token}
          uri={imageUrl}
          size="fill"
          symbol={overview.symbol}
          className="h-full rounded-none border-0"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-2 rounded-pill bg-black/70 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-white/90 backdrop-blur-sm"
        >
          {relativeAge(overview.createdAt, now)}
        </span>
        {overview.graduated ? <GraduatedBadge /> : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-4 py-3">
        {/* TICKER `$` ILE. Bir sembolu bir addan ayiran isaret budur. */}
        <p className="truncate text-[18px] font-semibold leading-tight">${overview.symbol}</p>
        <p className="truncate text-[13px] leading-tight text-muted">{overview.name}</p>

        <p className="flex items-baseline gap-1.5 text-[18px] font-semibold leading-tight">
          <LiveNumber value={overview.marketCapWei} format="usdc" />
          <span className="text-[12px] font-medium uppercase tracking-wide text-muted">FDV</span>
        </p>

        {/*
          IKI METRIK, IKISI DE ETIKETLI VE ETIKETLER ACIK.
          Referans arayuz burada iki ikon kullaniyor ve etiketsiz birakiyor;
          `$425.9K` ile `5,466` yan yana durdugunda hangisinin hacim
          hangisinin tutucu oldugu bir ikondan anlasilmali. Ikon bir dil
          degildir. "Vol" da yeterli degildi: HANGI hacim? "24h Vol" soyler.
        */}
        <dl className="flex items-baseline gap-4 text-[13px]">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <dt className="text-muted">24h Vol</dt>
            <dd className="truncate font-medium text-text">
              <LiveNumber value={overview.volume24hWei} format="usdc" />
            </dd>
          </div>
          <div className="flex min-w-0 items-baseline gap-1.5">
            <dt className="text-muted">Holders</dt>
            <dd className="truncate font-medium text-text">
              <LiveNumber value={BigInt(overview.holderCount)} format="count" />
            </dd>
          </div>
        </dl>
      </div>
    </Link>
  )
}
