'use client'

import { useEffect, useRef } from 'react'
import { TokenArtwork } from '@/components/layout/TokenArtwork'
import type { TokenOverview } from '@/components/read/types'
import { Address } from '@/components/ui/Address'
import { cx } from '@/components/ui/cx'
import { Money } from '@/components/ui/Money'
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
        {row.complete ? (
          <Pill tone="accent">Graduated</Pill>
        ) : (
          <Pill tone="neutral">{`${progressPct}%`}</Pill>
        )}
        <span className="w-24 text-right text-sm">
          {marketCap === null ? (
            <span className="text-muted">—</span>
          ) : (
            /* Piyasa degeri ELE GECEN degil GOSTERILEN bir tutar; asagi
               yuvarlanir ki var olmayan bir buyukluk gosterilmesin. */
            <Money native={marketCap} rounding="down" />
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
