'use client'

import { formatUsdcCompact } from '@arcpad/shared/browser'
import { useEffect, useRef } from 'react'
import { TokenArtwork } from '@/components/layout/TokenArtwork'
import type { TokenOverview } from '@/components/read/types'
import { Address } from '@/components/ui/Address'
import { cx } from '@/components/ui/cx'
import { Pill } from '@/components/ui/Pill'

/**
 * BIR SONUC SATIRI, ve bir baglanti DEGIL.
 *
 * `role="option"` bir listbox'in ogesidir: odak GIRDIDE kalir, secim
 * `aria-activedescendant` ile tasinir. Satirlari `<a href>` yapmak bunu
 * bozar -- her satir odak sirasina girer, Tab modal icinde yirmi durak
 * uretir ve `aria-activedescendant` ile gercek odak birbirinden ayrilir.
 * Bedeli orta tikla yeni sekmede acmanin kaybi; karsiligi calisan bir
 * klavye deseni.
 */

const ROW_BASE = [
  'flex cursor-pointer items-center gap-3 rounded-input px-2.5 py-2',
  'transition-colors duration-150',
].join(' ')

/** Secili satir zeminle isaretlenir; `aria-selected` ayni seyi soyler. */
const ROW_SELECTED = 'bg-surface-2'

export type OptionRowProps = {
  /** `aria-activedescendant`in isaret ettigi id. Listede TEKILDIR. */
  id: string
  selected: boolean
  onSelect: () => void
  onHover: () => void
}

/**
 * Secim klavyeyle tasindiginda satir gorunur alanda tutulur.
 *
 * `?.` var cunku `scrollIntoView` her ortamda tanimli degil (jsdom onu
 * uygulamiyor) ve bir gorunum ayrintisi yuzunden butun modalin cokmesi
 * kabul edilemez.
 */
function useScrollIntoView(selected: boolean) {
  const ref = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  return ref
}

/**
 * `numeric(78,0)` kolonlari TypeScript'te dizedir ve bu dize BIR TAM SAYI
 * OLMAYABILIR: gelecekteki bir view degisikligi ya da bir NULL, `BigInt()`
 * icinde SyntaxError firlatir ve o istisna arama modalinin TAMAMINI goturur.
 * Cozulemeyen tek bir hucreyi bosaltmak, yirmi satiri birden kaybetmekten
 * ucuzdur.
 */

export function SearchResultRow({
  row,
  id,
  selected,
  onSelect,
  onHover,
}: OptionRowProps & { row: TokenOverview }) {
  const ref = useScrollIntoView(selected)
  const marketCap = row.marketCapWei
  const progressPct = Math.min(100, Math.round(row.progressPpm / 10_000))

  return (
    <li
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      /*
       * `mousemove`, `mouseenter` DEGIL. Ok tuslariyla secim tasinirken liste
       * kayar ve durgun bir imlecin altindan yeni bir satir gecerse
       * `mouseenter` atesler: secim klavyeden farenin altina ziplar. Gercek
       * bir imlec HAREKETI istemek bunu keser.
       */
      onMouseMove={onHover}
      className={cx(ROW_BASE, selected && ROW_SELECTED)}
    >
      {/*
        `uri={null}` BILINCLI, VE BU YORUM ONU BIR KAZA OLMAKTAN CIKARIYOR.

        Bir sonraki okuyan `row.uri`yi gecirmek isteyecek. GECIRMEMELI: o alan
        metadata JSON'unun adresidir, GORSELIN degil (`TokenArtwork`in kendi
        uyarisi). Bir `<img>`e verilmesi JSON'u resim diye cizmeye calismaktir.

        Gercek gorsel `resolveArtworkMap` ile gelir -- explore sayfasinin
        yaptigi budur. Burada KOSULMUYOR cunku bu uc her TUS VURUSUNDA yeniden
        sorgulanir ve satir basina bir gateway cagrisi eklemek, aramayi
        acilir listenin en yavas parcasi yapardi.

        Yani yedek gradyan bir eksiklik degil bir TAKAS. Kapatilmak istenirse
        dogru yol `app/api/search/route.ts`te toplu cozum + kablo bicimine bir
        `image` alani; tek satirlik bir degisiklik DEGIL.
      */}
      <TokenArtwork address={row.token} uri={null} size={36} symbol={row.symbol} />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          {/* `truncate`: ad zincirden gelir ve uzunlugu bize ait degil. */}
          <span className="truncate text-sm font-medium text-text">{row.name}</span>
          <span className="shrink-0 text-[12px] uppercase tracking-[0.06em] text-muted">
            {row.symbol}
          </span>
        </span>
        <span className="flex items-center gap-2 text-[12px] text-muted">
          <Address value={row.token} label="Token address" />
          <span aria-hidden="true">·</span>
          <span>{`${row.holderCount.toLocaleString('en-US')} holders`}</span>
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-3">
        {/*
          `complete` ILE `graduated` AYNI SEY DEGILDIR, ve burasi ikisini
          birlestiriyordu: `row.complete` icin "Graduated" yaziyordu.

          `complete`  -> satis arzi bitti, curve kapandi, HAVUZ HENUZ YOK.
          `graduated` -> odeme yapildi, havuz acildi, islem orada.

          Aradaki fark gercek bir zaman araligidir ve bugun uretimdeki curve
          tam olarak `complete && !graduated`: `graduationTarget` sifir oldugu
          icin hicbir sey mezun OLAMIYOR. Yani bu etiket, mezun olmamis bir
          curve icin "Graduated" diyordu -- kullaniciya var olmayan bir havuz
          vaat eden bir kelime.
        */}
        {row.graduated ? (
          <Pill tone="accent">Graduated</Pill>
        ) : row.complete ? (
          <Pill tone="neutral">Complete</Pill>
        ) : (
          <Pill tone="neutral">{`${progressPct}%`}</Pill>
        )}
        <span className="w-20 text-right text-sm tabular-nums">
          {marketCap === null ? (
            <span className="text-muted">—</span>
          ) : (
            /* SIKISTIRILMIS: bu satir bir listede taranir, tam ondalik degil
               buyukluk okunur. Ayni fonksiyon kartlarda ve analitikte de
               kullaniliyor, yani uc yer ayni sayiyi ayni bicimde gosterir. */
            <span>{formatUsdcCompact(marketCap)}</span>
          )}
        </span>
      </span>
    </li>
  )
}

/**
 * KANONIK AMA HENUZ INDEKSLENMEMIS ADRES.
 *
 * Zincir "bu adres `LaunchFactory`'nin kendi verisinden turetiliyor" dedi ama
 * indexer satiri henuz yazmadi. Isim, sembol ve piyasa degeri BURADA YOK ve
 * uydurulmaz: token sayfasi onlari zincirden cizecek. Satirin tasidigi tek
 * gercek adresin kendisi, ve etiket bunu acikca soyluyor.
 */
export function UnindexedResultRow({
  address,
  id,
  selected,
  onSelect,
  onHover,
}: OptionRowProps & { address: string }) {
  const ref = useScrollIntoView(selected)

  return (
    <li
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onMouseMove={onHover}
      className={cx(ROW_BASE, selected && ROW_SELECTED)}
    >
      <TokenArtwork address={address} uri={null} size={36} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-text">
          <Address value={address} label="Token address" />
        </span>
        <span className="text-[12px] text-muted">Verified on chain</span>
      </span>
      <Pill tone="warn">Not indexed yet</Pill>
    </li>
  )
}
