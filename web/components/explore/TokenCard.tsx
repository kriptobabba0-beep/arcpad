import Link from 'next/link'
import { TokenArtwork } from '@/components/layout/TokenArtwork'
import type { TokenOverview } from '@/components/read/types'
import { cx } from '@/components/ui/cx'
import { LiveNumber } from '@/components/ui/LiveNumber'
import { Pill } from '@/components/ui/Pill'
import { relativeAge, relativeAgeLabel } from '@/components/ui/relativeAge'
import { BuybackBadge } from './BuybackBadge'
import { GraduatedBadge } from './GraduatedBadge'

/**
 * `progressPpm` MILYONDA PAYDIR. Yuzdeye cevirmek 10.000'e bolmektir.
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
 * `holderCount`, `volume24hWei` ve `isDev` BILEREK YOK. Kart yogunlugu
 * bir kaynaktir: bes metrik, hicbirinin okunmamasi demektir. Kullanici bir
 * izgarayi tararken satin alma karari icin bu ucune bakar, otekiler token
 * sayfasinda durur.
 *
 * VE YAS UZUN SURE EKSIKTI. Yukaridaki cumle "uc metrik" diyordu, JSX ikisini
 * ciziyordu: `createdAt` hic okunmuyordu. Bir launchpad'de yas ikincil bir
 * suslemedir sanilir, degildir -- izgara agirlikla YENI olani aramak icin
 * taranir ve "3h" ile "11d" arasindaki fark, kartin tasidigi en ayirt edici
 * tek isaret olabilir. Referans arayuzler (pools.trade, ponsfamily.com) yasi
 * gorselin uzerinde bir rozet olarak veriyor; burada da oyle, cunku metin
 * blogunda dorduncu bir satir olsaydi otekilerin okunurlugunu duserdi.
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
  now,
}: {
  overview: TokenOverview
  /** Task 7'nin `resolveMetadata`'sindan cozulmus gorsel. Yoksa gradyana duser. */
  imageUrl?: string | null
  /** Yasin referans ani. Testler sabitler; uretimde `Date.now()`. */
  now?: number
}) {
  const percent = progressPercent(overview.progressPpm)
  const at = now ?? Date.now()
  const age = relativeAge(overview.createdAt, at)

  /*
   * KARTIN TAMAMI TEK BIR <a>, ve icinde IKINCI bir etkilesimli oge yok.
   * Ic ice tiklanabilir oge klavye ve ekran okuyucu icin kiriktir: Tab iki
   * durak yapar, ekran okuyucu ikisini ayri ayri duyurur ve kullanici hangi
   * hedefe gittigini bilemez.
   *
   * Erisilebilir ad TEK bir dizedir ve gorseli ICERMEZ (`alt=""`): gorsel
   * dekoratiftir, ad zaten isim + sembol + iki metrigi tasir.
   */
  /*
   * ERISILEBILIR AD, EKRANDAKI HER OLGUYU TASIR VE HICBIRINI KISALTMAZ.
   * `$58.78` gorsel bir ozettir; burada tam deger yazilir, cunku ekran
   * okuyucuyla gezen biri "58,78" ile "58,783256" arasindaki farki baska
   * hicbir yerden ogrenemez. Yas da acik yazilir: `3h` seslendirildiginde
   * "uc hache" olur.
   */
  const label =
    `${overview.name} (${overview.symbol}), ` +
    `FDV ${overview.marketCapWei} wei, ${percent}% to graduation, ` +
    relativeAgeLabel(overview.createdAt, at) +
    (overview.graduated ? ', graduated' : '') +
    // ROZET `aria-hidden`, yani ekran okuyucuya ULASAN TEK yol bu satir.
    // `GraduatedBadge` ile ayni kalip: gorsel bir isaret, erisilebilir adda
    // KELIMEYLE tekrarlanir -- yoksa iki kullanici ayni karti farkli okur.
    (overview.buybackEnabled ? ', creator buyback' : '')

  return (
    <Link
      href={`/token/${overview.token}`}
      aria-label={label}
      /*
        HOVER'DA HAFIF BIR YUKSELME.
        Yalnizca renk degistiren bir kart, farenin altinda oldugunu ZAR ZOR
        soyler -- ozellikle 48 kartlik bir izgarada, hepsi ayni renkteyken.
        `-translate-y-1` + buyuyen bir golge, karti duzlemden AYIRIR ve
        "bunun uzerindesin" bilgisini renge degil DERINLIGE yazar.

        `motion-reduce:` dali zorunlu: hareketi azaltilmis bir sistemde
        yukselme ve olcek KAPANIR, renk ve kenarlik kalir (WCAG 2.3.3).
        `will-change` YOK -- 48 kart icin 48 kompozit katman, kazandirdigi
        birkac milisaniyeden pahaliya mal olur.
      */
      className={cx(
        'group flex flex-col overflow-hidden rounded-card border border-border bg-surface',
        'transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out',
        'hover:-translate-y-1 hover:border-white/25 hover:bg-surface-2 hover:shadow-xl hover:shadow-black/50',
        'focus-visible:-translate-y-1 focus-visible:shadow-xl focus-visible:shadow-black/50',
        'motion-reduce:transform-none motion-reduce:hover:translate-y-0',
      )}
    >
      {/*
        YAS ROZETI GORSELIN USTUNDE DURUR, metin blogunda degil.
        `pointer-events-none`: kartin tamami tek bir <a> ve rozet onun
        uzerinde yuzen bir etikettir; tiklamayi yakalarsa kullanici kartin
        bir yerine basip hicbir sey olmadigini gorur.
      */}
      <div className="relative">
        <TokenArtwork
          address={overview.token}
          uri={imageUrl ?? null}
          size="fill"
          symbol={overview.symbol}
          className="rounded-none border-0 border-b border-border transition-transform duration-300 ease-out group-hover:scale-[1.04] motion-reduce:transform-none"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-2 rounded-pill bg-black/70 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-white/90 backdrop-blur-sm"
        >
          {age}
        </span>
        {overview.graduated ? <GraduatedBadge /> : null}
        {overview.buybackEnabled ? <BuybackBadge /> : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3.5">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-[15px] font-semibold">{overview.name}</span>
          <span className="shrink-0 text-[13px] font-medium text-muted">${overview.symbol}</span>
        </div>

        {/*
          MARKET CAP BIR PARA BIRIMI ISARETI TASIR VE SIKISTIRILIR.
          Onceki hal `58.783256` yaziyordu: birimi yok (dolar mi, token mi?)
          ve alti ondalik, bir izgarada okunacak sayi degil. `formatUsdcCompact`
          `$58.78`, `$39.2K`, `$7.2M` uretir -- ayni fonksiyon analitik
          sayfasindaki toplamlari da yaziyor, yani iki yer ayni sayiyi ayni
          bicimde gosterir.
        */}
        {/*
          ETIKET SOLUK DEGIL. `text-muted` bir yardimci metin rengidir ve bu
          satirdaki iki parca da yardimci degil: `FDV` sayinin NE OLDUGUNU
          soyler, sayi ise kartin en cok bakilan degeridir. Etiket artik
          `text-text/70` ve `font-medium`; sayi bir punto buyuk ve `semibold`.
        */}
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-medium uppercase tracking-wide text-text/70">FDV</span>
          <span className="text-[16px] font-semibold">
            <LiveNumber value={overview.marketCapWei} format="usdc" />
          </span>
        </div>

        {overview.complete ? (
          <Pill tone="accent">Curve complete</Pill>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-muted">
              <span className="font-semibold tabular-nums text-text">{percent}%</span> to graduation
            </span>
            {/*
              Ilerleme cizgisi `aria-hidden`: ayni sayi bir ustteki metinde
              zaten okunuyor ve bir `progressbar` rolu onu ikinci kez
              duyururdu. Cizgi burada gorsel bir ozet, bagimsiz bir bilgi
              degil.
            */}
            <span
              aria-hidden="true"
              className="block h-1.5 overflow-hidden rounded-pill bg-white/10"
            >
              <span
                className="block h-full rounded-pill bg-accent"
                style={{ width: `${Math.min(100, overview.progressPpm / 10_000)}%` }}
              />
            </span>
          </div>
        )}
      </div>
    </Link>
  )
}
