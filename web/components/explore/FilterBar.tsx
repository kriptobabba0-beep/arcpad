import Link from 'next/link'
import { cx } from '@/components/ui/cx'
import { AGE_LABELS, exploreHref, SORT_LABELS, type ExploreQuery } from './params'

/**
 * FILTRE SERIDI `<Link>`'LERDEN OLUSUR, BUTONLARDAN DEGIL.
 *
 * Uc sonucu var ve ucu de bedava: JS gelmeden once calisir, her filtre
 * PAYLASILABILIR bir adrese sahiptir, ve tarayicinin geri dugmesi bir onceki
 * filtreye doner. `onClick`'li bir buton uculunu de kaybettirir ve karsiliginda
 * hicbir sey vermez -- sayfa zaten bir server component.
 *
 * Secili olan `aria-current="page"` tasir: rengin tek basina "secili" demesi
 * yeterli degildir.
 */
function FilterGroup({
  label,
  items,
}: {
  label: string
  items: ReadonlyArray<{ href: string; label: string; active: boolean }>
}) {
  return (
    /*
      `max-w-full overflow-x-auto` -- OLCULEREK EKLENDI, TASARIM TERCIHI DEGIL.
      375px'te bes siralama pili bir satira sigmiyor ve `flex` (wrap YOK)
      oldugu icin serit disari tasiyordu: SAYFANIN kendisi 382px genislige
      cikiyor ve butun ekran yana kayiyordu (`e2e/audit/responsive.spec.ts`,
      "explore overflows by 7px at 375px").
      Pilleri `flex-wrap` ile alt satira dokmek seridi iki sirali bir bloga
      cevirir; genis icerigin KENDI kutusunda kaymasi kural (bkz. shell) ve
      burada da dogru olan o. `shrink-0` her pilin kendi genisliginde kalmasini
      saglar -- yoksa flex onlari sikistirip kaydirma ihtiyacini "cozer" ve
      etiketler okunmaz hale gelir.
    */
    <nav
      aria-label={label}
      className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto rounded-pill bg-surface-2 p-1"
    >
      {items.map((item) => (
        <Link
          key={item.label}
          href={item.href}
          {...(item.active ? { 'aria-current': 'page' as const } : {})}
          className={cx(
            'shrink-0 rounded-pill px-3 py-1.5 text-[13px] font-medium transition-colors duration-150',
            item.active ? 'bg-surface text-text' : 'text-muted hover:text-text',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}

export function FilterBar({ query }: { query: ExploreQuery }) {
  const currentAge = query.ageDays === null ? 'all' : String(query.ageDays)

  return (
    /*
      `min-w-0 max-w-full` -- THE OTHER HALF OF THE 375px OVERFLOW FIX.

      `overflow-x-auto` on the pill strip alone was NOT enough and the measured
      reason is flexbox's default `min-width: auto`: a flex item refuses to
      shrink below its content, so this wrapper stayed 382px wide inside a
      375px page and the strip's `max-w-full` resolved against the wrong,
      already-too-wide box. The audit spec named all three elements
      (`e2e/audit/responsive.spec.ts` prints what crosses the right edge), which
      is how a 7px difference became a two-word fix instead of a bisect.
    */
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <FilterGroup
        label="Sort launches"
        items={SORT_LABELS.map((item) => ({
          href: exploreHref(query, { sort: item.key }),
          label: item.label,
          active: query.sort === item.key,
        }))}
      />
      <FilterGroup
        label="Filter by age"
        items={AGE_LABELS.map((item) => ({
          href: exploreHref(query, { age: item.value }),
          label: item.label,
          active: currentAge === item.value,
        }))}
      />
    </div>
  )
}
